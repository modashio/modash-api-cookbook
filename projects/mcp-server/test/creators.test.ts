import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import {
  bundledSamplePath,
  COLUMNS,
  CreatorDataset,
  parseCreators,
} from '../src/creators/dataset.js';
import { lookupCreators, searchCreators } from '../src/creators/query.js';
import { createMcpHandler } from '../src/mcp/handler.js';

const baseConfig: Config = {
  mock: true,
  apiToken: undefined,
  baseUrl: 'https://api.modash.io/v1',
  creditBudget: 5,
  raw: false,
  rawBudget: 50,
  port: 0,
  httpHost: '127.0.0.1',
};

async function connect(config: Config = baseConfig) {
  const handler = createMcpHandler(config);
  const client = new Client(
    { name: 'modash-creator-tests', version: '1.0.0' },
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

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    text: (result.content as { type: string; text?: string }[])
      .map((block) => block.text ?? '')
      .join('\n'),
    data: result.structuredContent as Record<string, any> | undefined,
  };
}

const sampleText = readFileSync(bundledSamplePath(), 'utf8');
const sample = parseCreators(sampleText);

describe('bundled synthetic sample', () => {
  it('has every documented column, in order', () => {
    const header = sampleText.split('\n')[0]!.split(',');
    assert.deepEqual(header, [...COLUMNS]);
  });

  it('parses numbers, booleans and empty cells into typed values', () => {
    const threePlatform = sample.find((row) => row.n_platforms === 3)!;
    assert.equal(typeof threePlatform.max_followers, 'number');
    assert.equal(threePlatform.has_email, true);
    assert.equal(threePlatform.audience_top_country_share, 0.5);
    assert.equal(threePlatform.audience_top3_countries, 'BR:50%|PT:10%|US:10%');

    const igOnly = sample.find((row) => row.creator_id === 'syn_02')!;
    assert.equal(igOnly.tt_followers, null);
    assert.equal(igOnly.yt_handle, null);
  });

  it('covers the shapes the tools need to handle', () => {
    const only = (prefix: string) =>
      sample.some((row) => row.n_platforms === 1 && row[`${prefix}_handle` as 'ig_handle'] !== null);

    assert.ok(sample.length >= 20);
    assert.ok(sample.some((row) => row.n_platforms === 3));
    assert.ok(only('ig') && only('tt') && only('yt'));
    assert.ok(sample.some((row) => row.creator_country === null));
    assert.ok(sample.some((row) => row.has_email === true));
    assert.ok(sample.some((row) => row.has_email === false));
    assert.ok(sample.some((row) => row.yt_long_posts_sep26 !== null && row.yt_shorts_posts_sep26 !== null));
    assert.ok(sample.some((row) => row.ig_feed_posts_sep26 !== null && row.ig_reels_posts_sep26 !== null));
    assert.ok(sample.every((row) => (row.max_followers as number) >= 10_000_000));
  });

  it('contains only invented handles and names', () => {
    for (const row of sample) {
      assert.match(String(row.name), /^Synthetic Creator \d+$/);
      for (const column of ['ig_handle', 'tt_handle', 'yt_handle'] as const) {
        if (row[column] !== null) assert.match(String(row[column]), /^synthetic_(ig|tt|yt)_\d+$/);
      }
    }
  });
});

describe('CSV parsing', () => {
  it('handles quoted commas, escaped quotes, CRLF and a byte order mark', () => {
    const header = COLUMNS.join(',');
    const cells = COLUMNS.map((column) => (column === 'name' ? '"Doe, ""J"" Synthetic"' : ''));
    const rows = parseCreators(`\ufeff${header}\r\n${cells.join(',')}\r\n`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, 'Doe, "J" Synthetic');
  });

  it('names the missing columns', () => {
    assert.throws(() => parseCreators('creator_id,name\nsyn,Synthetic'), /missing columns: n_platforms/);
  });
});

describe('creator_lookup logic', () => {
  it('matches an exact handle on any platform, with or without @, ignoring case', () => {
    for (const query of ['synthetic_tt_07', '@Synthetic_TT_07']) {
      const rows = lookupCreators(sample, query);
      assert.deepEqual(rows.map((row) => row.creator_id), ['syn_07']);
    }
  });

  it('puts an exact handle ahead of name matches', () => {
    const rows = lookupCreators(sample, 'synthetic_yt_13');
    assert.equal(rows[0]!.creator_id, 'syn_13');
  });

  it('falls back to a case-insensitive name contains', () => {
    const rows = lookupCreators(sample, 'CREATOR 07');
    assert.deepEqual(rows.map((row) => row.creator_id), ['syn_07']);
  });

  it('never returns more than 5 rows', () => {
    assert.equal(lookupCreators(sample, 'synthetic creator').length, 5);
  });
});

describe('creator_search logic', () => {
  it('matches country by name or code and sorts descending', () => {
    const byName = searchCreators(sample, { country: 'united states' });
    const byCode = searchCreators(sample, { country: 'US' });
    assert.deepEqual(byName.rows, byCode.rows);
    assert.ok(byName.rows.length > 0);
    const followers = byName.rows.map((row) => row.max_followers as number);
    assert.deepEqual(followers, [...followers].sort((a, b) => b - a));
  });

  it('applies platform, followers, email and platform-count filters together', () => {
    const { rows } = searchCreators(sample, {
      platform: 'youtube',
      min_followers: 12_000_000,
      has_email: true,
      min_platforms: 1,
    });
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.notEqual(row.yt_handle, null);
      assert.ok((row.max_followers as number) >= 12_000_000);
      assert.equal(row.has_email, true);
    }
  });

  it('filters on audience country and sorts by another column', () => {
    const { rows } = searchCreators(sample, { audience_country: 'IN', sort_by: 'total_views_sep26' });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.audience_top_country_code === 'IN'));
    const views = rows.map((row) => row.total_views_sep26 as number);
    assert.deepEqual(views, [...views].sort((a, b) => b - a));
  });

  it('caps the limit at 5 and says when more matches exist', () => {
    const result = searchCreators(sample, { min_followers: 10_000_000, limit: 50 });
    assert.equal(result.rows.length, 5);
    assert.equal(result.moreMatchesExist, true);
  });
});

describe('creator tools over MCP', () => {
  const session = connect();
  after(async () => (await session).close());

  it('lists both tools as read-only, free and one-creator-at-a-time', async () => {
    const { client } = await session;
    const { tools } = await client.listTools();

    for (const name of ['creator_lookup', 'creator_search']) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      assert.ok(tool, `${name} is not registered`);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.match(tool.description!, /ONE creator at a time/);
      assert.match(tool.description!, /no credits/);
    }

    const search = tools.find((tool) => tool.name === 'creator_search')!;
    assert.match(search.description!, /creator_lookup/);
    assert.deepEqual(
      Object.keys((search.inputSchema as any).properties.filters.properties).sort(),
      [
        'audience_country',
        'country',
        'has_email',
        'limit',
        'min_followers',
        'min_platforms',
        'platform',
        'sort_by',
      ],
    );
  });

  it('exposes no export, offset or page parameter', async () => {
    const { client } = await session;
    const { tools } = await client.listTools();
    const schema = JSON.stringify(
      tools.filter((tool) => tool.name.startsWith('creator_')).map((tool) => tool.inputSchema),
    );
    assert.doesNotMatch(schema, /offset|page|export|cursor|skip/i);
  });

  it('finds one creator by exact handle and carries the note', async () => {
    const { client } = await session;
    const { isError, data } = await call(client, 'creator_lookup', { query: 'synthetic_ig_01' });
    assert.equal(isError, false);
    assert.equal(data?.['dataset'], 'bundled synthetic sample');
    assert.equal(data?.['returned'], 1);
    assert.equal(data?.['rows'][0].creator_id, 'syn_01');
    assert.equal(data?.['rows'][0].yt_long_posts_sep26, 4);
    assert.equal(Object.keys(data?.['rows'][0]).length, COLUMNS.length);
    assert.match(data?.['note'], /September 2026/);
    assert.match(data?.['note'], /lower bounds/);
    assert.match(data?.['note'], /Modash holds an email/);
  });

  it('finds creators by name, capped at 5 rows', async () => {
    const { client } = await session;
    const { data } = await call(client, 'creator_lookup', { query: 'synthetic creator' });
    assert.equal(data?.['rows'].length, 5);
  });

  it('rejects creator_search with no filters, even with only sort or limit', async () => {
    const { client } = await session;
    for (const args of [{}, { filters: {} }, { filters: { sort_by: 'total_views_sep26', limit: 5 } }]) {
      const result = await call(client, 'creator_search', args);
      assert.equal(result.isError, true);
      assert.match(result.text, /at least one of: country/);
    }
  });

  it('caps creator_search at 5 rows however many are requested', async () => {
    const { client } = await session;
    const { data } = await call(client, 'creator_search', {
      filters: { min_followers: 10_000_000, limit: 5 },
    });
    assert.equal(data?.['rows'].length, 5);
    assert.equal(data?.['moreMatchesExist'], true);

    const over = await client.callTool({
      name: 'creator_search',
      arguments: { filters: { min_followers: 10_000_000, limit: 500 } },
    });
    const rows = (over.structuredContent as Record<string, any>)['rows'];
    assert.ok(rows.length <= 5);
  });

  it('runs a filtered search end to end', async () => {
    const { client } = await session;
    const { data } = await call(client, 'creator_search', {
      filters: { platform: 'tiktok', has_email: true, sort_by: 'total_likes_sep26' },
    });
    assert.ok(data?.['rows'].length > 0);
    for (const row of data?.['rows']) {
      assert.notEqual(row.tt_handle, null);
      assert.equal(row.has_email, true);
    }
  });
});

describe('a private dataset path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-dataset-dir-'));
  const privateDirectory = join(directory, 'secret-folder-name');
  mkdirSync(privateDirectory);
  const path = join(privateDirectory, 'my-private-creators.csv');

  const header = COLUMNS.join(',');
  const row = COLUMNS.map((column) =>
    ({ creator_id: 'x1', name: 'Invented Person', max_followers: '12000000', ig_handle: 'invented_handle' })[
      column as string
    ] ?? '',
  ).join(',');
  writeFileSync(path, `${header}\n${row}\n`);

  const sensitive = [path, privateDirectory, basename(path), dirname(path)];

  const withCapturedConsole = async <T>(run: () => Promise<T>): Promise<{ value: T; logged: string }> => {
    const lines: string[] = [];
    const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
      console[name] = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    }
    try {
      return { value: await run(), logged: lines.join('\n') };
    } finally {
      Object.assign(console, originals);
    }
  };

  after(() => rmSync(directory, { recursive: true, force: true }));

  it('is read from CREATOR_DATASET_PATH', () => {
    assert.equal(loadConfig({ CREATOR_DATASET_PATH: path }).creatorDatasetPath, path);
    assert.equal(loadConfig({ CREATOR_DATASET_PATH: '' }).creatorDatasetPath, undefined);
    assert.equal(loadConfig({}).creatorDatasetPath, undefined);
  });

  it('serves that file and never echoes its path in results or logs', async () => {
    const { value, logged } = await withCapturedConsole(async () => {
      const session = await connect({ ...baseConfig, creatorDatasetPath: path });
      try {
        return [
          await call(session.client, 'creator_lookup', { query: 'invented_handle' }),
          await call(session.client, 'creator_lookup', { query: 'nobody-by-this-name' }),
          await call(session.client, 'creator_search', { filters: { min_followers: 1 } }),
          await call(session.client, 'creator_search', { filters: {} }),
        ];
      } finally {
        await session.close();
      }
    });

    assert.equal(value[0]!.data?.['dataset'], 'custom');
    assert.equal(value[0]!.data?.['rows'][0].name, 'Invented Person');
    assert.equal(value[2]!.data?.['returned'], 1);

    const everything = JSON.stringify(value) + logged;
    for (const secret of sensitive) assert.ok(!everything.includes(secret), `leaked ${secret}`);
  });

  it('fails without leaking the path when the file is missing or malformed', async () => {
    const malformed = join(privateDirectory, 'malformed.csv');
    writeFileSync(malformed, 'creator_id,name\nx,y\n');

    for (const candidate of [join(privateDirectory, 'does-not-exist.csv'), malformed]) {
      const session = await connect({ ...baseConfig, creatorDatasetPath: candidate });
      try {
        const result = await call(session.client, 'creator_lookup', { query: 'anything' });
        assert.equal(result.isError, true);
        assert.match(result.text, /could not be loaded/);
        for (const secret of [...sensitive, candidate, basename(candidate)]) {
          assert.ok(!result.text.includes(secret), `leaked ${secret}`);
        }
      } finally {
        await session.close();
      }
    }
  });

  it('loads the file once and reuses it', async () => {
    const dataset = new CreatorDataset(path);
    assert.equal(await dataset.load(), await dataset.load());
  });
});
