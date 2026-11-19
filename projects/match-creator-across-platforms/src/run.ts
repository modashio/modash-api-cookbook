import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { type Creator, parseCreator, runBatch } from './batch.js';
import { type Config, creditBudgetSchema, loadConfig } from './config.js';
import { PLATFORMS } from './contacts.js';
import type { MatchResult } from './creator-match.js';
import { Matcher } from './match.js';
import { liveTransport, ModashClient } from './modash/client.js';
import { type Fixtures, loadFixtures, MOCK_HANDLES, mockTransport } from './modash/mock.js';
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

/** Where the answers come from: the demo fixtures with --mock, else the API with a token. */
type Source = { kind: 'mock'; fixtures: Fixtures } | { kind: 'live'; apiToken: string };

interface Input {
  source: Source;
  csv: boolean;
  creators: Creator[];
  budget: number;
}

export async function run({ argv, env = process.env, cwd = process.cwd(), print = console.log }: RunOptions): Promise<number> {
  const input = parseInput(argv, env);
  if (input === 'help') {
    print(USAGE);
    return 0;
  }
  const { source, csv, creators, budget } = input;
  const mock = source.kind === 'mock';

  // Mock mode starts the file over, a CSV resumes it, and a single handle replaces its own line.
  const mode: ResultsMode = mock
    ? { kind: 'fresh' }
    : csv
      ? { kind: 'resume', toRun: new Set(creators.map((c) => creatorKey(c.platform, c.handle))) }
      : { kind: 'replace' };

  const outDir = join(cwd, 'output');
  const resultsFile = join(outDir, mock ? 'mock-results.jsonl' : 'results.jsonl');
  const shown = relative(cwd, resultsFile);
  const client =
    source.kind === 'mock'
      ? new ModashClient(mockTransport(source.fixtures), { pauseMs: 0, budget })
      : new ModashClient(liveTransport(source.apiToken), { budget });
  const matcher = new Matcher(modashReads(client, mock ? undefined : join(outDir, 'reports')));

  const { ranCount, stoppedAt } = await runBatch({
    creators,
    matcher,
    resultsPath: resultsFile,
    mode,
    onResult: (result) => print(`${summary(result, mock)}\n`),
  });
  if (stoppedAt) {
    print(`Stopped at @${stoppedAt.handle}: ${stoppedAt.error.message}`);
    print(`Credits this run: ${round2(client.spent)}`);
    print(`Finished creators are in ${shown}. Run the same command again to carry on.`);
    return 1;
  }

  const total = round2(client.spent);
  if (ranCount === 0) print('Nothing new to run.');
  else if (mock) print(`Results in ${shown}. This was mock mode, so nothing was spent; a live run of the same creators costs ${total} credits.`);
  else print(`Results in ${shown}. Credits this run: ${total}`);
  return 0;
}

// The input-checks diagram: read the arguments, then layer 1, then layer 2.
// Nothing is written and no call is made before all three pass.
function parseInput(argv: string[], env: NodeJS.ProcessEnv): Input | 'help' {
  const args = readArgs(argv);
  if (args === 'help') return 'help';
  const { source, config } = checkSource(args.mock, env);
  const { creators, budget } = checkCommand(args, source, config);
  return { source, csv: args.command === 'match-csv', creators, budget };
}

interface Args {
  command: Command;
  values: string[];
  mock: boolean;
  maxCredits: string | undefined;
}

// Known flags, -h, and a known command.
function readArgs(argv: string[]): Args | 'help' {
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
  const [command, ...rest] = positionals;
  if (!isCommand(command)) {
    const problem = command === undefined ? 'Give a command.' : `Unknown command "${command}".`;
    throw new UsageError(`${problem} Use ${COMMANDS.join(' or ')}.\n\n${USAGE}`);
  }
  return { command, values: rest, mock: values.mock, maxCredits: values['max-credits'] };
}

const isCommand = (value: string | undefined): value is Command => (COMMANDS as readonly (string | undefined)[]).includes(value);

// Layer 1: the run has a source of answers, the fixtures with --mock or a token for the API.
function checkSource(mock: boolean, env: NodeJS.ProcessEnv): { source: Source; config: Config } {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (mock) {
    try {
      return { source: { kind: 'mock', fixtures: loadFixtures() }, config };
    } catch (error) {
      throw new UsageError(`could not read the mock data: ${(error as Error).message}`);
    }
  }
  if (!config.apiToken) {
    throw new UsageError('Set MODASH_API_TOKEN (in .env or your shell) to run live. To try it without a token, run npm run dev.');
  }
  return { source: { kind: 'live', apiToken: config.apiToken }, config };
}

// Layer 2: the values the command was given.
function checkCommand(
  { command, values: args, maxCredits }: Args,
  source: Source,
  config: Config,
): { creators: Creator[]; budget: number } {
  const csv = command === 'match-csv';
  const mock = source.kind === 'mock';
  const problems: string[] = [];
  let showUsage = false;

  let creators: Creator[] = [];
  if (args.length !== (csv ? 1 : 2)) {
    const expected = csv ? 'a file' : 'a platform and a handle';
    problems.push(`${command} takes ${expected}, got ${args.length === 0 ? 'nothing' : args.map((a) => `"${a}"`).join(' ')}.`);
    showUsage = true;
  } else {
    try {
      creators = csv ? creatorsFromCsv(args[0]!, mock) : [checkCreator(args[0]!, args[1]!, mock)];
    } catch (error) {
      problems.push((error as Error).message);
    }
  }

  let budget = config.creditBudget;
  if (maxCredits !== undefined) {
    const parsedBudget = creditBudgetSchema.safeParse(maxCredits);
    if (parsedBudget.success) budget = parsedBudget.data;
    else problems.push(`--max-credits must be a number above 0, got "${maxCredits}".`);
  }

  if (problems.length > 0) {
    const message = problems.length === 1 ? problems[0]! : `The run did not start:\n${problems.map((p) => `  - ${p}`).join('\n')}`;
    throw new UsageError(showUsage ? `${message}\n\n${USAGE}` : message);
  }
  return { creators, budget };
}

const BAD_ROWS_SHOWN = 20;

// A bad row blocks the whole run, so the user fixes the file once, before anything is spent.
function creatorsFromCsv(path: string, mock: boolean): Creator[] {
  const creators: Creator[] = [];
  const bad: string[] = [];
  for (const row of readCsv(path)) {
    try {
      creators.push(checkCreator(row.platform, row.handle, mock));
    } catch (error) {
      bad.push(`line ${row.line} (${JSON.stringify(row.platform)},${JSON.stringify(row.handle)}): ${(error as Error).message}`);
    }
  }
  if (bad.length === 0) return creators;
  const listed = bad.slice(0, BAD_ROWS_SHOWN).map((b) => `    - ${b}`);
  if (bad.length > BAD_ROWS_SHOWN) listed.push(`    - and ${bad.length - BAD_ROWS_SHOWN} more`);
  const rows = bad.length === 1 ? '1 row' : `${bad.length} rows`;
  throw new Error(`${path} has ${rows} the tool cannot read:\n${listed.join('\n')}\n    Fix or remove these lines, then run the same command again.`);
}

function checkCreator(platform: string, handle: string, mock: boolean): Creator {
  const creator = parseCreator(platform, handle);
  const inMockData = creator.platform === 'instagram' && (MOCK_HANDLES as readonly string[]).includes(creator.handle);
  if (mock && !inMockData) throw new Error(`Mock mode has data only for instagram ${MOCK_HANDLES.join(' and ')}.`);
  return creator;
}

function summary(result: MatchResult, mock = false): string {
  const lines = [`${result.input.platform} @${result.input.handle}  (${result.credits} credits${mock ? ' on a live run' : ''})`];
  for (const p of PLATFORMS) {
    const a = result.accounts[p];
    if (!a) {
      lines.push(`  ${p.padEnd(10)} not found`);
      continue;
    }
    const name = `@${a.username ?? a.userId}`.padEnd(29);
    lines.push(`  ${p.padEnd(10)} ${name} ${String(a.followers ?? '').padStart(10)}  ${a.how}${a.emailAgrees ? '  + email agrees' : ''}`);
  }
  for (const c of result.candidates) {
    lines.push(`  candidate  ${c.platform} @${c.username ?? c.userId} ${c.followers ?? ''}  ${c.how}`);
  }
  for (const e of result.errors) lines.push(`  error: ${e}`);
  return lines.join('\n');
}

export interface CsvRow {
  /** The file line where the row starts. The header is line 1. */
  line: number;
  platform: string;
  handle: string;
}

export function readCsv(path: string): CsvRow[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    throw new Error(`could not read ${path}: ${(error as Error).message}`);
  }
  let records: CsvRecord[];
  try {
    records = parseCsv(text);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  const [header, ...rows] = records;
  const columns = (header?.cells ?? []).map((c) => c.trim().toLowerCase());
  const pi = columns.indexOf('platform');
  const hi = columns.indexOf('handle');
  if (pi < 0 || hi < 0) throw new Error(`${path} needs the columns platform and handle`);
  const out = rows
    .filter((r) => r.cells.some((c) => c.trim() !== ''))
    .map((r) => ({ line: r.line, platform: r.cells[pi] ?? '', handle: r.cells[hi] ?? '' }));
  if (out.length === 0) throw new Error(`${path} has no rows`);
  return out;
}

export interface CsvRecord {
  line: number;
  cells: string[];
}

export function parseCsv(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const lineBreak = ch === '\n' || (ch === '\r' && text[i + 1] !== '\n');
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
      if (lineBreak) line += 1;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      cells.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      cells.push(field);
      records.push({ line: start, cells });
      cells = [];
      field = '';
      line += 1;
      start = line;
    } else field += ch;
  }
  if (quoted) throw new Error('a quoted field never closes');
  if (field !== '' || cells.length > 0) {
    cells.push(field);
    records.push({ line: start, cells });
  }
  return records;
}
