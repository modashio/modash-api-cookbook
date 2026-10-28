import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { Config } from '../src/config.js';
import { createMcpHandler } from '../src/mcp/handler.js';

/**
 * End-to-end tests over the real MCP protocol: a real client, the real handler, and mock mode
 * underneath. No token, no network, no credits — which is what makes it safe to run in CI.
 *
 * `handler.fetch` is a web-standard `(Request) => Response`, so the HTTP client transport can be
 * pointed straight at it with no port and no listening socket.
 */
const mockConfig: Config = {
  mock: true,
  apiToken: undefined,
  baseUrl: 'https://api.modash.io/v1',
  creditBudget: 5,
  raw: false,
  rawBudget: 50,
  port: 0,
  httpHost: '127.0.0.1',
};

async function connect(config: Config = mockConfig) {
  const handler = createMcpHandler(config);
  const client = new Client(
    { name: 'modash-mcp-tests', version: '1.0.0' },
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

/** Tools return their payload as structured content; this is just the ergonomic way to read it. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    text: (result.content as { type: string; text?: string }[])
      .map((block) => block.text ?? '')
      .join('\n'),
    data: result.structuredContent as Record<string, any> | undefined,
  };
}

describe('server surface', () => {
  const session = connect();
  after(async () => (await session).close());

  it('exposes a tool list small enough for a model to choose from', async () => {
    const { client } = await session;
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      'modash_ai_search_creators',
      'modash_brand_crossover',
      'modash_compare_audience_overlap',
      'modash_find_creator',
      'modash_find_creators_by_email',
      'modash_find_lookalikes',
      'modash_get_account',
      'modash_get_creator_report',
      'modash_list_collaborations',
      'modash_lookup_ai_dictionary',
      'modash_lookup_dictionary',
      'modash_plan_brand_crossover',
      'modash_search_creators',
      'modash_summarise_collaborations',
    ]);
  });

  it('describes every tool, including what it costs', async () => {
    const { client } = await session;
    const { tools } = await client.listTools();

    for (const tool of tools) {
      assert.ok(tool.description, `${tool.name} has no description`);
      assert.ok(tool.annotations?.readOnlyHint, `${tool.name} should be marked read-only`);
      assert.match(
        tool.description,
        /credit/i,
        `${tool.name} should say what it costs, even if that is nothing`,
      );
    }
  });

  it('publishes the pricing table and the live budget as resources', async () => {
    const { client } = await session;
    const { resources } = await client.listResources();
    assert.deepEqual(
      resources.map((resource) => resource.uri).sort(),
      ['modash://budget', 'modash://pricing'],
    );
  });

  it('offers a cost-aware shortlisting prompt', async () => {
    const { client } = await session;
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((prompt) => prompt.name), ['shortlist-creators']);

    const prompt = await client.getPrompt({
      name: 'shortlist-creators',
      arguments: { brief: 'speciality coffee in London', platform: 'instagram' },
    });
    const text = JSON.stringify(prompt.messages);
    assert.match(text, /speciality coffee in London/);
    assert.match(text, /modash_lookup_dictionary/);
  });
});

describe('free tools spend nothing', () => {
  const session = connect();
  after(async () => (await session).close());

  it('reports the account and the session budget', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_get_account');

    assert.equal(data?.['mode'], 'mock');
    assert.equal(data?.['session'].budget, 5);
    assert.equal(data?.['session'].spent, 0);
  });

  it('resolves a handle without spending a credit', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_find_creator', {
      platform: 'instagram',
      query: '@fernandfig',
    });

    assert.equal(data?.['creators'][0].username, 'fernandfig');

    const account = await call(client, 'modash_get_account');
    assert.equal(account.data?.['session'].spent, 0);
  });

  it('returns dictionary ids, not names', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_lookup_dictionary', {
      platform: 'instagram',
      kind: 'locations',
      query: 'London',
    });

    assert.equal(data?.['items'][0].id, 901);
    assert.match(data?.['items'][0].title, /United Kingdom/);
  });

  it('explains that interests are an Instagram-only dictionary', async () => {
    const { client } = await session;
    const result = await call(client, 'modash_lookup_dictionary', {
      platform: 'tiktok',
      kind: 'interests',
    });

    assert.equal(result.isError, true);
    assert.match(result.text, /only publishes the interests dictionary for Instagram/);
  });
});

describe('paid tools report and meter their cost', () => {
  const session = connect();
  after(async () => (await session).close());

  it('charges a search 0.15 credits and says so in the result', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_search_creators', {
      platform: 'instagram',
      filter: { influencer: { followers: { min: 50_000 } } },
    });

    assert.equal(data?.['cost'].creditsThisCall, 0.15);
    assert.equal(data?.['cost'].creditsSpentThisSession, 0.15);
    assert.equal(data?.['cost'].creditsRemainingInBudget, 4.85);
    assert.equal(data?.['creators'].length, 5);
    assert.equal(data?.['isExactMatch'], true);
  });

  it('prices AI search off pageSize', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_ai_search_creators', {
      platform: 'instagram',
      query: 'pour-over coffee filmed on a kitchen counter',
      pageSize: 4,
    });

    assert.equal(data?.['cost'].creditsThisCall, 0.1);
    assert.equal(data?.['creators'].length, 4);
  });

  it('summarises a report rather than returning all of it', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_get_creator_report', {
      platform: 'instagram',
      userId: 'atlas.brews',
    });

    assert.equal(data?.['cost'].creditsThisCall, 1);
    assert.equal(data?.['creator'].username, 'atlas.brews');
    assert.equal(data?.['audience'].credibility, 0.86);
    assert.ok(data?.['audience'].countries.length > 0);
    // Optional sections stay out of the response until they are asked for.
    assert.deepEqual(data?.['sections'], {});
  });

  it('returns optional report sections on request', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_get_creator_report', {
      platform: 'instagram',
      userId: 'atlas.brews',
      include: ['recentPosts', 'followerHistory'],
    });

    assert.deepEqual(Object.keys(data?.['sections']).sort(), ['followerHistory', 'recentPosts']);
    assert.equal(data?.['sections'].followerHistory.length, 3);
  });
});

describe('the budget is a stop, not a report', () => {
  it('refuses the call that would breach it and leaves the total untouched', async () => {
    const session = await connect({ ...mockConfig, creditBudget: 1.1 });

    const first = await call(session.client, 'modash_get_creator_report', {
      platform: 'instagram',
      userId: 'atlas.brews',
    });
    assert.equal(first.isError, false);

    const second = await call(session.client, 'modash_get_creator_report', {
      platform: 'instagram',
      userId: 'mira.makes',
    });
    assert.equal(second.isError, true);
    assert.match(second.text, /Budget stop/);

    const account = await call(session.client, 'modash_get_account');
    assert.equal(account.data?.['session'].spent, 1);

    await session.close();
  });
});

describe('the budget holds when tool calls arrive together', () => {
  it('lets exactly as many parallel calls through as the budget covers', async () => {
    const session = await connect({ ...mockConfig, creditBudget: 2 });

    // Five reports at 1 credit each, all in flight before any of them has recorded a thing. Under
    // a check-then-record guard they would all pass and the session would land at 5.
    const results = await Promise.all(
      ['atlas.brews', 'fernandfig', 'mira.makes', 'northlight.studio', 'quietloud.audio'].map(
        (userId) => call(session.client, 'modash_get_creator_report', { platform: 'instagram', userId }),
      ),
    );

    assert.equal(results.filter((result) => !result.isError).length, 2);
    assert.equal(results.filter((result) => result.isError).length, 3);
    for (const failure of results.filter((result) => result.isError)) {
      assert.match(failure.text, /Budget stop/);
    }

    const account = await call(session.client, 'modash_get_account');
    assert.equal(account.data?.['session'].spent, 2);

    await session.close();
  });
});

describe('bad input is caught before it is billed', () => {
  const session = connect();
  after(async () => (await session).close());

  it('rejects a filter field the model invented', async () => {
    const { client } = await session;
    const result = await call(client, 'modash_search_creators', {
      platform: 'instagram',
      filter: { influencer: { minFollowers: 10_000 } },
    });

    assert.equal(result.isError, true);
    assert.match(result.text, /minFollowers/);
  });

  it('rejects an Instagram-only filter aimed at TikTok', async () => {
    const { client } = await session;
    const result = await call(client, 'modash_search_creators', {
      platform: 'tiktok',
      filter: { influencer: { brands: [100] } },
    });

    assert.equal(result.isError, true);
    assert.match(result.text, /only supported on instagram/);
  });

  it('spends nothing on either rejection', async () => {
    const { client } = await session;
    const account = await call(client, 'modash_get_account');
    assert.equal(account.data?.['session'].spent, 0);
  });

  it('passes the Modash error code through when the API rejects a request', async () => {
    const { client } = await session;
    const result = await call(client, 'modash_get_creator_report', {
      platform: 'instagram',
      userId: 'nobody-by-that-name',
    });

    assert.equal(result.isError, true);
    assert.match(result.text, /account_not_found/);
  });

  it('does not bill a failed call', async () => {
    const { client } = await session;
    const account = await call(client, 'modash_get_account');
    assert.equal(account.data?.['session'].spent, 0);
  });
});
