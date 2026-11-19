import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { cleanInput, runBatch } from './batch.js';
import { loadConfig } from './config.js';
import { PLATFORMS } from './contacts.js';
import type { MatchResult } from './creator-match.js';
import { Matcher } from './match.js';
import { liveTransport, ModashClient } from './modash/client.js';
import { MOCK_HANDLES, mockTransport } from './modash/mock.js';
import { modashReads } from './modash/reads.js';
import { round2 } from './numbers.js';

export interface RunOptions {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  print?: (line: string) => void;
}

const USAGE = `Usage:
  npm run dev                                   mock mode: two invented creators, no token, no credits
  npm run match -- instagram example_baker      one creator (a handle or a profile URL)
  npm run match -- --csv handles.csv            a list, with the columns platform and handle
Options:
  --mock              answer from the invented fixtures even with a token set
  --max-credits <n>   stop before this run could spend more than n credits (default MODASH_CREDIT_BUDGET, 50)`;

export class UsageError extends Error {}

export async function run({ argv, env = process.env, cwd = process.cwd(), print = console.log }: RunOptions): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        csv: { type: 'string' },
        mock: { type: 'boolean', default: false },
        'max-credits': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    print(USAGE);
    return 0;
  }

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const mock = values.mock || config.mock;
  const ownInput = values.csv !== undefined || positionals.length > 0;
  if (mock && !values.mock && ownInput) {
    throw new UsageError(
      config.mockByDefault
        ? 'Set MODASH_API_TOKEN (in .env or your shell) to run on your own creators. Without a token, run npm run dev.'
        : `MODASH_MOCK is true, so only the invented creators (${MOCK_HANDLES.join(', ')}) can run. Unset it to run live.`,
    );
  }
  if (config.mockByDefault && !values.mock) {
    print('No MODASH_API_TOKEN set, so this runs in mock mode on invented creators. Nothing is spent.\n');
  }

  const budget = values['max-credits'] === undefined ? config.creditBudget : Number(values['max-credits']);
  if (!(budget > 0)) throw new UsageError('--max-credits must be a number above 0');

  let todo: [string, string][];
  if (values.csv !== undefined) {
    todo = readCsv(values.csv);
  } else if (positionals.length === 2) {
    todo = [[positionals[0]!, positionals[1]!]];
    try {
      cleanInput(...todo[0]!);
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  } else if (positionals.length === 0 && mock) {
    todo = MOCK_HANDLES.map((h) => ['instagram', h]);
  } else {
    throw new UsageError(USAGE);
  }

  const outDir = join(cwd, 'output');
  const resultsFile = join(outDir, mock ? 'mock-results.jsonl' : 'results.jsonl');
  const shown = relative(cwd, resultsFile);
  const client = mock
    ? new ModashClient(mockTransport(), { pauseMs: 0 })
    : new ModashClient(liveTransport(config.apiToken!), { budget });
  const matcher = new Matcher(modashReads(client, mock ? undefined : join(outDir, 'reports')));

  const { ran, stoppedAt } = await runBatch({
    rows: todo,
    matcher,
    resultsPath: resultsFile,
    kind: mock ? 'mock' : values.csv !== undefined ? 'csv' : 'single',
    onResult: (result) => print(`${summary(result, mock)}\n`),
    onSkip: (rowNumber, reason) => print(`row ${rowNumber} skipped: ${reason}`),
  });
  if (stoppedAt) {
    print(`Stopped at @${stoppedAt.handle}: ${stoppedAt.error.message}`);
    print(`Credits this run: ${round2(client.spent)}`);
    print(`Finished creators are in ${shown}. Run the same command again to carry on.`);
    return 1;
  }

  const total = round2(client.spent);
  if (ran === 0) print('Nothing new to run.');
  else if (mock) print(`Results in ${shown}. This was mock mode, so nothing was spent; a live run of the same creators costs ${total} credits.`);
  else print(`Results in ${shown}. Credits this run: ${total}`);
  return 0;
}

export function summary(result: MatchResult, mock = false): string {
  const lines = [`${result.input.platform} @${result.input.handle}  (${result.credits} credits${mock ? ' on a live run' : ''})`];
  for (const p of PLATFORMS) {
    const a = result.accounts[p];
    if (!a) {
      lines.push(`  ${p.padEnd(10)} not found`);
      continue;
    }
    const name = `@${a.username ?? a.userId}`.padEnd(29);
    lines.push(`  ${p.padEnd(10)} ${name} ${String(a.followers ?? '').padStart(10)}  ${a.how}${a.email_agrees ? '  + email agrees' : ''}`);
  }
  for (const c of result.candidates) {
    lines.push(`  candidate  ${c.platform} @${c.username ?? c.userId} ${c.followers ?? ''}  ${c.how}`);
  }
  for (const e of result.errors) lines.push(`  error: ${e}`);
  return lines.join('\n');
}

export function readCsv(path: string): [string, string][] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  } catch (error) {
    throw new UsageError(`could not read ${path}: ${(error as Error).message}`);
  }
  let parsed: string[][];
  try {
    parsed = parseCsv(text);
  } catch (error) {
    throw new UsageError(`${path}: ${(error as Error).message}`);
  }
  const [header, ...rows] = parsed;
  const columns = (header ?? []).map((c) => c.trim().toLowerCase());
  const pi = columns.indexOf('platform');
  const hi = columns.indexOf('handle');
  if (pi < 0 || hi < 0) throw new UsageError(`${path} needs the columns platform and handle`);
  const out = rows.filter((r) => r.some((c) => c.trim() !== '')).map((r): [string, string] => [r[pi] ?? '', r[hi] ?? '']);
  if (out.length === 0) throw new UsageError(`${path} has no rows`);
  return out;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('a quoted field never closes');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
