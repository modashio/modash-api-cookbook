import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { handleFrom, idFrom } from '../src/contacts.js';
import { type MatchResult, Matcher } from '../src/match.js';
import { ModashClient, type Transport } from '../src/modash/client.js';
import { CreditBudgetExceededError, ModashApiError } from '../src/modash/errors.js';
import { fixtureKey, mockTransport } from '../src/modash/mock.js';
import { parseCsv, run } from '../src/run.js';

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

const client = (transport: Transport, budget?: number) => new ModashClient(transport, { budget, pauseMs: 0, retryDelayMs: 0 });
const amy = { 'GET instagram/users?query=amy': { users: [{ userId: '1', username: 'amy' }] } };

describe('mock mode', () => {
  it('reproduces the sample output', async () => {
    const matcher = new Matcher(client(mockTransport()));
    for (const handle of ['example_baker', 'example_techreviews']) {
      const want = JSON.parse(
        readFileSync(new URL(`../sample-output/instagram_${handle}.json`, import.meta.url), 'utf8'),
      ) as MatchResult;
      assert.deepEqual(await matcher.match('instagram', handle), want);
    }
  });
});

describe('reading contacts', () => {
  it('reads handles from handles and profile URLs', () => {
    const cases: [Parameters<typeof handleFrom>[0], string, string][] = [
      ['instagram', 'https://www.instagram.com/bob.smith/', 'bob.smith'],
      ['instagram', 'instagram.com/bob/reels/', 'bob'],
      ['instagram', '@bob', 'bob'],
      ['instagram', 'john.doe', 'john.doe'],
      ['tiktok', 'https://www.tiktok.com/@u_1/video/123', 'u_1'],
      ['youtube', 'https://youtube.com/@bob/videos', 'bob'],
      ['youtube', 'https://www.youtube.com/c/BobKitchen', 'BobKitchen'],
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
  it('treats only a bad token and an empty balance as fatal', () => {
    assert.equal(new ModashApiError('x', 400, 'api_token_invalid', '').isFatal, true);
    assert.equal(new ModashApiError('x', 402, 'not_enough_credits', '').isFatal, true);
    assert.equal(new ModashApiError('x', 401, undefined, '').isFatal, true);
    assert.equal(new ModashApiError('x', 403, 'feature_not_available', '').isFatal, false);
    assert.equal(new ModashApiError('x', 404, 'account_not_found', '').isFatal, false);
  });

  it('records a dead linked account and goes on', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [
        { type: 'tiktok', value: 'https://www.tiktok.com/share/user/9' },
      ]),
    };
    const c = client(fake(saved));
    const r = await new Matcher(c).match('instagram', 'amy');
    assert.deepEqual(r.missing, ['tiktok', 'youtube']);
    assert.ok(r.errors.length > 0);
    assert.equal(c.spent, 1);
  });

  it('stops on a bad token', async () => {
    const t = fake({}, { 'GET instagram/users?query=amy': [401, 'api_token_invalid'] });
    await assert.rejects(new Matcher(client(t)).match('instagram', 'amy'), ModashApiError);
  });

  it('stops before a call that could go over budget', async () => {
    const saved = { ...amy, 'GET instagram/profile/1/report': report('1', { username: 'amy' }, []) };
    const c = client(fake(saved), 0.5);
    await assert.rejects(new Matcher(c).match('instagram', 'amy'), CreditBudgetExceededError);
    assert.equal(c.spent, 0);
  });

  it('holds email search against the budget before sending it', async () => {
    const saved = {
      ...amy,
      'GET instagram/profile/1/report': report('1', { username: 'amy' }, [{ type: 'email', value: 'a@example.com' }]),
    };
    const c = client(fake(saved), 1.01);
    await assert.rejects(new Matcher(c).match('instagram', 'amy'), CreditBudgetExceededError);
    assert.equal(c.spent, 1);
  });

  it('does not charge a failed report', async () => {
    const c = client(fake(amy, { 'GET instagram/profile/1/report': [404, 'account_removed'] }));
    await new Matcher(c).match('instagram', 'amy');
    assert.equal(c.spent, 0);
  });

  it('retries a busy API, then succeeds', async () => {
    let calls = 0;
    const t: Transport = async () => {
      calls += 1;
      return calls < 3 ? { status: 503, body: {} } : { status: 200, body: { users: [] } };
    };
    await new Matcher(client(t)).lookup('instagram', 'amy');
    assert.equal(calls, 3);
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
    const r = await new Matcher(client(fake(saved))).match('youtube', 'oldname');
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
    const r = await new Matcher(client(fake(saved))).match('instagram', 'amy');
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
    const r = await new Matcher(client(fake(saved))).match('instagram', 'amy');
    assert.equal(r.accounts.tiktok, undefined);
    assert.deepEqual(r.candidates.filter((c) => c.platform === 'tiktok').map((c) => c.userId).sort(), ['8', '9']);
  });
});

describe('command line', () => {
  let dir: string;
  const lines: string[] = [];
  const print = (line: string) => lines.push(line);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cross-platform-search-'));
    lines.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs mock mode with no token', async () => {
    assert.equal(await run({ argv: [], env: {}, cwd: dir, print }), 0);
    assert.match(lines.join('\n'), /mock mode/);
    assert.equal(readFileSync(join(dir, 'output', 'mock-results.jsonl'), 'utf8').trim().split('\n').length, 2);
  });

  it('asks for a token before running on real creators', async () => {
    await assert.rejects(run({ argv: ['instagram', 'someone'], env: {}, cwd: dir, print }), /MODASH_API_TOKEN/);
  });

  it('runs a CSV in mock mode and skips bad rows', async () => {
    const csv = join(dir, 'h.csv');
    writeFileSync(csv, '﻿platform,handle\ninstagram,example_baker\nfacebook,x\n"instagram","https://www.instagram.com/example_baker/"\n');
    assert.equal(await run({ argv: ['--mock', '--csv', csv], env: {}, cwd: dir, print }), 0);
    assert.match(lines.join('\n'), /row 2 skipped/);
    assert.equal(readFileSync(join(dir, 'output', 'mock-results.jsonl'), 'utf8').trim().split('\n').length, 1);
  });

  it('parses quoted CSV fields', () => {
    assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n'), [
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });
});

describe('review fixes', () => {
  it('turns an unknown flag into a usage message', async () => {
    await assert.rejects(run({ argv: ['--demo'], env: {}, print: () => {} }), /Usage/);
  });

  it('does not retry an ordinary TypeError', async () => {
    let calls = 0;
    const t: Transport = async () => {
      calls += 1;
      throw new TypeError('x is undefined');
    };
    await assert.rejects(new Matcher(client(t)).lookup('instagram', 'amy'), TypeError);
    assert.equal(calls, 1);
  });

  it('keeps the charge for a billed 200 with the wrong shape', async () => {
    const c = client(fake({ ...amy, 'GET instagram/profile/1/report': { error: false, profile: 'oops' } }));
    await new Matcher(c).match('instagram', 'amy');
    assert.equal(c.spent, 1);
  });

  it('refuses real handles when MODASH_MOCK is set', async () => {
    await assert.rejects(
      run({ argv: ['instagram', 'bob'], env: { MODASH_MOCK: 'true', MODASH_API_TOKEN: 'abc' }, print: () => {} }),
      /MODASH_MOCK is true/,
    );
  });

  it('records a creator who is not found without an error', async () => {
    const t = fake({ 'GET instagram/users?query=amy': { users: [] }, 'POST instagram/search {"page":0,"filter":{"influencer":{"relevance":["@amy"],"hasAudienceData":false}}}': { directs: [], lookalikes: [] } });
    const r = await new Matcher(client(t)).match('instagram', 'amy');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.missing, ['instagram', 'tiktok', 'youtube']);
  });
});
