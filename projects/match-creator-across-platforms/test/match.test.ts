import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { handleFrom, idFrom } from '../src/contacts.js';
import type { MatchResult } from '../src/creator-match.js';
import { Matcher } from '../src/match.js';
import { liveTransport, ModashClient, type Transport } from '../src/modash/client.js';
import { CreditBudgetExceededError, MockDataMissingError, ModashApiError, stopsTheRun } from '../src/modash/errors.js';
import { fixtureKey, loadFixtures, mockTransport } from '../src/modash/mock.js';
import { modashReads } from '../src/modash/reads.js';
import { emailSearchResponseSchema, reportProfileSchema } from '../src/modash/responses.js';
import { openResults } from '../src/results.js';
import { parseCsv, run, UsageError } from '../src/run.js';
import { memoryReads } from './memory-reads.js';

const report = (userId: string, profile: object, contacts: object[]) => ({
  error: false,
  profile: { userId, profile, contacts },
});

/** Answers from `saved`, fails with the given status and code for anything in `fail`. */
function fake(saved: Record<string, unknown>, fail: Record<string, [number, string]> = {}): Transport {
  return async (request) => {
    const key = fixtureKey(request);
    const failure = fail[key];
    if (failure) return { status: failure[0], body: { error: true, code: failure[1], message: 'test' } };
    if (key in saved) return { status: 200, body: saved[key] };
    return { status: 404, body: { error: true, code: 'account_not_found', message: 'test' } };
  };
}

const client = (transport: Transport, budget = Infinity) => new ModashClient(transport, { budget, pauseMs: 0, retryDelayMs: 0 });
const amy = { 'GET instagram/users?query=amy': { users: [{ userId: '1', username: 'amy' }] } };
const amyAccount = { platform: 'instagram', userId: '1', username: 'amy' } as const;
const amyReport = (contacts: { type: string; value: string }[]) =>
  ({ platform: 'instagram', userId: '1', profile: { username: 'amy' }, contacts }) as const;

describe('mock mode', () => {
  it('stops on a request the mock data has no answer for', async () => {
    await assert.rejects(new Matcher(modashReads(client(mockTransport({})))).match('instagram', 'amy'), MockDataMissingError);
  });

  it('reproduces the sample output', async () => {
    const matcher = new Matcher(modashReads(client(mockTransport(loadFixtures()))));
    for (const handle of ['example_baker', 'example_techreviews']) {
      const want = JSON.parse(
        readFileSync(new URL(`../sample-output/instagram_${handle}.json`, import.meta.url), 'utf8'),
      ) as MatchResult;
      assert.deepEqual(await matcher.match('instagram', handle), want);
    }
  });
});

describe('reading contacts', () => {
  it('drops a contact with no value when the report comes in', () => {
    const report = reportProfileSchema.parse({
      contacts: [{ type: 'youtube', value: null }, { type: 'email' }, { type: 'tiktok', value: ' ' }, { type: 'tiktok', value: 'x' }],
    });
    assert.deepEqual(report.contacts, [{ type: 'tiktok', value: 'x' }]);
    assert.deepEqual(reportProfileSchema.parse({}).contacts, []);
  });

  it('reads handles from handles and profile URLs', () => {
    const cases: [Parameters<typeof handleFrom>[0], string, string][] = [
      ['instagram', 'https://www.instagram.com/bob.smith/', 'bob.smith'],
      ['instagram', 'instagram.com/bob/reels/', 'bob'],
      ['instagram', '@bob', 'bob'],
      ['instagram', 'john.doe', 'john.doe'],
      ['tiktok', 'https://www.tiktok.com/@u_1/video/123', 'u_1'],
      ['youtube', 'https://youtube.com/@bob/videos', 'bob'],
      ['youtube', 'https://www.youtube.com/c/BobKitchen', 'bobkitchen'],
      ['youtube', 'youtube.com/user/bobold?x=1', 'bobold'],
    ];
    for (const [platform, value, want] of cases) assert.equal(handleFrom(platform, value), want, value);
  });

  it('rejects values that are not a profile', () => {
    const cases: [Parameters<typeof handleFrom>[0], string][] = [
      ['instagram', 'https://www.instagram.com/p/Cxyz/'],
      ['instagram', 'instagram.com/accounts/login'],
      ['instagram', 'a b'],
      ['instagram', '../x'],
      ['instagram', 'https://x.com/bob'],
      ['instagram', 'https://x.com/'],
      ['youtube', 'https://www.youtube.com/watch?v=abc'],
      ['youtube', 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'],
      ['tiktok', 'https://www.tiktok.com/share/user/123'],
    ];
    for (const [platform, value] of cases) assert.equal(handleFrom(platform, value), undefined, value);
  });

  it('reads ids from id links', () => {
    assert.equal(idFrom('tiktok', 'https://www.tiktok.com/share/user/123'), '123');
    assert.equal(idFrom('youtube', 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'), 'UCabcdefghijklmnopqrstuv');
    assert.equal(idFrom('instagram', 'https://www.instagram.com/bob'), undefined);
  });
});

describe('errors and credits', () => {
  it('reports a page that is not JSON as an error, not as an empty answer', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html>bad gateway</html>', { status: 200 });
    try {
      const reads = modashReads(new ModashClient(liveTransport('token'), { pauseMs: 0, budget: Infinity }));
      await assert.rejects(reads.lookupAccounts('instagram', 'amy'), (e: unknown) => e instanceof ModashApiError && e.code === 'not_json');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('drops an email search match that has no email', () => {
    const data = emailSearchResponseSchema.parse({
      matchedEmails: [{ users: [{ userId: '1', platform: 'tiktok' }] }, { email: 'amy@x.com', users: [] }],
    });
    assert.deepEqual(data.matchedEmails.map((m) => m.email), ['amy@x.com']);
  });

  it('stops the run only on a spent budget, a bad token, or an empty balance', () => {
    assert.equal(stopsTheRun(new CreditBudgetExceededError(1, 1)), true);
    assert.equal(stopsTheRun(new ModashApiError('x', 400, 'api_token_invalid', '')), true);
    assert.equal(stopsTheRun(new ModashApiError('x', 402, 'not_enough_credits', '')), true);
    assert.equal(stopsTheRun(new ModashApiError('x', 401, undefined, '')), true);
    assert.equal(stopsTheRun(new ModashApiError('x', 403, 'feature_not_available', '')), false);
    assert.equal(stopsTheRun(new ModashApiError('x', 404, 'account_not_found', '')), false);
    assert.equal(stopsTheRun(new Error('network down')), false);
  });

  it('records a dead linked account and goes on', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/9' },
      ]),
      'GET tiktok/users?query=amy': { users: [] },
      'GET youtube/users?query=amy': { users: [] },
    };
    const c = client(fake(saved));
    const r = await new Matcher(modashReads(c)).match('instagram', 'amy');
    assert.deepEqual(r.missing, ['tiktok', 'youtube']);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, /report tiktok 9/);
    assert.equal(c.spent, 1);
  });

  it('stops on a bad token', async () => {
    const t = fake({}, { 'GET instagram/users?query=amy': [401, 'api_token_invalid'] });
    await assert.rejects(new Matcher(modashReads(client(t))).match('instagram', 'amy'), ModashApiError);
  });

  it('stops before a call that could go over budget', async () => {
    const saved = { ...amy, 'GET instagram/profile/1/report': report('1', { username: 'amy' }, []) };
    const c = client(fake(saved), 0.5);
    await assert.rejects(new Matcher(modashReads(c)).match('instagram', 'amy'), CreditBudgetExceededError);
    assert.equal(c.spent, 0);
  });

  it('holds email search against the budget before sending it', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [{ type: 'email', value: 'a@example.com' }]),
    };
    const c = client(fake(saved), 1.01);
    await assert.rejects(new Matcher(modashReads(c)).match('instagram', 'amy'), CreditBudgetExceededError);
    assert.equal(c.spent, 1);
  });

  it('does not charge a failed report', async () => {
    const c = client(fake(amy, { 'GET instagram/profile/1/report': [404, 'account_removed'] }));
    await new Matcher(modashReads(c)).match('instagram', 'amy');
    assert.equal(c.spent, 0);
  });

  it('retries a busy API, then succeeds', async () => {
    let calls = 0;
    const t: Transport = async () => {
      calls += 1;
      return calls < 3 ? { status: 503, body: {} } : { status: 200, body: { users: [] } };
    };
    await modashReads(client(t)).lookupAccounts('instagram', 'amy');
    assert.equal(calls, 3);
  });

  it('does not retry a report whose audience is not ready', async () => {
    let calls = 0;
    const t: Transport = async () => {
      calls += 1;
      return { status: 503, body: { error: true, code: 'retry_later', message: 'test' } };
    };
    await assert.rejects(modashReads(client(t)).report('instagram', '1'), ModashApiError);
    assert.equal(calls, 1);
  });

  it('does not retry an ordinary TypeError', async () => {
    let calls = 0;
    const t: Transport = async () => {
      calls += 1;
      throw new TypeError('x is undefined');
    };
    await assert.rejects(modashReads(client(t)).lookupAccounts('instagram', 'amy'), TypeError);
    assert.equal(calls, 1);
  });

  it('retries a timeout on a free call', async () => {
    let calls = 0;
    const t: Transport = async () => {
      calls += 1;
      if (calls < 2) throw new DOMException('timed out', 'TimeoutError');
      return { status: 200, body: { users: [] } };
    };
    await modashReads(client(t)).lookupAccounts('instagram', 'amy');
    assert.equal(calls, 2);
  });

  it('does not send a timed-out paid call again, and keeps its charge', async () => {
    let calls = 0;
    const t: Transport = async () => {
      calls += 1;
      throw new DOMException('timed out', 'TimeoutError');
    };
    const c = client(t);
    await assert.rejects(modashReads(c).report('instagram', '1'), DOMException);
    assert.equal(calls, 1);
    assert.equal(c.spent, 1);
  });

  it('does not send a paid call again after a dropped connection, and keeps its charge', async () => {
    let calls = 0;
    const t: Transport = async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    };
    const c = client(t);
    await assert.rejects(modashReads(c).report('instagram', '1'), TypeError);
    assert.equal(calls, 1);
    assert.equal(c.spent, 1);
  });

  it('keeps the charge for a 200 that carries an error', async () => {
    const t: Transport = async () => ({ status: 200, body: { error: true, code: 'internal_server_error' } });
    const c = client(t);
    await assert.rejects(modashReads(c).report('instagram', '1'), ModashApiError);
    assert.equal(c.spent, 1);
  });

  it('does not ask twice for a report that failed', async () => {
    let reports = 0;
    const inner = fake({
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/9' },
      ]),
      'GET tiktok/users?query=amy': { users: [{ userId: '9', username: 'amy' }] },
    });
    const t: Transport = async (request) => {
      if (request.path === 'tiktok/profile/9/report') reports += 1;
      return inner(request);
    };
    const r = await new Matcher(modashReads(client(t))).match('instagram', 'amy');
    assert.equal(reports, 1);
    assert.deepEqual(r.candidates.map((c) => c.how), ['same handle, report failed']);
  });

  it('keeps the charge for a billed 200 with the wrong shape', async () => {
    const c = client(fake({ ...amy, 'GET instagram/profile/1/report': { error: false, profile: 'oops' } }));
    await new Matcher(modashReads(c)).match('instagram', 'amy');
    assert.equal(c.spent, 1);
  });
});

describe('matching', () => {
  it('confirms a renamed YouTube start by its new handle', async () => {
    const yt = `UC${'a'.repeat(22)}`;
    const saved = {
      'GET youtube/users?query=oldname': { users: [{ userId: yt, username: 'oldname', handle: '@newname' }] },
      [`GET youtube/profile/${yt}/report`]: report(yt, { handle: '@newname' }, [
        { type: 'instagram', value: 'https://www.instagram.com/amy/' },
      ]),
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'youtube', value: 'https://www.youtube.com/@newname' },
      ]),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('youtube', 'oldname');
    assert.equal(r.accounts.instagram?.how, 'confirmed both ways');
  });

  it('keeps the linked account that links back when a profile links two', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/8' },
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/9' },
      ]),
      'GET tiktok/profile/8/report': report('8', { username: 'notamy' }, []),
      'GET tiktok/profile/9/report': report('9', { username: 'amy' }, [{ type: 'instagram', value: 'instagram.com/amy' }]),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok?.userId, '9');
    assert.deepEqual(r.candidates.filter((c) => c.platform === 'tiktok').map((c) => c.userId), ['8']);
  });

  it('does not accept an email several accounts share, and lists each once', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [{ type: 'email', value: 'team@example.com' }]),
      'POST email-search {"emails":["team@example.com"]}': {
        matchedEmails: [
          {
            email: 'team@example.com',
            users: [
              { platform: 'tiktok', userId: '8', username: 'amy' },
              { platform: 'tiktok', userId: '9', username: 'bea' },
            ],
          },
        ],
      },
      'GET tiktok/users?query=amy': { users: [{ userId: '8', username: 'amy' }] },
      'GET tiktok/profile/8/report': report('8', { username: 'amy' }, []),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok, undefined);
    assert.deepEqual(r.candidates.filter((c) => c.platform === 'tiktok').map((c) => c.userId).sort(), ['8', '9']);
  });

  it('does not accept an email that another account on the starting platform also lists', async () => {
    const reads = memoryReads({
      accounts: [amyAccount],
      reports: [amyReport([{ type: 'email', value: 'team@example.com' }])],
      listings: [
        { email: 'team@example.com', platform: 'instagram', userId: '1' },
        { email: 'team@example.com', platform: 'instagram', userId: '2' },
        { email: 'team@example.com', platform: 'youtube', userId: 'UCbea' },
      ],
    });
    const r = await new Matcher(reads).match('instagram', 'amy');
    assert.equal(r.accounts.youtube, undefined);
    assert.equal(r.accounts.instagram?.emailAgrees, undefined);
    assert.deepEqual(r.candidates.map((c) => c.userId), ['UCbea']);
  });

  it('treats an email as shared when the search names another account on the starting platform', async () => {
    const reads = memoryReads({
      accounts: [amyAccount],
      reports: [amyReport([{ type: 'email', value: 'team@example.com' }])],
      listings: [
        { email: 'team@example.com', platform: 'instagram', userId: '2' },
        { email: 'team@example.com', platform: 'youtube', userId: 'UCbea' },
      ],
    });
    const r = await new Matcher(reads).match('instagram', 'amy');
    assert.equal(r.accounts.youtube, undefined);
    assert.deepEqual(r.candidates.map((c) => c.userId), ['UCbea']);
  });

  it('marks email agreement only when two matched accounts list the same email', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'email', value: 'a@example.com' },
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/8' },
        { type: 'youtube', value: 'https://www.youtube.com/@amy' },
      ]),
      'GET tiktok/profile/8/report': report('8', { username: 'amy' }, [
        { type: 'email', value: 'a@example.com' },
        { type: 'instagram', value: 'https://www.instagram.com/amy' },
      ]),
      'GET youtube/users?query=amy': { users: [{ userId: 'UC9', handle: '@amy' }] },
      'GET youtube/profile/UC9/report': report('UC9', { handle: '@amy' }, [
        { type: 'email', value: 'b@example.com' },
        { type: 'instagram', value: 'https://www.instagram.com/amy' },
      ]),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.instagram?.emailAgrees, true);
    assert.equal(r.accounts.tiktok?.emailAgrees, true);
    assert.equal(r.accounts.youtube?.emailAgrees, undefined);
  });

  it('does not accept an email that someone else lists on a platform already matched', async () => {
    const uc = `UC${'a'.repeat(22)}`;
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'email', value: 'team@example.com' },
        { type: 'youtube', value: `https://www.youtube.com/channel/${uc}` },
      ]),
      [`GET youtube/profile/${uc}/report`]: report(uc, { handle: '@amy' }, [
        { type: 'instagram', value: 'https://www.instagram.com/amy' },
      ]),
      'POST email-search {"emails":["team@example.com"]}': {
        matchedEmails: [
          {
            email: 'team@example.com',
            users: [
              { platform: 'youtube', userId: 'UCbea', username: 'bea' },
              { platform: 'tiktok', userId: '77', username: 'cat' },
            ],
          },
        ],
      },
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.youtube?.userId, uc);
    assert.equal(r.accounts.tiktok, undefined);
    assert.deepEqual(r.candidates.map((c) => c.userId), ['77']);
  });

  it('reads an email the search returns in another case as the claimed one', async () => {
    const reads = memoryReads({
      accounts: [amyAccount],
      reports: [amyReport([{ type: 'email', value: 'amy@example.com' }])],
      listings: [{ email: 'Amy@Example.com', platform: 'tiktok', userId: '9' }],
    });
    const r = await new Matcher(reads).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok?.how, 'email (amy@example.com)');
  });

  it('lists both accounts when two emails name different accounts on one platform', async () => {
    const reads = memoryReads({
      accounts: [amyAccount],
      reports: [amyReport([{ type: 'email', value: 'a@example.com' }, { type: 'email', value: 'b@example.com' }])],
      listings: [
        { email: 'a@example.com', platform: 'tiktok', userId: '8' },
        { email: 'b@example.com', platform: 'tiktok', userId: '9' },
      ],
    });
    const r = await new Matcher(reads).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok, undefined);
    assert.deepEqual(r.candidates.map((c) => c.userId).sort(), ['8', '9']);
  });

  it('takes the follower count of a same-handle match from its report', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, []),
      'GET tiktok/users?query=amy': { users: [{ userId: '9', username: 'amy', followers: 100 }] },
      'GET tiktok/profile/9/report': report('9', { username: 'amy', followers: 250000 }, [
        { type: 'instagram', value: 'https://www.instagram.com/amy' },
      ]),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok?.followers, 250000);
  });

  it('records a creator who is not found without an error', async () => {
    const r = await new Matcher(memoryReads({})).match('instagram', 'amy');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.missing, ['instagram', 'tiktok', 'youtube']);
  });

  it('leaves a one-way link as a candidate and still checks the same handle', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [{ type: 'tiktok', value: 'tiktok.com/@partner' }]),
      'GET tiktok/users?query=partner': { users: [{ userId: '8', username: 'partner' }] },
      'GET tiktok/profile/8/report': report('8', { username: 'partner' }, []),
      'GET tiktok/users?query=amy': { users: [{ userId: '9', username: 'amy' }] },
      'GET tiktok/profile/9/report': report('9', { username: 'amy' }, [{ type: 'instagram', value: 'instagram.com/amy' }]),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok?.userId, '9');
    assert.equal(r.accounts.tiktok?.how, 'same handle, confirmed by its profile link back');
    assert.deepEqual(r.candidates, [{ platform: 'tiktok', userId: '8', username: 'partner', followers: null, how: 'profile link, one way' }]);
  });

  it('does not search by an email from an account that did not link back', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/8' },
      ]),
      'GET tiktok/profile/8/report': report('8', { username: 'agency' }, [{ type: 'email', value: 'team@agency.example' }]),
      'POST email-search {"emails":["team@agency.example"]}': {
        matchedEmails: [{ email: 'team@agency.example', users: [{ platform: 'youtube', userId: 'UCother', username: 'other' }] }],
      },
    };
    const c = client(fake(saved));
    const r = await new Matcher(modashReads(c)).match('instagram', 'amy');
    assert.equal(r.accounts.youtube, undefined);
    assert.deepEqual(r.missing, ['tiktok', 'youtube']);
    assert.equal(c.spent, 2);
  });

  it('searches by an email from an account confirmed both ways', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/8' },
      ]),
      'GET tiktok/profile/8/report': report('8', { username: 'amy' }, [
        { type: 'instagram', value: 'instagram.com/amy' },
        { type: 'email', value: 'amy@example.com' },
      ]),
      'POST email-search {"emails":["amy@example.com"]}': {
        matchedEmails: [{ email: 'amy@example.com', users: [{ platform: 'youtube', userId: 'UCamy', username: 'amy' }] }],
      },
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.youtube?.how, 'email (amy@example.com)');
  });

  it('does not search by an email from a second linked account', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/8' },
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/9' },
      ]),
      'GET tiktok/profile/8/report': report('8', { username: 'amy' }, [{ type: 'instagram', value: 'instagram.com/amy' }]),
      'GET tiktok/profile/9/report': report('9', { username: 'brandco' }, [
        { type: 'instagram', value: 'instagram.com/amy' },
        { type: 'email', value: 'pr@brand.example' },
      ]),
      'POST email-search {"emails":["pr@brand.example"]}': {
        matchedEmails: [{ email: 'pr@brand.example', users: [{ platform: 'youtube', userId: 'UCbrand', username: 'brand' }] }],
      },
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok?.userId, '8');
    assert.equal(r.accounts.youtube, undefined);
  });

  it('does not confirm a same-handle account by an email several accounts share', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [{ type: 'email', value: 'team@example.com' }]),
      'POST email-search {"emails":["team@example.com"]}': {
        matchedEmails: [
          {
            email: 'team@example.com',
            users: [
              { platform: 'instagram', userId: '1', username: 'amy' },
              { platform: 'instagram', userId: '2', username: 'bea' },
            ],
          },
        ],
      },
      'GET tiktok/users?query=amy': { users: [{ userId: '8', username: 'amy' }] },
      'GET tiktok/profile/8/report': report('8', { username: 'amy' }, [{ type: 'email', value: 'team@example.com' }]),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok, undefined);
  });

  it('does not confirm a same-handle account by an email search tied to another account there', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'email', value: 'amy@example.com' },
        { type: 'email', value: 'team@example.com' },
      ]),
      'POST email-search {"emails":["amy@example.com","team@example.com"]}': {
        matchedEmails: [
          { email: 'amy@example.com', users: [{ platform: 'tiktok', userId: '7', username: 'cat' }] },
          { email: 'team@example.com', users: [{ platform: 'tiktok', userId: '8', username: 'dan' }] },
        ],
      },
      'GET tiktok/users?query=amy': { users: [{ userId: '9', username: 'amy' }] },
      'GET tiktok/profile/9/report': report('9', { username: 'amy' }, [{ type: 'email', value: 'team@example.com' }]),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok, undefined);
    assert.deepEqual(r.candidates.map((c) => c.userId).sort(), ['7', '8', '9']);
  });

  it('marks email agreement on a same-handle match', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [{ type: 'email', value: 'amy@example.com' }]),
      'POST email-search {"emails":["amy@example.com"]}': { matchedEmails: [] },
      'GET tiktok/users?query=amy': { users: [{ userId: '9', username: 'amy' }] },
      'GET tiktok/profile/9/report': report('9', { username: 'amy' }, [
        { type: 'email', value: 'amy@example.com' },
        { type: 'instagram', value: 'https://www.instagram.com/amy' },
      ]),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok?.emailAgrees, true);
    assert.equal(r.accounts.instagram?.emailAgrees, true);
  });

  it('marks no email agreement on an address another account lists on a platform matched later', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/8' },
        { type: 'email', value: 'me@example.com' },
        { type: 'email', value: 'team@example.com' },
      ]),
      'GET tiktok/profile/8/report': report('8', { username: 'amy' }, [
        { type: 'instagram', value: 'https://www.instagram.com/amy' },
        { type: 'email', value: 'team@example.com' },
      ]),
      'POST email-search {"emails":["me@example.com","team@example.com"]}': {
        matchedEmails: [
          { email: 'me@example.com', users: [{ platform: 'youtube', userId: 'UC1', username: 'amy' }] },
          { email: 'team@example.com', users: [{ platform: 'youtube', userId: 'UC2', username: 'bea' }] },
        ],
      },
      'GET youtube/users?query=amy': { users: [{ userId: 'UC1', handle: '@amy' }] },
      'GET youtube/profile/UC1/report': report('UC1', { handle: '@amy' }, [
        { type: 'instagram', value: 'https://www.instagram.com/amy' },
      ]),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.youtube?.userId, 'UC1');
    assert.equal(r.accounts.tiktok?.emailAgrees, undefined);
    assert.equal(r.accounts.instagram?.emailAgrees, undefined);
  });

  it('takes the follower count of an email match from a report the tool holds', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/8' },
        { type: 'email', value: 'amy@example.com' },
      ]),
      'GET tiktok/profile/8/report': report('8', { username: 'amy', followers: 250000 }, [
        { type: 'email', value: 'amy@example.com' },
      ]),
      'POST email-search {"emails":["amy@example.com"]}': {
        matchedEmails: [
          { email: 'amy@example.com', users: [{ platform: 'tiktok', userId: '8', username: 'amy', followers: 1000 }] },
        ],
      },
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok?.followers, 250000);
  });

  it('does not confirm a same-handle account by email when email search failed', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [{ type: 'email', value: 'team@example.com' }]),
      'GET tiktok/users?query=amy': { users: [{ userId: '9', username: 'amy' }] },
      'GET tiktok/profile/9/report': report('9', { username: 'amy' }, [{ type: 'email', value: 'team@example.com' }]),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok, undefined);
    assert.deepEqual(r.candidates.map((c) => c.how), ['same handle, unconfirmed']);
    assert.ok(r.errors.some((e) => e.startsWith('email search')));
  });

  it('marks email agreement between two same-handle matches when the start lists no email', async () => {
    const linksBack = [
      { type: 'email', value: 'amy@example.com' },
      { type: 'instagram', value: 'https://www.instagram.com/amy' },
    ];
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, []),
      'GET tiktok/users?query=amy': { users: [{ userId: '9', username: 'amy' }] },
      'GET tiktok/profile/9/report': report('9', { username: 'amy' }, linksBack),
      'GET youtube/users?query=amy': { users: [{ userId: 'UC9', handle: '@amy' }] },
      'GET youtube/profile/UC9/report': report('UC9', { handle: '@amy' }, linksBack),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok?.emailAgrees, true);
    assert.equal(r.accounts.youtube?.emailAgrees, true);
    assert.equal(r.accounts.instagram?.emailAgrees, undefined);
  });

  it('lists an account once when two steps find it', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/8' },
        { type: 'email', value: 'team@example.com' },
      ]),
      'GET tiktok/profile/8/report': report('8', { username: 'partner' }, []),
      'POST email-search {"emails":["team@example.com"]}': {
        matchedEmails: [
          {
            email: 'team@example.com',
            users: [
              { platform: 'tiktok', userId: '8', username: 'partner' },
              { platform: 'tiktok', userId: '9', username: 'bea' },
            ],
          },
        ],
      },
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('instagram', 'amy');
    assert.deepEqual(r.candidates.map((c) => `${c.userId} ${c.how}`), [
      '8 profile link, one way',
      '9 email (team@example.com), shared by several accounts',
    ]);
  });

  it('prefers a current handle over another channel\'s older name', async () => {
    const reads = memoryReads({
      accounts: [
        { platform: 'youtube', userId: 'UC1', username: 'amy', handle: '@bob' },
        { platform: 'youtube', userId: 'UC2', handle: '@amy' },
      ],
    });
    assert.equal((await new Matcher(reads).match('youtube', 'amy')).accounts.youtube?.userId, 'UC2');
  });

  it('tries every name the start answers to when looking for the same handle', async () => {
    const yt = `UC${'a'.repeat(22)}`;
    const saved = {
      'GET youtube/users?query=oldname': { users: [{ userId: yt, username: 'oldname', handle: '@newname' }] },
      [`GET youtube/profile/${yt}/report`]: report(yt, { handle: '@newname' }, []),
      'GET instagram/users?query=newname': { users: [{ userId: '1', username: 'newname' }] },
      'GET instagram/profile/1/report': report('1', { username: 'newname' }, [
        { type: 'youtube', value: 'https://www.youtube.com/@newname' },
      ]),
    };
    const r = await new Matcher(modashReads(client(fake(saved)))).match('youtube', 'oldname');
    assert.equal(r.accounts.instagram?.how, 'same handle, confirmed by its profile link back');
  });
});

describe('command line', () => {
  let dir: string;
  const lines: string[] = [];
  const print = (line: string) => lines.push(line);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'match-creator-'));
    lines.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs mock mode with no token', async () => {
    assert.equal(await run({ argv: ['match-csv', '--mock', 'handles.example.csv'], env: {}, cwd: dir, print }), 0);
    assert.match(lines.join('\n'), /mock mode/);
    assert.equal(readFileSync(join(dir, 'output', 'mock-results.jsonl'), 'utf8').trim().split('\n').length, 2);
  });

  it('asks for a token before running on real creators', async () => {
    await assert.rejects(run({ argv: ['match-creator', 'instagram', 'someone'], env: {}, cwd: dir, print }), /MODASH_API_TOKEN/);
  });

  it('runs live without --mock, so no token asks for one', async () => {
    await assert.rejects(run({ argv: ['match-csv', 'h.csv'], env: {}, cwd: dir, print }), /MODASH_API_TOKEN/);
  });

  it('says what input is missing', async () => {
    await assert.rejects(run({ argv: [], env: { MODASH_API_TOKEN: 'abc' }, cwd: dir, print }), /Give a command/);
    await assert.rejects(run({ argv: ['match-creator', '--mock', 'instagram'], env: {}, cwd: dir, print }), /match-creator takes a platform and a handle, got "instagram"/);
    await assert.rejects(run({ argv: ['match-csv', '--mock'], env: {}, cwd: dir, print }), /match-csv takes a file, got nothing/);
    await assert.rejects(run({ argv: ['match', 'instagram', 'a'], env: {}, cwd: dir, print }), /Unknown command "match"/);
  });

  it('refuses a creator mock mode has no data for, with or without a token', async () => {
    for (const env of [{}, { MODASH_API_TOKEN: 'abc' }]) {
      await assert.rejects(run({ argv: ['match-creator', '--mock', 'instagram', 'bob'], env, cwd: dir, print }), /Mock mode has data only for instagram example_baker and example_techreviews/);
    }
  });

  it('applies the credit budget in mock mode too', async () => {
    assert.equal(await run({ argv: ['match-csv', '--mock', '--max-credits', '2', 'handles.example.csv'], env: {}, cwd: dir, print }), 1);
    assert.match(lines.join('\n'), /Stopped at @example_baker/);
  });

  it('runs a CSV in mock mode and matches a creator listed twice once', async () => {
    const csv = join(dir, 'h.csv');
    writeFileSync(csv, '\uFEFFplatform,handle\ninstagram,Example_Baker\n"instagram","https://www.instagram.com/example_baker/"\n');
    assert.equal(await run({ argv: ['match-csv', '--mock', csv], env: {}, cwd: dir, print }), 0);
    assert.equal(readFileSync(join(dir, 'output', 'mock-results.jsonl'), 'utf8').trim().split('\n').length, 1);
  });

  it('refuses a CSV with bad rows, names each file line, and runs nothing', async () => {
    const csv = join(dir, 'h.csv');
    writeFileSync(csv, 'platform,handle\ninstagram,example_baker\n\nfacebook,x\ninstagram,"https://x.com/\namy"\ntiktok,bob\n');
    const error = await run({ argv: ['match-csv', '--mock', csv], env: {}, cwd: dir, print }).catch((e) => e);
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /has 3 rows the tool cannot read/);
    assert.match(error.message, /line 4 \("facebook","x"\): "facebook" is not a platform/);
    assert.match(error.message, /line 5 \("instagram","https:\/\/x\.com\/\\namy"\): "https:\/\/x\.com\/\\namy" is not an instagram handle/);
    assert.match(error.message, /line 7 \("tiktok","bob"\): Mock mode has data only for/);
    assert.match(error.message, /Fix or remove these lines, then run the same command again\./);
    assert.equal(existsSync(join(dir, 'output')), false);
  });

  it('lists at most 20 bad rows', async () => {
    const csv = join(dir, 'h.csv');
    writeFileSync(csv, `platform,handle\n${'facebook,x\n'.repeat(25)}`);
    const error = await run({ argv: ['match-csv', '--mock', csv], env: {}, cwd: dir, print }).catch((e) => e);
    assert.match(error.message, /has 25 rows/);
    assert.match(error.message, /line 21 /);
    assert.doesNotMatch(error.message, /line 22 /);
    assert.match(error.message, /and 5 more/);
  });

  it('turns an unreadable single handle into a usage message', async () => {
    await assert.rejects(
      run({ argv: ['match-creator', '--mock', 'instagram', 'https://x.com/amy'], env: {}, print: () => {} }),
      /is not an instagram handle or profile link/,
    );
  });

  it('checks the source of answers first, then the command values', async () => {
    const noToken = await run({ argv: ['match-creator', 'facebook', 'bob', '--max-credits', 'Infinity'], env: {}, cwd: dir, print }).catch((e) => e);
    assert.ok(noToken instanceof UsageError);
    assert.match(noToken.message, /^Set MODASH_API_TOKEN/);
    assert.doesNotMatch(noToken.message, /facebook/);

    const error = await run({ argv: ['match-creator', 'facebook', 'bob', '--max-credits', 'Infinity'], env: { MODASH_API_TOKEN: 'abc' }, cwd: dir, print }).catch((e) => e);
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /The run did not start/);
    assert.match(error.message, /"facebook" is not a platform/);
    assert.match(error.message, /--max-credits must be a number above 0, got "Infinity"/);
    assert.equal(existsSync(join(dir, 'output')), false);
  });

  it('refuses a --max-credits that is not a number above 0', async () => {
    for (const value of ['0', '-5', 'abc', '', 'Infinity']) {
      await assert.rejects(run({ argv: ['match-csv', '--mock', `--max-credits=${value}`, 'handles.example.csv'], env: {}, cwd: dir, print }), /--max-credits must be a number above 0/);
    }
  });

  it('turns an unknown flag into a usage message', async () => {
    await assert.rejects(run({ argv: ['match-csv', '--demo'], env: {}, print: () => {} }), /Usage/);
  });


  it('keeps the first good result per creator when a run resumes, and every line it cannot read', () => {
    const file = join(dir, 'results.jsonl');
    const line = (handle: string, errors: string[], credits: number) =>
      JSON.stringify({ input: { platform: 'instagram', handle }, accounts: {}, candidates: [], missing: [], credits, errors });
    writeFileSync(file, [line('amy', [], 1), line('bea', ['report failed'], 0), line('amy', [], 2), '{"cut off'].join('\n'));
    const results = openResults(file, { kind: 'resume', toRun: new Set(['instagram:amy', 'instagram:bea']) });
    assert.deepEqual([...results.finished], ['instagram:amy']);
    assert.equal(readFileSync(file, 'utf8'), `{"cut off\n${line('amy', [], 1)}\n`);
  });

  it('replaces only the line of the one creator a single-handle run records', () => {
    const file = join(dir, 'results.jsonl');
    const result = (handle: string, credits: number): MatchResult => ({
      input: { platform: 'instagram', handle },
      accounts: {},
      candidates: [],
      missing: [],
      credits,
      errors: [],
    });
    writeFileSync(file, `${JSON.stringify(result('amy', 1))}\n{"cut off\n${JSON.stringify(result('bea', 1))}\n`);
    openResults(file, { kind: 'replace' }).record(result('amy', 2));
    assert.equal(readFileSync(file, 'utf8'), `{"cut off\n${JSON.stringify(result('bea', 1))}\n${JSON.stringify(result('amy', 2))}\n`);
  });

  it('keeps the failed result of a creator who is not in this run', () => {
    const file = join(dir, 'results.jsonl');
    const line = (handle: string, errors: string[]) =>
      JSON.stringify({ input: { platform: 'instagram', handle }, accounts: {}, candidates: [], missing: [], credits: 0, errors });
    writeFileSync(file, [line('amy', []), line('bea', ['report failed'])].join('\n'));
    const results = openResults(file, { kind: 'resume', toRun: new Set(['instagram:amy']) });
    assert.deepEqual([...results.finished], ['instagram:amy']);
    assert.equal(readFileSync(file, 'utf8'), `${line('amy', [])}\n${line('bea', ['report failed'])}\n`);
  });

  it('refuses a CSV with a quote that never closes', () => {
    assert.throws(() => parseCsv('platform,handle\ninstagram,"amy\ntiktok,bea\n'), /never closes/);
    assert.deepEqual(parseCsv('a,b"c\n').map((r) => r.cells), [['a', 'b"c']]);
  });

  it('parses quoted CSV fields', () => {
    assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n').map((r) => r.cells), [
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });
});
