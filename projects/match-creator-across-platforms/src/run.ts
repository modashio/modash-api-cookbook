import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { type CreatorRow, parseRows, runBatch } from './batch.js';
import { loadConfig } from './config.js';
import { PLATFORMS } from './contacts.js';
import type { MatchResult } from './creator-match.js';
import { Matcher } from './match.js';
import { liveTransport, ModashClient } from './modash/client.js';
import { MOCK_HANDLES, mockTransport } from './modash/mock.js';
import { modashReads } from './modash/reads.js';
import { round2 } from './numbers.js';
import { creatorKey, type ResultsMode } from './results.js';

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
  --mock              answer from the invented fixtures: only instagram ${MOCK_HANDLES.join(' and ')}, no token, no network
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
  const mock = values.mock;
  if (!mock && !config.apiToken) {
    throw new UsageError('Set MODASH_API_TOKEN (in .env or your shell) to run live. To try it without a token, run npm run dev.');
  }
  if (values.csv !== undefined && positionals.length > 0) {
    throw new UsageError(`Give a platform and a handle, or --csv, not both.\n\n${USAGE}`);
  }

  const budget = values['max-credits'] === undefined ? config.creditBudget : Number(values['max-credits']);
  if (!(budget > 0)) throw new UsageError('--max-credits must be a number above 0');

  let todo: CreatorRow[];
  if (values.csv !== undefined) {
    todo = parseRows(readCsv(values.csv));
  } else if (positionals.length === 2) {
    todo = parseRows([[positionals[0]!, positionals[1]!]]);
  } else if (positionals.length === 0 && mock) {
    todo = parseRows(MOCK_HANDLES.map((h) => ['instagram', h]));
  } else {
    const problem = positionals.length === 0 ? 'Give a platform and a handle, or --csv <file>.' : `Expected a platform and a handle, got ${positionals.length === 1 ? 'only one value' : `${positionals.length} values`}.`;
    throw new UsageError(`${problem}\n\n${USAGE}`);
  }
  if (mock) todo = todo.map(onlyMockCreators);
  if (values.csv === undefined && todo[0]?.kind === 'skipped') throw new UsageError(todo[0].reason);
  // Mock mode starts the file over, a CSV resumes it, and a single handle replaces its own line.
  const mode: ResultsMode = mock
    ? { kind: 'fresh' }
    : values.csv !== undefined
      ? { kind: 'resume', toRun: new Set(todo.flatMap((r) => (r.kind === 'creator' ? creatorKey(r.platform, r.handle) : []))) }
      : { kind: 'replace' };

  const outDir = join(cwd, 'output');
  const resultsFile = join(outDir, mock ? 'mock-results.jsonl' : 'results.jsonl');
  const shown = relative(cwd, resultsFile);
  const client = mock
    ? new ModashClient(mockTransport(), { pauseMs: 0, budget })
    : new ModashClient(liveTransport(config.apiToken!), { budget });
  const matcher = new Matcher(modashReads(client, mock ? undefined : join(outDir, 'reports')));

  const { ran, stoppedAt } = await runBatch({
    rows: todo,
    matcher,
    resultsPath: resultsFile,
    mode,
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

// Mock mode answers only for the invented creators, so any other row is skipped instead of failing with a 404.
function onlyMockCreators(row: CreatorRow, index: number): CreatorRow {
  if (row.kind === 'skipped') return row;
  const known = row.platform === 'instagram' && (MOCK_HANDLES as readonly string[]).includes(row.handle.toLowerCase());
  return known
    ? row
    : { kind: 'skipped', rowNumber: index + 1, reason: `mock mode knows only instagram ${MOCK_HANDLES.join(' and ')}, got ${row.platform} ${row.handle}` };
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
