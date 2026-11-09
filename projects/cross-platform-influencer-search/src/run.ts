import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig } from './config.js';
import { handleFrom, isPlatform, PLATFORMS, type Platform } from './contacts.js';
import { type MatchResult, Matcher, type ReportCache } from './match.js';
import { liveTransport, ModashClient } from './modash/client.js';
import { CreditBudgetExceededError, ModashApiError, round2 } from './modash/errors.js';
import { MOCK_HANDLES, mockTransport } from './modash/mock.js';
import { reportProfileSchema, type ReportProfile } from './modash/responses.js';

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
  const matcher = new Matcher(client, mock ? undefined : fileCache(join(outDir, 'reports')));

  const done = new Set<string>();
  if (mock && existsSync(resultsFile)) {
    unlinkSync(resultsFile);
  } else if (values.csv !== undefined && existsSync(resultsFile)) {
    const kept: string[] = [];
    for (const { key, line, failed } of readResults(resultsFile)) {
      if (!failed && !done.has(key)) {
        kept.push(line);
        done.add(key);
      }
    }
    writeLines(resultsFile, kept);
  }

  let ran = 0;
  for (const [index, [rawPlatform, rawHandle]] of todo.entries()) {
    let platform: Platform;
    let handle: string;
    try {
      [platform, handle] = cleanInput(rawPlatform, rawHandle);
    } catch (error) {
      print(`row ${index + 1} skipped: ${(error as Error).message}`);
      continue;
    }
    const key = `${platform}:${handle.toLowerCase()}`;
    if (done.has(key)) continue;
    done.add(key);

    let result: MatchResult;
    try {
      result = await matcher.match(platform, handle);
    } catch (error) {
      if (error instanceof CreditBudgetExceededError || (error instanceof ModashApiError && error.isFatal)) {
        print(`Stopped at @${handle}: ${error.message}`);
        print(`Finished creators are in ${shown}. Run the same command again to carry on.`);
        return 1;
      }
      throw error;
    }
    const line = JSON.stringify(result);
    if (values.csv !== undefined || mock) {
      mkdirSync(outDir, { recursive: true });
      appendFileSync(resultsFile, `${line}\n`);
    } else {
      const others = existsSync(resultsFile) ? readResults(resultsFile).filter((r) => r.key !== key).map((r) => r.line) : [];
      writeLines(resultsFile, [...others, line]);
    }
    print(`${summary(result, mock)}\n`);
    ran += 1;
  }

  const total = round2(client.spent);
  if (ran === 0) print('Nothing new to run.');
  else if (mock) print(`Results in ${shown}. This was mock mode, so nothing was spent; a live run of the same creators costs ${total} credits.`);
  else print(`Results in ${shown}. Credits this run: ${total}`);
  return 0;
}

export function cleanInput(platform: string | undefined, handle: string | undefined): [Platform, string] {
  const p = (platform ?? '').trim().toLowerCase();
  if (!isPlatform(p)) throw new Error(`platform must be one of ${PLATFORMS.join(', ')}, got "${platform ?? ''}"`);
  const h = handleFrom(p, (handle ?? '').trim());
  if (!h) throw new Error(`could not read a ${p} handle from "${handle ?? ''}"`);
  return [p, h];
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
  const [header, ...rows] = parseCsv(text);
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
    } else if (ch === '"') quoted = true;
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
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readResults(path: string): { key: string; line: string; failed: boolean }[] {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const r = JSON.parse(line) as MatchResult;
      out.push({ key: `${r.input.platform}:${r.input.handle.toLowerCase()}`, line, failed: r.errors.length > 0 });
    } catch {
      // a line cut off by a crash
    }
  }
  return out;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function writeLines(path: string, lines: string[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeAtomic(path, lines.map((l) => `${l}\n`).join(''));
}

function fileCache(dir: string): ReportCache {
  const file = (platform: Platform, userId: string) => join(dir, `${platform}_${userId.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
  return {
    get(platform, userId) {
      const path = file(platform, userId);
      if (!existsSync(path)) return undefined;
      const parsed = reportProfileSchema.safeParse((() => {
        try {
          return JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          return undefined;
        }
      })());
      if (parsed.success) return parsed.data;
      unlinkSync(path); // a broken saved file: pull it again
      return undefined;
    },
    set(platform, userId, report: ReportProfile) {
      mkdirSync(dir, { recursive: true });
      writeAtomic(file(platform, userId), JSON.stringify(report));
    },
  };
}
