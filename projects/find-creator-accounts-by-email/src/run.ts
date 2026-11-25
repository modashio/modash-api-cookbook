import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { compact, countBy } from 'lodash-es';
import * as z from 'zod';

import { type Config, creditBudgetSchema, loadConfig } from './config.js';
import { readColumn } from './csv.js';
import { type EmailList, emailList, sampleOf } from './emails.js';
import { emailsWithin, estimate, projection } from './estimate.js';
import { type EmailResult, isMatch, lookUp, type LookupOutcome } from './lookup.js';
import { liveTransport, ModashClient, type ModashRequest, requestUrl } from './modash/client.js';
import { ModashApiError } from './modash/errors.js';
import { type Fixtures, loadFixtures, mockTransport } from './modash/mock.js';
import { EMAIL_MATCH_COST, MAX_EMAILS_PER_CALL, modashReads } from './modash/reads.js';
import { round2 } from './numbers.js';
import { openResults, type ResultsFile } from './results.js';

export interface RunOptions {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  print?: (line: string) => void;
}

const USAGE = `Usage:
  npm run lookup-example        no token, no credits: the invented list, with the API call and what it costs
  npm run estimate -- <file>    no token, no credits: counts the emails in a CSV and what checking them can cost
  npm run lookup -- <file>      checks the emails in a CSV; run it again to resume
Options:
  --column <name>     the CSV column that holds the emails (default: email)
  --sample <n>        use n emails spread evenly across the file, not the whole file
  --batch-size <n>    emails per API call, 1 to ${MAX_EMAILS_PER_CALL} (default: ${MAX_EMAILS_PER_CALL})
  --max-credits <n>   stop before this run could spend more than n credits (default: MODASH_CREDIT_BUDGET, or 50)
  --mock              answer from the invented fixtures, with no token and no network (default: off)
  -h, --help          print this text`;

const COMMANDS = ['lookup-example', 'estimate', 'lookup'] as const;
type Command = (typeof COMMANDS)[number];

const EXAMPLE_FILE = fileURLToPath(new URL('../emails.example.csv', import.meta.url));

export class UsageError extends Error {}

/** Where the answers come from: nothing for an estimate, the fixtures with lookup-example or --mock, else the API with a token. */
type Source = { kind: 'none' } | { kind: 'mock'; fixtures: Fixtures } | { kind: 'live'; apiToken: string };

interface Input {
  source: Source;
  command: Command;
  /** The file as the user named it. */
  file: string;
  list: EmailList;
  /** The emails this run uses: the whole list, or the sample. */
  emails: string[];
  sampled: boolean;
  batchSize: number;
  budget: number;
}

export async function run({ argv, env = process.env, cwd = process.cwd(), print = console.log }: RunOptions): Promise<number> {
  const input = parseInput(argv, env, cwd);
  if (input === 'help') {
    print(USAGE);
    return 0;
  }
  const { source, file, list, emails, sampled, batchSize } = input;
  print(listSummary(file, list, sampled ? emails.length : undefined));
  if (source.kind === 'none') {
    print(estimateSummary(emails.length, batchSize));
    return 0;
  }
  return runLookup(input, source, cwd, print);
}

type Print = (line: string) => void;

async function runLookup(input: Input, source: Exclude<Source, { kind: 'none' }>, cwd: string, print: Print): Promise<number> {
  const { command, list, emails, sampled, batchSize, budget } = input;
  const mock = source.kind === 'mock';
  const resultsFile = join(cwd, 'output', mock ? 'mock-results.jsonl' : 'results.jsonl');
  const shown = relative(cwd, resultsFile);
  // Mock mode starts the file over. A live run resumes it.
  const results = openResults(resultsFile, mock ? 'fresh' : 'resume');

  // lookup-example shows the API call behind each batch; the other commands print the matches only.
  const onCall = command === 'lookup-example' ? (request: ModashRequest, credits: number) => print(callLine(request, credits)) : undefined;
  const client = mock
    ? new ModashClient(mockTransport(source.fixtures), { pauseMs: 0, budget, onCall })
    : new ModashClient(liveTransport(source.apiToken), { budget });

  const outcome = await untilInterrupted(
    () => lookUp({ emails, reads: modashReads(client), batchSize, results, onBatch: (batch) => printMatches(batch, print) }),
    () => print(`\nStopped by Ctrl-C. ${creditsLine(client)} Emails already checked are in ${shown}.`),
  );

  print(outcomeSummary(outcome));
  if (outcome.stoppedBy) {
    printStop(outcome.stoppedBy, client, shown, print);
    return 1;
  }
  if (sampled) {
    printProjection(emails, list, results, print);
  }
  if (mock) {
    print(`Results in ${shown}. This was mock mode, so nothing was spent; a live run with these matches costs ${round2(client.spent)} credits.`);
  } else {
    print(`Results in ${shown}. ${creditsLine(client)}`);
  }
  return outcome.notChecked > 0 ? 1 : 0;
}

function printMatches(batch: EmailResult[], print: Print): void {
  const lines = batch.filter(isMatch).flatMap(resultLines);
  if (lines.length > 0) {
    print(lines.join('\n'));
  }
}

function printStop(error: NonNullable<LookupOutcome['stoppedBy']>, client: ModashClient, shown: string, print: Print): void {
  print(`Stopped: ${error.message}`);
  if (error instanceof ModashApiError && error.code === 'not_enough_credits') {
    print(`A call needs a balance of ${EMAIL_MATCH_COST} credits for every email in it, matched or not. Add credits, or lower --batch-size.`);
  }
  print(creditsLine(client));
  print(`Emails already checked are in ${shown}. Fix the cause above, then run the same command again to carry on.`);
}

/** Projects the rest of the file from every sample email that has a result, whichever run checked it. */
function printProjection(sample: string[], list: EmailList, results: ResultsFile, print: Print): void {
  const checked = sample.filter((email) => results.checked.has(email)).length;
  const matched = sample.filter((email) => results.matched.has(email)).length;
  const remaining = list.emails.filter((email) => !results.checked.has(email)).length;
  if (checked > 0 && remaining > 0) {
    print(sampleSummary(matched, checked, remaining));
  }
}

/** Runs `work`. Ctrl-C ends the run at once, so `onInterrupt` says what it spent before leaving. */
async function untilInterrupted<T>(work: () => Promise<T>, onInterrupt: () => void): Promise<T> {
  const stop = () => {
    onInterrupt();
    process.exit(130);
  };
  process.once('SIGINT', stop);
  try {
    return await work();
  } finally {
    process.off('SIGINT', stop);
  }
}

/** What the run cost. The tool cannot tell what a call with no clear answer cost, so its hold is shown apart. */
function creditsLine(client: ModashClient): string {
  const confirmed = round2(client.spent - client.unconfirmed);
  const held = round2(client.unconfirmed);
  return held > 0
    ? `Credits this run: ${confirmed}, and up to ${held} more for calls that got no clear answer. Check your balance.`
    : `Credits this run: ${confirmed}`;
}

// Read the arguments, check there is a source of answers, then check the values the command was given.
// Nothing is written and no call is made before all three pass.
function parseInput(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Input | 'help' {
  const args = readArgs(argv);
  if (args === 'help') return 'help';
  const { source, config } = checkSource(args, env);
  return { source, command: args.command, ...checkCommand(args, config, cwd) };
}

interface Args {
  command: Command;
  values: string[];
  mock: boolean;
  column: string;
  sample: string | undefined;
  batchSize: string | undefined;
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
        column: { type: 'string', default: 'email' },
        sample: { type: 'string' },
        'batch-size': { type: 'string' },
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
  return {
    command,
    values: rest,
    mock: values.mock,
    column: values.column,
    sample: values.sample,
    batchSize: values['batch-size'],
    maxCredits: values['max-credits'],
  };
}

const isCommand = (value: string | undefined): value is Command => (COMMANDS as readonly (string | undefined)[]).includes(value);

// An estimate needs no answers; a lookup needs the fixtures (lookup-example or --mock) or a token for the API.
function checkSource({ command, mock }: Args, env: NodeJS.ProcessEnv): { source: Source; config: Config } {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (command === 'estimate') return { source: { kind: 'none' }, config };
  if (mock || command === 'lookup-example') {
    try {
      return { source: { kind: 'mock', fixtures: loadFixtures() }, config };
    } catch (error) {
      throw new UsageError(`could not read the mock data: ${(error as Error).message}`);
    }
  }
  if (!config.apiToken) {
    throw new UsageError(
      'Set MODASH_API_TOKEN (in .env or your shell) to run live. Tokens come from https://marketer.modash.io/developer. To try it without a token, run npm run lookup-example.',
    );
  }
  return { source: { kind: 'live', apiToken: config.apiToken }, config };
}

const batchSizeSchema = z.coerce.number().int().min(1).max(MAX_EMAILS_PER_CALL);
const sampleSchema = z.coerce.number().int().min(1);

// Every problem is collected, so the user fixes the command once.
function checkCommand({ command, values: args, column, sample, batchSize: batchSizeArg, maxCredits }: Args, config: Config, cwd: string): Omit<Input, 'source' | 'command'> {
  const problems: string[] = [];
  /** The option's value, or `fallback` when it was not given. A value the schema refuses becomes a problem. */
  const option = <T>(raw: string | undefined, schema: z.ZodType<T>, fallback: T, rule: string): T => {
    const parsed = schema.safeParse(raw);
    if (raw === undefined || parsed.success) {
      return parsed.data ?? fallback;
    }
    problems.push(`${rule}, got "${raw}".`);
    return fallback;
  };
  const batchSize = option(batchSizeArg, batchSizeSchema, MAX_EMAILS_PER_CALL, `--batch-size must be a whole number from 1 to ${MAX_EMAILS_PER_CALL}`);
  const sampleSize = option<number | undefined>(sample, sampleSchema, undefined, '--sample must be a whole number above 0');
  const budget = option(maxCredits, creditBudgetSchema, config.creditBudget, '--max-credits must be a number above 0');

  const { file, list, showUsage } = readList(command, args, column, cwd, problems);
  const emails = sampleSize === undefined ? list.emails : sampleOf(list.emails, sampleSize);

  if (command !== 'estimate' && problems.length === 0) {
    const problem = budgetProblem(budget, emails.length, batchSize);
    if (problem) {
      problems.push(problem);
    }
  }
  if (problems.length > 0) {
    const message = problems.length === 1 ? problems[0]! : `The run did not start:\n${problems.map((p) => `  - ${p}`).join('\n')}`;
    throw new UsageError(showUsage ? `${message}\n\n${USAGE}` : message);
  }
  return { file, list, emails, sampled: emails.length < list.emails.length, batchSize, budget };
}

const NO_EMAILS: EmailList = { emails: [], rowCount: 0, blankCount: 0, duplicateCount: 0, notEmails: [] };

/** Reads the command's file: the one the user named, or the example list. A file it cannot use becomes a problem. */
function readList(command: Command, args: string[], column: string, cwd: string, problems: string[]): { file: string; list: EmailList; showUsage: boolean } {
  const example = command === 'lookup-example';
  const file = example ? 'emails.example.csv' : (args[0] ?? '');
  if (args.length !== (example ? 0 : 1)) {
    const got = args.length === 0 ? 'nothing' : args.map((a) => `"${a}"`).join(' ');
    problems.push(`${command} takes ${example ? 'no file: it uses emails.example.csv' : 'one file'}, got ${got}.`);
    return { file, list: NO_EMAILS, showUsage: true };
  }
  try {
    const list = emailList(readColumn(example ? EXAMPLE_FILE : resolve(cwd, file), column, file));
    if (list.emails.length === 0) {
      problems.push(`${file} has no email addresses in the column "${column}".`);
    }
    return { file, list, showUsage: false };
  } catch (error) {
    problems.push((error as Error).message);
    return { file, list: NO_EMAILS, showUsage: false };
  }
}

/** The client holds a call's highest possible cost until its answer comes back, so the budget has to cover one call. */
function budgetProblem(budget: number, emailCount: number, batchSize: number): string | undefined {
  const { balancePerCall: hold } = estimate(emailCount, batchSize);
  if (budget >= hold) {
    return undefined;
  }
  const fits = emailsWithin(budget);
  const callSize = count(Math.min(batchSize, emailCount), 'email');
  const start = `A budget of ${budget} credits cannot cover one call of ${callSize}, which holds ${hold} credits until its answer comes back.`;
  return fits < 1
    ? `${start} Raise --max-credits to ${EMAIL_MATCH_COST} or more: one email holds ${EMAIL_MATCH_COST} credits.`
    : `${start} Raise --max-credits to ${hold} or more, or pass --batch-size ${fits}.`;
}

const number = (n: number) => n.toLocaleString('en-US');
const count = (n: number, noun: string) => `${number(n)} ${noun}${n === 1 ? '' : 's'}`;

const NOT_EMAILS_SHOWN = 5;

function listSummary(file: string, { emails, rowCount, blankCount, duplicateCount, notEmails }: EmailList, sampleSize?: number): string {
  const left = compact([
    blankCount > 0 && `${number(blankCount)} blank`,
    duplicateCount > 0 && count(duplicateCount, 'duplicate'),
    notEmails.length > 0 && `${number(notEmails.length)} not an email address`,
  ]);
  const lines = [`${file}: ${count(rowCount, 'row')}, ${count(emails.length, 'email')} to check${left.length > 0 ? ` (${left.join(', ')})` : ''}`];
  for (const { line, value } of notEmails.slice(0, NOT_EMAILS_SHOWN)) {
    lines.push(`  not sent: line ${line} ${JSON.stringify(value)}`);
  }
  if (notEmails.length > NOT_EMAILS_SHOWN) {
    lines.push(`  not sent: and ${number(notEmails.length - NOT_EMAILS_SHOWN)} more`);
  }
  if (sampleSize !== undefined) {
    lines.push(`Sample: ${count(sampleSize, 'email')}, spread evenly across the file.`);
  }
  return lines.join('\n');
}

function estimateSummary(emailCount: number, batchSize: number): string {
  const { calls, mostCredits, balancePerCall } = estimate(emailCount, batchSize);
  return [
    `Checking ${count(emailCount, 'email')} takes ${count(calls, 'call')} of up to ${count(batchSize, 'email')}.`,
    `It costs ${EMAIL_MATCH_COST} credits per email that matches: 0 if none match, ${number(mostCredits)} if all do.`,
    `Before each call the balance must cover ${EMAIL_MATCH_COST} credits for every email in it: ${number(balancePerCall)} credits for the largest call here.`,
  ].join('\n');
}

function outcomeSummary({ skipped, checked, matched, toReview, notChecked, notInCall, errors, stoppedBy }: LookupOutcome): string {
  const lines: string[] = [];
  if (skipped > 0) {
    lines.push(`${count(skipped, 'email')} already checked, not sent again.`);
  }
  if (checked > 0) {
    const review = toReview > 0 ? ` ${number(toReview)} ${toReview === 1 ? 'match' : 'matches'} to check by hand.` : '';
    lines.push(`Checked ${count(checked, 'email')}: ${number(matched)} matched, ${number(checked - matched)} with no creator account.${review}`);
  } else if (notChecked === 0) {
    lines.push('Nothing new to check.');
  }
  if (notInCall > 0) {
    lines.push(`${count(notInCall, 'matched email')} came back that the call did not send. They may be charged, and no result is written for them.`);
  }
  if (notChecked > 0) {
    lines.push(`${count(notChecked, 'email')} not checked${stoppedBy ? '' : ', because a call failed'}. Run the same command again to send them.`);
    for (const [error, times] of Object.entries(countBy(errors))) {
      lines.push(`  error: ${error}${times > 1 ? ` (${number(times)} calls)` : ''}`);
    }
  }
  return lines.join('\n');
}

function sampleSummary(matched: number, checked: number, remaining: number): string {
  const most = number(estimate(remaining, MAX_EMAILS_PER_CALL).mostCredits);
  if (matched === 0) {
    return `None of the ${count(checked, 'sample email')} matched. A sample can miss the few emails that do match, so check a larger one before you rule the file out. The other ${count(remaining, 'email')} can cost ${most} credits at most.`;
  }
  const { matches, credits } = projection(matched, checked, remaining);
  return `${number(matched)} of the ${count(checked, 'sample email')} matched. At that rate the other ${count(remaining, 'email')} would match about ${number(matches)} and cost about ${number(credits)} credits (${most} at most).`;
}

function resultLines({ email, accounts, review }: EmailResult): string[] {
  return [
    review === null ? email : `${email}  (check by hand: ${review})`,
    ...accounts.map(
      (a) => `  ${a.platform.padEnd(10)} ${`@${a.username ?? a.userId ?? '?'}`.padEnd(29)} ${String(a.followers ?? '').padStart(10)}`,
    ),
  ];
}

/** One API call as lookup-example prints it: the request, then what it costs on a live run. */
function callLine(request: ModashRequest, credits: number): string {
  const cost = credits === 0 ? 'free' : `${round2(credits)} ${credits === 1 ? 'credit' : 'credits'}`;
  return `call  POST ${requestUrl(request).pathname} ${JSON.stringify(request.body)}  (${cost})`;
}
