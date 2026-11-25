import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { type Account, accountsByEmail, type EmailResult, lookUp, reviewOf } from '../src/lookup.js';
import { CreditBudgetExceededError, ModashApiError, NoAnswerError } from '../src/modash/errors.js';
import type { MatchedEmail, ModashReads } from '../src/modash/reads.js';
import { openResults } from '../src/results.js';

const user = (platform: string, userId: string) => ({ platform, userId, username: `name_${userId}`, followers: 1000 });
const account = (platform: Account['platform'], userId: string): Account => ({ platform, userId, username: null, url: null, followers: null, isVerified: null });

/** Reads that answer from a table of email to accounts, and remember each call. */
function tableReads(table: Record<string, ReturnType<typeof user>[]>, fail?: (emails: string[]) => Error | undefined) {
  const calls: string[][] = [];
  const reads: ModashReads = {
    async searchEmails(emails) {
      calls.push(emails);
      const error = fail?.(emails);
      if (error) throw error;
      return emails.filter((email) => email in table).map((email): MatchedEmail => ({ email, users: table[email] }));
    },
  };
  return { reads, calls };
}

describe('matches', () => {
  it('joins an answer to the list whatever case the email comes back in', () => {
    const found = accountsByEmail([{ email: ' Amy@Example.com ', users: [user('instagram', '1')] }]);
    assert.equal(found['amy@example.com']?.length, 1);
  });

  it('drops accounts on another platform, reads the platform in any case, and keeps an account once', () => {
    const found = accountsByEmail([{ email: 'amy@example.com', users: [user('twitch', '9'), user('TikTok', '2'), user('tiktok', '2')] }]);
    assert.deepEqual(
      found['amy@example.com']?.map((account) => account.platform),
      ['tiktok'],
    );
  });

  it('drops a match that has no email', () => {
    assert.deepEqual(accountsByEmail([{ users: [user('instagram', '1')] }, { email: ' ', users: [] }]), {});
  });

  it('accepts one account per platform without a review', () => {
    assert.equal(reviewOf([account('instagram', '1'), account('youtube', 'UC1')]), null);
  });

  it('sends an email that two accounts on one platform list to a person', () => {
    assert.equal(reviewOf([account('instagram', '1'), account('instagram', '2'), account('tiktok', '3')]), '2 instagram accounts list this email');
  });
});

describe('a run over the list', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'email-lookup-'));
    path = join(dir, 'results.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const recorded = () =>
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as EmailResult);

  it('sends the list in calls of the batch size and records every email, matched or not', async () => {
    const { reads, calls } = tableReads({ 'b@example.com': [user('instagram', '1')] });
    const outcome = await lookUp({ emails: ['a@example.com', 'b@example.com', 'c@example.com'], reads, batchSize: 2, results: openResults(path, 'resume') });
    assert.deepEqual(calls, [['a@example.com', 'b@example.com'], ['c@example.com']]);
    assert.deepEqual(outcome, { skipped: 0, checked: 3, matched: 1, toReview: 0, notChecked: 0, notInCall: 0, errors: [] });
    assert.deepEqual(
      recorded().map((result) => [result.email, result.accounts.length]),
      [
        ['a@example.com', 0],
        ['b@example.com', 1],
        ['c@example.com', 0],
      ],
    );
  });

  it('does not send an email that already has a result when a run resumes', async () => {
    writeFileSync(path, `${JSON.stringify({ email: 'a@example.com', accounts: [], review: null })}\n`);
    const { reads, calls } = tableReads({});
    const outcome = await lookUp({ emails: ['a@example.com', 'b@example.com'], reads, batchSize: 10, results: openResults(path, 'resume') });
    assert.deepEqual(calls, [['b@example.com']]);
    assert.equal(outcome.skipped, 1);
    assert.equal(outcome.checked, 1);
  });

  it('starts a new line after one a crash cut off, so the next results are not lost', () => {
    const line = JSON.stringify({ email: 'a@example.com', accounts: [], review: null });
    writeFileSync(path, `${line}\n{"email":"b@example.com","acc`);
    openResults(path, 'resume').record([{ email: 'c@example.com', accounts: [], review: null }]);
    assert.deepEqual([...openResults(path, 'resume').checked].sort(), ['a@example.com', 'c@example.com']);
  });

  it('remembers which checked emails matched', () => {
    openResults(path, 'resume').record([
      { email: 'a@example.com', accounts: [account('instagram', '1')], review: null },
      { email: 'b@example.com', accounts: [], review: null },
    ]);
    assert.deepEqual([...openResults(path, 'resume').matched], ['a@example.com']);
  });

  it('marks an email the API matched with no account on the three platforms, and counts a matched email the call did not send', async () => {
    const reads: ModashReads = {
      searchEmails: async () => [
        { email: 'a@example.com', users: [user('twitch', '9')] },
        { email: 'stray@example.com', users: [user('instagram', '1')] },
      ],
    };
    const outcome = await lookUp({ emails: ['a@example.com'], reads, batchSize: 5, results: openResults(path, 'resume') });
    assert.equal(outcome.matched, 1);
    assert.equal(outcome.toReview, 1);
    assert.equal(outcome.notInCall, 1);
    assert.match(recorded()[0]?.review ?? '', /returned no Instagram, TikTok or YouTube account/);
  });

  it('keeps a line it cannot read and one line per email when it opens the file', () => {
    const line = JSON.stringify({ email: 'a@example.com', accounts: [], review: null });
    writeFileSync(path, `${line}\n${line}\n{"email":"cut off by a cra`);
    const results = openResults(path, 'resume');
    assert.deepEqual([...results.checked], ['a@example.com']);
    assert.equal(readFileSync(path, 'utf8'), `{"email":"cut off by a cra\n${line}\n`);
  });

  it('goes on after a call that failed, and leaves its emails for a rerun', async () => {
    const busy = new ModashApiError('email-search', 500, undefined, 'try later');
    const { reads } = tableReads({}, (emails) => (emails.includes('a@example.com') ? busy : undefined));
    const outcome = await lookUp({ emails: ['a@example.com', 'b@example.com'], reads, batchSize: 1, results: openResults(path, 'resume') });
    assert.equal(outcome.notChecked, 1);
    assert.equal(outcome.checked, 1);
    assert.deepEqual(outcome.errors, [busy.message]);
    assert.deepEqual(
      recorded().map((result) => result.email),
      ['b@example.com'],
    );
  });

  it('stops at a spent budget, a bad token or an empty balance, and keeps what it recorded', async () => {
    for (const stop of [new CreditBudgetExceededError(1, 1), new ModashApiError('email-search', 401, 'api_token_invalid', ''), new ModashApiError('email-search', 400, 'not_enough_credits', '')]) {
      const { reads, calls } = tableReads({}, (emails) => (emails.includes('b@example.com') ? stop : undefined));
      const outcome = await lookUp({ emails: ['a@example.com', 'b@example.com', 'c@example.com'], reads, batchSize: 1, results: openResults(path, 'fresh') });
      assert.equal(outcome.stoppedBy, stop);
      assert.equal(calls.length, 2);
      assert.deepEqual(
        recorded().map((result) => result.email),
        ['a@example.com'],
      );
    }
  });

  it('counts the emails of a call that got no answer as not checked', async () => {
    const { reads } = tableReads({}, () => new NoAnswerError('email-search', new Error('timed out')));
    const outcome = await lookUp({ emails: ['a@example.com', 'b@example.com'], reads, batchSize: 2, results: openResults(path, 'resume') });
    assert.equal(outcome.notChecked, 2);
    assert.equal(outcome.checked, 0);
  });

  it('does not hide a bug as a failed call', async () => {
    const { reads } = tableReads({}, () => new TypeError('x is not a function'));
    await assert.rejects(lookUp({ emails: ['a@example.com'], reads, batchSize: 1, results: openResults(path, 'resume') }), /x is not a function/);
  });
});
