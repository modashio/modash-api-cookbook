import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { type CreatorRow, parseRows, runBatch } from './batch.js';
import { type Config, creditBudgetSchema, loadConfig } from './config.js';
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
  npm run dev                                    mock mode: the two invented creators in handles.example.csv
  npm run match-creator -- <platform> <handle>   one creator; the handle can be a profile URL
  npm run match-csv -- <file>                    a list with the columns platform and handle; run it again to resume
Options:
  --mock              answer from the invented fixtures: only instagram ${MOCK_HANDLES.join(' and ')}, no token, no network (default: off)
  --max-credits <n>   stop before this run could spend more than n credits (default: MODASH_CREDIT_BUDGET, or 50)
  -h, --help          print this text`;

const COMMANDS = ['match-creator', 'match-csv'] as const;
type Command = (typeof COMMANDS)[number];

export class UsageError extends Error {}

interface Input {
  csv: boolean;
  rows: CreatorRow[];
  mock: boolean;
  budget: number;
  apiToken: string | undefined;
}

export async function run({ argv, env = process.env, cwd = process.cwd(), print = console.log }: RunOptions): Promise<number> {
  const input = parseInput(argv, env);
  if (input === 'help') {
    print(USAGE);
    return 0;
  }
  const { csv, rows: todo, mock, budget, apiToken } = input;

  // Mock mode starts the file over, a CSV resumes it, and a single handle replaces its own line.
  const mode: ResultsMode = mock
    ? { kind: 'fresh' }
    : csv
      ? { kind: 'resume', toRun: new Set(todo.flatMap((r) => (r.kind === 'creator' ? creatorKey(r.platform, r.handle) : []))) }
      : { kind: 'replace' };

  const outDir = join(cwd, 'output');
  const resultsFile = join(outDir, mock ? 'mock-results.jsonl' : 'results.jsonl');
  const shown = relative(cwd, resultsFile);
  const client = mock
    ? new ModashClient(mockTransport(), { pauseMs: 0, budget })
    : new ModashClient(liveTransport(apiToken!), { budget });
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

// Checks every parameter before any file is written or any call is made, and reports all the problems in one message.
function parseInput(argv: string[], env: NodeJS.ProcessEnv): Input | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        mock: { type: 'boolean', default: false },
        'max-credits': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) return 'help';
  const [command, ...args] = positionals;
  if (!(COMMANDS as readonly string[]).includes(command ?? '')) {
    const problem = command === undefined ? 'Give a command.' : `Unknown command "${command}".`;
    throw new UsageError(`${problem} Use ${COMMANDS.join(' or ')}.\n\n${USAGE}`);
  }

  const csv = (command as Command) === 'match-csv';
  const mock = values.mock;
  const problems: string[] = [];
  let showUsage = false;

  let rows: CreatorRow[] = [];
  if (args.length !== (csv ? 1 : 2)) {
    const expected = csv ? 'a file' : 'a platform and a handle';
    problems.push(`${command} takes ${expected}, got ${args.length === 0 ? 'nothing' : args.map((a) => `"${a}"`).join(' ')}.`);
    showUsage = true;
  } else if (csv) {
    try {
      rows = parseRows(readCsv(args[0]!));
    } catch (error) {
      problems.push((error as Error).message);
    }
  } else {
    rows = parseRows([[args[0]!, args[1]!]]);
  }
  if (mock) rows = rows.map(onlyMockCreators);
  // A CSV skips its bad rows, but the one creator of match-creator must be valid.
  if (!csv && rows[0]?.kind === 'skipped') problems.push(rows[0].reason);

  let config: Config | undefined;
  try {
    config = loadConfig(env);
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (config && !mock && !config.apiToken) {
    problems.push('Set MODASH_API_TOKEN (in .env or your shell) to run live. To try it without a token, run npm run dev.');
  }

  let budget = config?.creditBudget ?? 0;
  const maxCredits = values['max-credits'];
  if (maxCredits !== undefined) {
    const parsedBudget = creditBudgetSchema.safeParse(maxCredits);
    if (parsedBudget.success) budget = parsedBudget.data;
    else problems.push(`--max-credits must be a number above 0, got "${maxCredits}".`);
  }

  if (problems.length > 0) {
    const message = problems.length === 1 ? problems[0]! : `The run did not start:\n${problems.map((p) => `  - ${p}`).join('\n')}`;
    throw new UsageError(showUsage ? `${message}\n\n${USAGE}` : message);
  }
  return { csv, rows, mock, budget, apiToken: config!.apiToken };
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
