import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { run, UsageError } from '../src/run.js';

describe('command line', () => {
  let dir: string;
  let lines: string[];
  const print = (line: string) => lines.push(line);
  const go = (...argv: string[]) => run({ argv, env: {}, cwd: dir, print });
  const file = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    return name;
  };
  const numbered = (n: number) => `email\n${Array.from({ length: n }, (_, i) => `user${i}@example.com`).join('\n')}\n`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'email-lookup-cli-'));
    lines = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lookup-example reproduces the sample output and the sample results', async () => {
    const sample = (name: string) => readFileSync(new URL(`../sample-output/${name}`, import.meta.url), 'utf8');
    assert.equal(await go('lookup-example'), 0);
    assert.equal(`${lines.join('\n')}\n`, sample('lookup-example.txt'));
    assert.equal(readFileSync(join(dir, 'output', 'mock-results.jsonl'), 'utf8'), sample('results.jsonl'));
  });

  it('lookup-example takes no file', async () => {
    await assert.rejects(go('lookup-example', 'list.csv'), /lookup-example takes no file: it uses emails\.example\.csv, got "list\.csv"/);
  });

  it('estimate needs no token and makes no call', async () => {
    assert.equal(await go('estimate', file('list.csv', numbered(2500))), 0);
    assert.deepEqual(lines, [
      'list.csv: 2,500 rows, 2,500 emails to check',
      [
        'Checking 2,500 emails takes 3 calls of up to 1,000 emails.',
        'It costs 0.02 credits per email that matches: 0 if none match, 50 if all do.',
        'Before each call the balance must cover 0.02 credits for every email in it: 20 credits for the largest call here.',
      ].join('\n'),
    ]);
  });

  it('a live lookup asks for a token before it reads anything', async () => {
    await assert.rejects(go('lookup', 'missing.csv'), /Set MODASH_API_TOKEN .* https:\/\/marketer\.modash\.io\/developer/);
  });

  it('names the columns a file has when the email column is missing, and reads the one --column names', async () => {
    const name = file('crm.csv', 'id,Contact Email\n1,baker@example.com\n');
    await assert.rejects(go('estimate', name), /crm\.csv has no column named "email"\. Its columns: id, contact email/);
    assert.equal(await go('estimate', name, '--column', 'contact email'), 0);
  });

  it('lists every problem at once, before anything is sent', async () => {
    await assert.rejects(
      go('lookup', '--mock', 'missing.csv', '--batch-size', '5000', '--sample', '0', '--max-credits', 'lots'),
      (error: unknown) =>
        error instanceof UsageError &&
        /--batch-size must be a whole number from 1 to 1000, got "5000"/.test(error.message) &&
        /--sample must be a whole number above 0, got "0"/.test(error.message) &&
        /--max-credits must be a number above 0, got "lots"/.test(error.message) &&
        /could not read missing\.csv/.test(error.message),
    );
  });

  it('refuses a budget that cannot cover one call, and says which batch size fits', async () => {
    await assert.rejects(
      go('lookup', '--mock', file('list.csv', numbered(1000)), '--max-credits', '5'),
      /A budget of 5 credits cannot cover one call of 1,000 emails, which holds 20 credits .* pass --batch-size 250/,
    );
    assert.equal(await go('lookup', '--mock', 'list.csv', '--max-credits', '5', '--batch-size', '250'), 0);
    await assert.rejects(go('lookup', '--mock', 'list.csv', '--max-credits', '0.58'), /pass --batch-size 29\./);
    await assert.rejects(
      go('lookup', '--mock', 'list.csv', '--max-credits', '0.01'),
      (error: unknown) => error instanceof UsageError && /Raise --max-credits to 0\.02 or more/.test(error.message) && !/--batch-size/.test(error.message),
    );
  });

  it('checks a sample and projects the rest of the file from it', async () => {
    const text = numbered(1000).replace('user500@example.com', 'baker@example.com');
    assert.equal(await go('lookup', '--mock', file('list.csv', text), '--sample', '4'), 0);
    const out = lines.join('\n');
    assert.match(out, /Sample: 4 emails, spread evenly across the file\./);
    assert.match(out, /Checked 4 emails: 1 matched, 3 with no creator account\./);
    assert.match(out, /1 of the 4 sample emails matched\. At that rate the other 996 emails would match about 249 and cost about 4\.98 credits \(19\.92 at most\)\./);
  });

  it('says a sample with no match does not rule the file out', async () => {
    assert.equal(await go('lookup', '--mock', file('list.csv', numbered(100)), '--sample', '10'), 0);
    assert.match(lines.join('\n'), /None of the 10 sample emails matched\. A sample can miss the few emails that do match/);
  });

  it('prints the API call only for lookup-example', async () => {
    assert.equal(await go('lookup', '--mock', file('list.csv', 'email\nbaker@example.com\n')), 0);
    assert.doesNotMatch(lines.join('\n'), /^call /m);
    assert.ok(lines.every((line) => line !== ''));
    assert.match(lines.join('\n'), /instagram {2}@example_baker/);
  });

  it('prints the usage for -h and for an unknown command', async () => {
    assert.equal(await go('-h'), 0);
    assert.match(lines.join('\n'), /npm run lookup-example/);
    await assert.rejects(go('find'), /Unknown command "find"\. Use lookup-example or estimate or lookup\./);
  });
});
