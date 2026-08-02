import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CreditLedger } from '../src/server/modash/budget.js';
import { assertNotAnError, CreditBudgetExceededError, ModashApiError } from '../src/server/modash/errors.js';
import { findPlatformMismatches, searchFilterSchema } from '../src/server/modash/filters.js';
import { aiSearchCost, searchCost } from '../src/server/modash/pricing.js';
import { RateLimiter } from '../src/server/modash/rate-limit.js';

describe('error envelopes', () => {
  it('accepts the documented shape', () => {
    assert.throws(
      () =>
        assertNotAnError(401, {
          error: true,
          code: 'api_token_invalid',
          message: 'A valid API token is needed.',
        }),
      (error: ModashApiError) => error.code === 'api_token_invalid' && error.status === 401,
    );
  });

  it('joins a message that arrives as an array', () => {
    assert.throws(
      () =>
        assertNotAnError(400, {
          error: true,
          code: 'invalid_body_params',
          message: ['pageSize must be at most 50', 'page must be a number'],
        }),
      (error: ModashApiError) =>
        error.message === 'pageSize must be at most 50; page must be a number',
    );
  });

  it('survives an error with no code at all', () => {
    assert.throws(
      () =>
        assertNotAnError(400, {
          message: 'Mentions dictionary is not supported for YouTube',
          error: true,
          statusCode: 400,
        }),
      (error: ModashApiError) => error.code === undefined && error.status === 400,
    );
  });

  it('treats error: true as a failure even on a 200', () => {
    assert.throws(() => assertNotAnError(200, { error: true, code: 'no_result', message: 'none' }));
  });

  it('lets an ordinary success through', () => {
    assert.doesNotThrow(() => assertNotAnError(200, { error: false, total: 15 }));
  });
});

describe('credit ledger', () => {
  it('refuses a call that would breach the budget, before it is made', () => {
    const ledger = new CreditLedger(1);
    ledger.record('modash_get_creator_report', 'instagram/example', 1);
    assert.throws(() => ledger.assertAffordable(1), CreditBudgetExceededError);
    assert.equal(ledger.remaining, 0);
  });

  it('does not count free calls against the budget', () => {
    const ledger = new CreditLedger(1);
    for (let i = 0; i < 100; i += 1) ledger.record('modash_find_creator', 'lookup', 0);
    assert.equal(ledger.spent, 0);
    assert.equal(ledger.summary().freeCalls, 100);
  });

  it('keeps fractional credits exact enough to display', () => {
    const ledger = new CreditLedger(10);
    for (let i = 0; i < 3; i += 1) ledger.record('modash_search_creators', 'page', 0.15);
    assert.equal(ledger.spent, 0.45);
  });
});

describe('pricing', () => {
  it('prices a search page at 15 results', () => {
    assert.equal(searchCost(), 0.15);
  });

  it('prices AI search off pageSize, where the maximum beats a full report', () => {
    assert.equal(aiSearchCost(6), 0.15);
    assert.equal(aiSearchCost(50), 1.25);
  });
});

describe('search filters', () => {
  it('rejects a field the model invented rather than passing it to a billed request', () => {
    const result = searchFilterSchema.safeParse({ influencer: { minFollowers: 10_000 } });
    assert.equal(result.success, false);
    assert.match(JSON.stringify(result.error?.issues), /minFollowers/);
  });

  it('rejects a filter value of the wrong type', () => {
    const result = searchFilterSchema.safeParse({ influencer: { followers: { min: 'lots' } } });
    assert.equal(result.success, false);
  });

  it('accepts a well-formed filter', () => {
    const result = searchFilterSchema.safeParse({
      influencer: { followers: { min: 10_000, max: 500_000 }, location: [901] },
      audience: { gender: { id: 'FEMALE', weight: 0.6 } },
    });
    assert.equal(result.success, true);
  });

  it('catches an Instagram-only filter aimed at TikTok', () => {
    const problems = findPlatformMismatches({
      platform: 'tiktok',
      filter: { influencer: { brands: [100] } },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /brands is only supported on instagram/);
  });

  it('catches a sort field the platform does not have', () => {
    const problems = findPlatformMismatches({
      platform: 'instagram',
      sort: { field: 'views' },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /not available on instagram/);
  });

  it('leaves a matching platform alone', () => {
    assert.deepEqual(
      findPlatformMismatches({
        platform: 'instagram',
        filter: { influencer: { brands: [100] } },
        sort: { field: 'reelsPlays' },
      }),
      [],
    );
  });
});

describe('rate limiter', () => {
  it('spaces out calls on the same queue', async () => {
    const limiter = new RateLimiter(60);
    const startedAt: number[] = [];
    const record = async () => {
      startedAt.push(Date.now());
    };

    await Promise.all([limiter.run(record), limiter.run(record), limiter.run(record)]);

    assert.equal(startedAt.length, 3);
    assert.ok(startedAt[2]! - startedAt[0]! >= 100, 'three calls should span at least two gaps');
  });

  it('keeps running after one task rejects', async () => {
    const limiter = new RateLimiter(1);
    await assert.rejects(limiter.run(() => Promise.reject(new Error('boom'))));
    assert.equal(await limiter.run(() => Promise.resolve('fine')), 'fine');
  });
});

/**
 * Both of these are the same mistake in two places: a budget check that is not binding by the time
 * the money is spent. Neither was caught by the existing tests, which only ever made one call at a
 * time against a transport that always succeeded.
 */
describe('the budget holds under concurrency and retries', () => {
  it('does not let parallel calls both pass the same check', () => {
    const ledger = new CreditLedger(1);

    // Two calls reach the guard before either has recorded anything — the shape of two tool calls
    // arriving together, which is ordinary for an MCP server.
    const first = ledger.reserve(1);
    assert.throws(() => ledger.reserve(1), CreditBudgetExceededError);

    first.commit('modash_get_creator_report', 'instagram/example');
    assert.equal(ledger.spent, 1);
  });

  it('gives the hold back when the call fails, since Discovery does not bill failures', () => {
    const ledger = new CreditLedger(1);
    ledger.reserve(1).release();

    assert.equal(ledger.spent, 0);
    assert.equal(ledger.remaining, 1);
    assert.doesNotThrow(() => ledger.reserve(1));
  });

  it('counts an in-flight reservation against what is left', () => {
    const ledger = new CreditLedger(2);
    ledger.reserve(1.5);

    assert.equal(ledger.spent, 0, 'nothing is spent until it settles');
    assert.equal(ledger.remaining, 0.5, 'but it cannot be promised twice');
  });

  it('says when the shortfall is credits held rather than credits spent', () => {
    const ledger = new CreditLedger(2);
    ledger.reserve(2);

    // Nothing has been billed yet, so "0 already spent" on its own would read as a contradiction
    // and invite an immediate retry.
    assert.throws(
      () => ledger.reserve(1),
      /only 0 of the 2-credit session budget is left \(0 already spent, 2 held by calls still in flight\)/,
    );
  });

  it('leaves the message alone when nothing is in flight', () => {
    const ledger = new CreditLedger(1);
    ledger.record('modash_get_creator_report', 'instagram/example', 1);

    assert.throws(() => ledger.reserve(1), /\(1 already spent\)/);
  });

  it('settles a reservation once, however many times it is asked to', () => {
    const ledger = new CreditLedger(5);
    const hold = ledger.reserve(1);

    hold.commit('modash_get_creator_report', 'first');
    hold.commit('modash_get_creator_report', 'again');
    hold.release();

    assert.equal(ledger.spent, 1);
  });
});
