import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { liveTransport, ModashClient, type ModashResponse, type Transport } from '../src/modash/client.js';
import { CreditBudgetExceededError, ModashApiError, NoAnswerError, stopsTheRun } from '../src/modash/errors.js';
import { loadFixtures, mockTransport } from '../src/modash/mock.js';
import { modashReads } from '../src/modash/reads.js';
import { emailSearchResponseSchema } from '../src/modash/responses.js';
import { round2 } from '../src/numbers.js';

const matched = (...emails: string[]): ModashResponse => ({
  status: 200,
  body: { error: false, matchedEmails: emails.map((email) => ({ email, users: [] })), totalMatches: emails.length },
});

/** A transport that gives the queued answers in order; an Error in the queue is thrown. */
function queued(...answers: (ModashResponse | Error)[]) {
  let sent = 0;
  const transport: Transport = async () => {
    const answer = answers[sent]!;
    sent += 1;
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  return { transport, sent: () => sent };
}

const client = (transport: Transport, budget = 50) => new ModashClient(transport, { budget, pauseMs: 0, retryDelayMs: 0 });
const threeEmails = ['a@example.com', 'b@example.com', 'c@example.com'];

/** Runs `work` with `fetch` replaced, and puts the real one back. */
async function withFetch(fake: typeof fetch, work: () => Promise<void>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    await work();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('errors and credits', () => {
  it('charges 0.02 per matched email, not per email sent', async () => {
    const c = client(queued(matched('a@example.com')).transport);
    await modashReads(c).searchEmails(threeEmails);
    assert.equal(round2(c.spent), 0.02);
    assert.equal(round2(c.unconfirmed), 0);
  });

  it('charges the higher of totalMatches and the matches returned', async () => {
    for (const totalMatches of [0, 2]) {
      const c = client(queued({ status: 200, body: { matchedEmails: [{ email: 'a@example.com' }], totalMatches } }).transport);
      await modashReads(c).searchEmails(threeEmails);
      assert.equal(round2(c.spent), totalMatches === 2 ? 0.04 : 0.02);
    }
  });

  it('holds 0.02 per email sent before the call, and stops before a call the budget cannot cover', async () => {
    const { transport, sent } = queued(matched());
    const c = client(transport, 0.05);
    await assert.rejects(modashReads(c).searchEmails(threeEmails), CreditBudgetExceededError);
    assert.equal(sent(), 0);
    assert.equal(c.spent, 0);
  });

  it('counts the hold as unconfirmed while the call is out', async () => {
    let c: ModashClient;
    const transport: Transport = async () => {
      assert.equal(round2(c.unconfirmed), 0.06);
      return matched();
    };
    c = client(transport);
    await modashReads(c).searchEmails(threeEmails);
    assert.equal(round2(c.unconfirmed), 0);
  });

  it('sends a call again after a 429, then succeeds', async () => {
    const { transport, sent } = queued({ status: 429, body: {} }, { status: 429, body: {} }, matched());
    assert.deepEqual(await modashReads(client(transport)).searchEmails(['a@example.com']), []);
    assert.equal(sent(), 3);
  });

  it('gives the hold back when the API still answers 429 after the last try', async () => {
    const busy = { status: 429, body: {} };
    const { transport, sent } = queued(busy, busy, busy, busy, busy);
    const c = client(transport);
    await assert.rejects(modashReads(c).searchEmails(['a@example.com']), ModashApiError);
    assert.equal(sent(), 5);
    assert.equal(c.spent, 0);
  });

  it('does not send a call again after a server error, and keeps its hold as unconfirmed', async () => {
    for (const status of [500, 502, 503, 504]) {
      const { transport, sent } = queued({ status, body: {} }, matched());
      const c = client(transport);
      await assert.rejects(modashReads(c).searchEmails(['a@example.com', 'b@example.com']), ModashApiError);
      assert.equal(sent(), 1);
      assert.equal(c.spent, 0.04);
      assert.equal(c.unconfirmed, 0.04);
    }
  });

  it('does not send a call again when no answer came back, and keeps its hold as unconfirmed', async () => {
    const { transport, sent } = queued(new NoAnswerError('email-search', new Error('timed out')), matched());
    const c = client(transport);
    await assert.rejects(modashReads(c).searchEmails(['a@example.com']), NoAnswerError);
    assert.equal(sent(), 1);
    assert.equal(c.spent, 0.02);
    assert.equal(c.unconfirmed, 0.02);
  });

  it('gives the hold back when the API refuses the call', async () => {
    const c = client(queued({ status: 400, body: { error: true, code: 'not_enough_credits', message: 'Not enough credits' } }).transport);
    await assert.rejects(modashReads(c).searchEmails(['a@example.com']), (error: unknown) => error instanceof ModashApiError && error.isFatal);
    assert.equal(c.spent, 0);
    assert.equal(c.unconfirmed, 0);
  });

  it('keeps the hold as unconfirmed for a 200 that carries an error', async () => {
    const c = client(queued({ status: 200, body: { error: true, code: 'example_error' } }).transport);
    await assert.rejects(modashReads(c).searchEmails(['a@example.com']), ModashApiError);
    assert.equal(c.spent, 0.02);
    assert.equal(c.unconfirmed, 0.02);
  });

  it('stops the run on a refused token, an empty balance, a spent budget, or an answer it cannot read', () => {
    assert.ok(stopsTheRun(new ModashApiError('email-search', 401, undefined, '')));
    assert.ok(stopsTheRun(new ModashApiError('email-search', 403, undefined, '')));
    assert.ok(stopsTheRun(new ModashApiError('email-search', 400, 'not_enough_credits', '')));
    assert.ok(stopsTheRun(new ModashApiError('email-search', 200, 'unexpected_response', '')));
    assert.ok(stopsTheRun(new CreditBudgetExceededError(1, 1)));
    assert.ok(!stopsTheRun(new ModashApiError('email-search', 500, undefined, '')));
    assert.ok(!stopsTheRun(new NoAnswerError('email-search', new Error('timed out'))));
  });

  it('reads a field of an unexpected type as missing, so a paid answer is not thrown away', () => {
    const parsed = emailSearchResponseSchema.parse({
      matchedEmails: [{ email: 'a@example.com', users: [{ platform: 'instagram', userId: 7, followers: '12k', isVerified: 'yes' }] }],
    });
    assert.deepEqual(parsed.matchedEmails[0]?.users?.[0], { platform: 'instagram', userId: '7', followers: null, isVerified: null });
  });

  it('reports a page that is not JSON as an error, not as an empty answer', async () => {
    await withFetch(
      async () => new Response('<html>Bad gateway</html>', { status: 200 }),
      async () => {
        const c = new ModashClient(liveTransport('test-token'), { budget: 50, pauseMs: 0 });
        await assert.rejects(modashReads(c).searchEmails(['a@example.com']), /not_json/);
      },
    );
  });

  it('reports a connection that drops, before or during the answer, as no answer', async () => {
    const dropsMidBody = new Response(new ReadableStream({ start: (controller) => controller.error(new TypeError('terminated')) }));
    for (const fake of [async () => Promise.reject(new TypeError('fetch failed')), async () => dropsMidBody]) {
      await withFetch(fake, async () => {
        await assert.rejects(liveTransport('test-token')({ path: 'email-search', body: {} }), NoAnswerError);
      });
    }
  });
});

describe('mock mode', () => {
  it('answers email search in the shape the API returns, and matches only the invented emails', async () => {
    const fixtures = loadFixtures();
    const response = await mockTransport(fixtures)({ path: 'email-search', body: { emails: ['baker@example.com', 'nobody@example.org'] } });
    assert.deepEqual(response.body, {
      error: false,
      matchedEmails: [{ email: 'baker@example.com', users: fixtures['baker@example.com'] }],
      notMatchedEmails: ['nobody@example.org'],
      totalMatches: 1,
    });
  });

  it('stops on a call this project does not make', async () => {
    await assert.rejects(mockTransport(loadFixtures())({ path: 'user/info', body: {} }), /no answer for "user\/info"/);
  });
});
