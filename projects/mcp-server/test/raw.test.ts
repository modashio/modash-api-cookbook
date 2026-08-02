import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { Config } from '../src/config.js';
import { createMcpHandler } from '../src/mcp/handler.js';
import { RawRequestLedger } from '../src/server/modash/budget.js';
import { ModashClient } from '../src/server/modash/client.js';
import { CreditLedger } from '../src/server/modash/budget.js';
import { callRaw, capArrays, findPageInfo, PROFILE_ENDPOINTS } from '../src/server/modash/raw.js';
import type { ModashHttpRequest, ModashHttpResponse, ModashTransport } from '../src/server/modash/transport.js';

const rawConfig: Config = {
  mock: true,
  apiToken: undefined,
  baseUrl: 'https://api.modash.io/v1',
  creditBudget: 5,
  raw: true,
  rawBudget: 10,
  port: 0,
  httpHost: '127.0.0.1',
};

async function connect(config: Config = rawConfig) {
  const handler = createMcpHandler(config);
  const client = new Client(
    { name: 'modash-raw-tests', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://tests.invalid/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return {
    client,
    async close() {
      await client.close();
      await handler.close();
    },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    text: (result.content as { text?: string }[]).map((block) => block.text ?? '').join('\n'),
    data: result.structuredContent as Record<string, any> | undefined,
  };
}

describe('RAW tools are opt-in', () => {
  it('stays out of the tool list unless MODASH_RAW is set', async () => {
    const session = await connect({ ...rawConfig, raw: false });
    const { tools } = await session.client.listTools();
    assert.equal(tools.filter((tool) => tool.name.startsWith('modash_raw_')).length, 0);
    assert.equal(tools.length, 12);
    await session.close();
  });

  it('adds six tools when it is', async () => {
    const session = await connect();
    const { tools } = await session.client.listTools();
    assert.deepEqual(
      tools.filter((tool) => tool.name.startsWith('modash_raw_')).map((tool) => tool.name).sort(),
      [
        'modash_raw_browse',
        'modash_raw_get_post',
        'modash_raw_get_profile',
        'modash_raw_list_comments',
        'modash_raw_list_posts',
        'modash_raw_search',
      ],
    );
    assert.equal(tools.length, 18);
    await session.close();
  });
});

describe('RAW tools', () => {
  const session = connect();
  after(async () => (await session).close());

  it('reports its spend in requests, not credits', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_raw_get_profile', {
      platform: 'instagram',
      creator: 'atlas.brews',
    });

    assert.equal(data?.['spend'].rawRequestsThisCall, 1);
    assert.equal(data?.['spend'].rawRequestsRemainingInBudget, 9);

    // The credit ledger must not have moved: these are separate allowances.
    const account = await call(client, 'modash_get_account');
    assert.equal(account.data?.['session'].spent, 0);
  });

  it('passes the payload through as the platform returned it', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_raw_get_profile', {
      platform: 'instagram',
      creator: 'atlas.brews',
    });

    // Instagram's profile endpoint has no envelope at all — the object is the response.
    assert.equal(data?.['data'].username, 'atlas.brews');
    assert.equal(data?.['data'].pk, 'mock-3');
  });

  /**
   * The three platforms name their cursor `end_cursor`, `maxCursor`, and a `cursor` nested one
   * level down. A caller should not have to know which, so the tools surface one `nextCursor`.
   */
  it('finds the cursor whatever the platform calls it', async () => {
    const { client } = await session;

    const instagram = await call(client, 'modash_raw_list_posts', {
      platform: 'instagram',
      creator: 'atlas.brews',
    });
    assert.equal(instagram.data?.['nextCursor'], 'mock-ig-cursor');
    assert.equal(instagram.data?.['hasMore'], true);

    const tiktok = await call(client, 'modash_raw_list_posts', {
      platform: 'tiktok',
      creator: 'atlas.brews',
    });
    assert.equal(tiktok.data?.['nextCursor'], 'mock-tt-cursor');

    const youtube = await call(client, 'modash_raw_list_posts', {
      platform: 'youtube',
      creator: 'atlas.brews',
    });
    assert.equal(youtube.data?.['nextCursor'], 'mock-yt-cursor');
  });

  it('caps long lists locally and says that it did', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_raw_list_posts', {
      platform: 'instagram',
      creator: 'atlas.brews',
      maxItems: 3,
    });

    assert.equal(data?.['data'].items.length, 3);
    assert.equal(data?.['capped'], true);
  });

  it('refuses a platform that has no endpoint for the job, without spending anything', async () => {
    const { client } = await session;
    const before = await call(client, 'modash_raw_get_profile', {
      platform: 'instagram',
      creator: 'atlas.brews',
    });
    const spentBefore = before.data?.['spend'].rawRequestsThisSession;

    const tagged = await call(client, 'modash_raw_list_posts', {
      platform: 'youtube',
      creator: 'atlas.brews',
      kind: 'tagged',
    });
    assert.equal(tagged.isError, true);
    assert.match(tagged.text, /no "tagged" endpoint for youtube.*instagram/s);

    const hashtags = await call(client, 'modash_raw_search', {
      platform: 'youtube',
      kind: 'hashtags',
      keyword: 'coffee',
    });
    assert.equal(hashtags.isError, true);

    const after_ = await call(client, 'modash_raw_get_profile', {
      platform: 'instagram',
      creator: 'atlas.brews',
    });
    // Two rejections plus the one probe above: only the probes were billed.
    assert.equal(after_.data?.['spend'].rawRequestsThisSession, spentBefore + 1);
  });
});

/**
 * The difference that matters most between the two products, asserted directly: Discovery does not
 * bill a failed call and RAW does. Getting this backwards means a ledger that quietly under-reports
 * exactly when a model is flailing at a bad URL.
 */
describe('a failed RAW call still costs a request', () => {
  it('charges for an identifier the platform cannot resolve', async () => {
    const session = await connect();
    const good = await call(session.client, 'modash_raw_get_profile', {
      platform: 'instagram',
      creator: 'atlas.brews',
    });
    const spentBefore = good.data?.['spend'].rawRequestsThisSession as number;

    const bad = await call(session.client, 'modash_raw_get_profile', {
      platform: 'instagram',
      creator: 'not-a-real-handle',
    });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /bad_request/);

    const afterFailure = await call(session.client, 'modash_raw_get_profile', {
      platform: 'instagram',
      creator: 'atlas.brews',
    });
    // Two requests since the first probe: the failure counted, and so did this one.
    assert.equal(afterFailure.data?.['spend'].rawRequestsThisSession, spentBefore + 2);

    await session.close();
  });
});

describe('failed RAW requests are still billed', () => {
  class FailingTransport implements ModashTransport {
    async send(_request: ModashHttpRequest): Promise<ModashHttpResponse> {
      return { status: 400, body: { error: true, code: 'bad_request', message: 'Bad URL' } };
    }
  }

  it('records the attempt when the call fails', async () => {
    const credits = new CreditLedger(5);
    const rawRequests = new RawRequestLedger(10);
    const client = new ModashClient(new FailingTransport(), { credits, rawRequests });

    await assert.rejects(
      callRaw(client, {
        endpoint: PROFILE_ENDPOINTS.instagram!,
        target: 'nonsense',
        tool: 'modash_raw_get_profile',
      }),
    );

    assert.equal(rawRequests.spent, 1, 'a failed RAW request comes out of the allowance');
    assert.equal(credits.spent, 0, 'and never out of the credit balance');
  });

  it('refuses a call that would breach the RAW budget, before sending it', async () => {
    const credits = new CreditLedger(5);
    const rawRequests = new RawRequestLedger(1);
    const client = new ModashClient(new FailingTransport(), { credits, rawRequests });

    const call1 = callRaw(client, {
      endpoint: PROFILE_ENDPOINTS.instagram!,
      target: 'nonsense',
      tool: 'modash_raw_get_profile',
    });
    await assert.rejects(call1);
    assert.equal(rawRequests.spent, 1);

    await assert.rejects(
      callRaw(client, {
        endpoint: PROFILE_ENDPOINTS.instagram!,
        target: 'nonsense',
        tool: 'modash_raw_get_profile',
      }),
      /RAW request/,
    );
    // The refusal is local, so the count does not move.
    assert.equal(rawRequests.spent, 1);
  });
});

describe('successful RAW requests stay off the Discovery free-call counter', () => {
  class OkTransport implements ModashTransport {
    async send(_request: ModashHttpRequest): Promise<ModashHttpResponse> {
      return { status: 200, body: { error: false, items: [] } };
    }
  }

  it('does not inflate freeCalls on the credit ledger', async () => {
    const credits = new CreditLedger(5);
    const rawRequests = new RawRequestLedger(10);
    const client = new ModashClient(new OkTransport(), { credits, rawRequests });

    await callRaw(client, {
      endpoint: PROFILE_ENDPOINTS.instagram!,
      target: 'atlas.brews',
      tool: 'modash_raw_get_profile',
    });

    assert.equal(rawRequests.spent, 1);
    assert.equal(credits.spent, 0);
    assert.equal(credits.summary().freeCalls, 0);
  });
});

/**
 * Every RAW attempt is billed, retries included, so checking the ceiling once for a single request
 * and then retrying twice would spend three times what the guard approved.
 */
describe('RAW retries stay inside the budget', () => {
  class AlwaysFailingTransport implements ModashTransport {
    attempts = 0;
    async send(_request: ModashHttpRequest): Promise<ModashHttpResponse> {
      this.attempts += 1;
      // A 500 is retryable, which is what makes this the dangerous case.
      return { status: 500, body: {} };
    }
  }

  it('stops retrying rather than overspending', async () => {
    const transport = new AlwaysFailingTransport();
    const rawRequests = new RawRequestLedger(2);
    const client = new ModashClient(transport, { credits: new CreditLedger(5), rawRequests });

    await assert.rejects(
      callRaw(client, {
        endpoint: PROFILE_ENDPOINTS.instagram!,
        target: 'atlas.brews',
        tool: 'modash_raw_get_profile',
      }),
    );

    // Three attempts are allowed, but only two are affordable.
    assert.equal(transport.attempts, 2);
    assert.equal(rawRequests.spent, 2);
    assert.ok(rawRequests.spent <= rawRequests.budget, 'the ceiling has to hold');
  });

  it('charges every attempt when the budget covers them', async () => {
    const transport = new AlwaysFailingTransport();
    const rawRequests = new RawRequestLedger(10);
    const client = new ModashClient(transport, { credits: new CreditLedger(5), rawRequests });

    await assert.rejects(
      callRaw(client, {
        endpoint: PROFILE_ENDPOINTS.instagram!,
        target: 'atlas.brews',
        tool: 'modash_raw_get_profile',
      }),
    );

    assert.equal(transport.attempts, 3);
    assert.equal(rawRequests.spent, 3);
  });
});

describe('page info extraction', () => {
  it('reads the three cursor spellings the API actually uses', () => {
    assert.deepEqual(findPageInfo({ items: [], more_available: true, end_cursor: 'a' }), {
      nextCursor: 'a',
      hasMore: true,
    });
    assert.deepEqual(findPageInfo({ success: true, hasMore: false, maxCursor: 'b' }), {
      nextCursor: 'b',
      hasMore: false,
    });
    assert.deepEqual(findPageInfo({ success: true, videos_list: { cursor: 'c' } }), {
      nextCursor: 'c',
    });
  });

  it('ignores an empty cursor, which is how the last page is signalled', () => {
    assert.deepEqual(findPageInfo({ items: [], end_cursor: '' }), {});
  });

  it('does not invent a cursor for a response that has none', () => {
    assert.deepEqual(findPageInfo({ pk: '1', username: 'someone' }), {});
  });
});

describe('capArrays', () => {
  it('leaves a short list alone', () => {
    const { value, capped } = capArrays({ items: [1, 2] }, 10);
    assert.deepEqual(value, { items: [1, 2] });
    assert.equal(capped, false);
  });

  it('trims nested lists and reports it', () => {
    const { value, capped } = capArrays({ a: { b: [1, 2, 3, 4] } }, 2);
    assert.deepEqual(value, { a: { b: [1, 2] } });
    assert.equal(capped, true);
  });

  it('leaves non-list values untouched', () => {
    assert.deepEqual(capArrays({ n: 1, s: 'x', b: true, nil: null }, 1).value, {
      n: 1,
      s: 'x',
      b: true,
      nil: null,
    });
  });
});
