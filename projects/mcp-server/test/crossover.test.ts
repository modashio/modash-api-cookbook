import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import {
  type BrandPull,
  buildWindow,
  ceilingFor,
  cheaperOptions,
  type CrossoverOptions,
  comparePair,
  pickWeeks,
  readComparison,
  sample,
  seededRandom,
  snapFollowers,
} from '../src/analysis/brand-crossover.js';
import type { Config } from '../src/config.js';
import { createMcpHandler } from '../src/mcp/handler.js';

const DAY_MS = 86_400_000;

describe('the window and the week sample', () => {
  it('splits a year into 52 full weeks and one short one, with inclusive ends', () => {
    const window = buildWindow(365, '2026-01-05');
    assert.equal(window.weeks.length, 53);
    assert.equal(window.weeks[0]!.from, Date.parse('2025-01-05T00:00:00Z'));
    assert.equal(window.weeks[0]!.to, window.weeks[1]!.from - 1);
    assert.equal(window.weeks.at(-1)!.to - window.weeks.at(-1)!.from + 1, DAY_MS);
    assert.equal(window.to, Date.parse('2026-01-05T00:00:00Z') - 1);
  });

  it('rejects an end date that is not a date', () => {
    assert.throws(() => buildWindow(30, '2026-13-45'), /not a YYYY-MM-DD date/);
  });

  it('spreads sampled weeks evenly, and pulls everything when asked for as many weeks as exist', () => {
    const { weeks } = buildWindow(365, '2026-01-05');
    const picked = pickWeeks(weeks, 4);
    assert.deepEqual(
      picked.map((week) => weeks.indexOf(week)),
      [6, 19, 33, 46],
    );
    assert.equal(pickWeeks(weeks, 53).length, 53);
    assert.equal(pickWeeks(weeks, 99).length, 53);
  });
});

const defaults: CrossoverOptions = {
  platform: 'instagram',
  brandA: 'a.example',
  brandB: 'b.example',
  baseline: ['c.example', 'd.example'],
  windowDays: 365,
  sampleWeeks: 6,
  maxPagesPerWeek: 3,
  maxCrossoverLookups: 150,
  baseSampleSize: 150,
  seed: 1,
};

describe('the cost ceiling', () => {
  it('prices every sampled week at its page cap, per brand', () => {
    const ceiling = ceilingFor(defaults, 4, 6);
    assert.equal(ceiling.postsCredits, 14.4); // 4 brands x 6 weeks x 3 pages x 0.2
    assert.equal(ceiling.lookupCredits, 0);
    assert.equal(ceiling.totalCredits, 14.4);
    assert.equal(ceiling.paidCalls, 72);
  });

  it('adds full AI Search pages for the lookup step, per pair', () => {
    const ceiling = ceilingFor({ ...defaults, location: 'United States' }, 4, 6);
    // 300 ids per pair is 6 pages of 50 at 1.25 credits, for 2 pairs.
    assert.equal(ceiling.lookupCredits, 15);
    assert.equal(ceiling.totalCredits, 29.4);
  });

  it('puts a full year of every week for two pairs well past a 200-credit budget at a high page cap', () => {
    assert.ok(ceilingFor({ ...defaults, maxPagesPerWeek: 20 }, 4, 53).totalCredits > 200);
  });

  it('offers the largest week sample that fits what is left', () => {
    const options = cheaperOptions({ ...defaults, sampleWeeks: 53 }, 53, 10);
    const fit = options.find((option) => option.change.startsWith('sampleWeeks: 4 '));
    assert.ok(fit, JSON.stringify(options));
    assert.ok(fit.ceilingCredits <= 10);
    assert.ok(options.some((option) => option.change === 'windowDays: 90'));
  });
});

describe('small helpers', () => {
  it('snaps a follower minimum down to the documented rungs', () => {
    assert.equal(snapFollowers(12_000), 10_000);
    assert.equal(snapFollowers(10_000), 10_000);
    assert.equal(snapFollowers(400), 1_000);
  });

  it('draws the same sample from the same seed', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    assert.deepEqual(sample(items, 10, seededRandom(7)), sample(items, 10, seededRandom(7)));
    assert.notDeepEqual(sample(items, 10, seededRandom(7)), sample(items, 10, seededRandom(8)));
    assert.equal(new Set(sample(items, 100, seededRandom(1))).size, 100);
  });
});

const pull = (name: string, creators: Record<string, number>): BrandPull => ({
  brand: { input: name, brandId: name, name, matchedBy: 'name', alternatives: [] },
  creators: new Map(Object.entries(creators).map(([id, posts]) => [id, { username: `user.${id}`, posts }])),
  posts: Object.values(creators).reduce((sum, posts) => sum + posts, 0),
  otherPlatformPosts: 0,
  pages: 1,
  weeksWithPosts: 1,
  truncatedWeeks: 0,
});

describe('crossover arithmetic', () => {
  it('counts the crossover against the base, and each side against its own creators', () => {
    const { result, bothIds, eitherOnlyIds } = comparePair(
      pull('A', { '1': 1, '2': 3, '3': 1, '4': 1 }),
      pull('B', { '3': 2, '4': 1, '5': 1, '6': 1, '7': 1, '8': 1 }),
    );
    assert.deepEqual(bothIds, ['3', '4']);
    assert.equal(eitherOnlyIds.length, 6);
    assert.equal(result.either, 8);
    assert.equal(result.both, 2);
    assert.equal(result.crossoverShare, 0.25);
    assert.equal(result.shareOfAAlsoB, 0.5);
    assert.equal(result.shareOfBAlsoA, 0.3333);
    assert.equal(result.exampleCrossoverCreators[0]!.username, 'user.3');
  });

  it('reads a lower rival share than baseline as picking a side', () => {
    const { ratio, reading } = readComparison({ share: 0.05, both: 200 }, { share: 0.1, both: 300 });
    assert.equal(ratio, 0.5);
    assert.match(reading, /picking a side/);
  });

  it('refuses to read a difference built on a handful of creators', () => {
    assert.match(readComparison({ share: 0.05, both: 4 }, { share: 0.1, both: 300 }).reading, /mostly noise/);
  });

  it('says plainly that a share without a baseline answers nothing', () => {
    assert.match(readComparison({ share: 0.05, both: 200 }).reading, /No baseline/);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end, over MCP, in mock mode
// ---------------------------------------------------------------------------------------------

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

async function connect(config: Config) {
  const handler = createMcpHandler(config);
  const client = new Client({ name: 'crossover-tests', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
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
    text: (result.content as { type: string; text?: string }[]).map((block) => block.text ?? '').join('\n'),
    data: result.structuredContent as Record<string, any> | undefined,
  };
}

const spent = async (client: Client) => (await call(client, 'modash_get_account')).data?.['session'].spent;

const question = {
  brandA: 'northpath.example',
  brandB: 'https://www.summitline.example/',
  baseline: ['Tidewater Coffee', 'pixelforge.example'],
  endDate: '2026-01-05',
};

describe('planning is free and honest about the budget', () => {
  const session = connect(mockConfig);
  after(async () => (await session).close());

  it('resolves domains and names, and flags a domain that matches more than one brand', async () => {
    const { client } = await session;
    const { isError, data, text } = await call(client, 'modash_plan_brand_crossover', question);
    assert.equal(isError, false, text);

    assert.deepEqual(
      data?.['brands'].map((brand: { name: string; matchedBy: string }) => `${brand.name}/${brand.matchedBy}`),
      ['Northpath Outdoors/domain', 'Summitline Athletic/domain', 'Tidewater Coffee/name', 'Pixelforge Games/domain'],
    );
    assert.equal(data?.['brands'][0].alternatives[0].name, 'Northpath Kids');
    assert.deepEqual(data?.['sampling'], { weeksInWindow: 53, weeksPulled: 6, maxPagesPerWeek: 3, fullPull: false });
    assert.equal(data?.['ceiling'].totalCredits, 14.4);
  });

  it('says the default 5-credit budget does not fit, and how to change it', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_plan_brand_crossover', question);
    assert.equal(data?.['fits'], false);
    assert.ok(data?.['cheaperOptions'].length > 0);
    assert.ok(data?.['notes'].some((note: string) => /MODASH_CREDIT_BUDGET/.test(note)));
    assert.equal(await spent(client), 0);
  });

  it('refuses the run before any paid call, with cheaper settings to try', async () => {
    const { client } = await session;
    const result = await call(client, 'modash_brand_crossover', question);
    assert.equal(result.isError, true);
    assert.match(result.text, /Budget stop: this analysis could cost up to 14.4 credits/);
    assert.match(result.text, /No paid call was made/);
    assert.match(result.text, /sampleWeeks: 2 /);
    assert.doesNotMatch(result.text, /sampleWeeks: 53/);
    assert.equal(await spent(client), 0);
  });

  it('names an unknown brand rather than guessing', async () => {
    const { client } = await session;
    const result = await call(client, 'modash_plan_brand_crossover', { ...question, brandA: 'nobody.example' });
    assert.equal(result.isError, true);
    assert.match(result.text, /No brand found for "nobody.example"/);
  });

  it('refuses a pair that is really one brand', async () => {
    const { client } = await session;
    const result = await call(client, 'modash_plan_brand_crossover', { ...question, brandB: 'Northpath Outdoors' });
    assert.equal(result.isError, true);
    assert.match(result.text, /same brand/);
  });
});

/**
 * Mock mode keeps the real rate limits, so every page here takes half a second. The runs below are
 * sized to cover each path in as few pages as possible.
 */
describe('a run on a 200-credit budget', () => {
  const session = connect({ ...mockConfig, creditBudget: 200 });
  after(async () => (await session).close());

  it('compares the rivals with the baseline, filters by place and size, and stays under its ceiling', async () => {
    const { client } = await session;
    const { isError, data, text } = await call(client, 'modash_brand_crossover', {
      ...question,
      sampleWeeks: 3,
      location: 'United States',
      minFollowers: 12_000,
    });
    assert.equal(isError, false, text);

    const rival = data?.['rival'];
    const baseline = data?.['baseline'];    assert.deepEqual(rival.brands, ['Northpath Outdoors', 'Summitline Athletic']);
    assert.ok(rival.both > 0 && rival.both < rival.either);
    assert.equal(rival.either, rival.creatorsA + rival.creatorsB - rival.both);
    // The fixtures overlap the outdoor brands less than the unrelated pair.
    assert.ok(rival.crossoverShare < baseline.crossoverShare);
    assert.ok(data?.['brandPulls'].some((brand: { otherPlatformPostsSkipped: number }) => brand.otherPlatformPostsSkipped > 0));
    assert.ok(data?.['caveats'].some((caveat: string) => /Only 3 of 53 weeks/.test(caveat)));

    assert.deepEqual(data?.['creatorFilter'], { locationId: 1001, locationTitle: 'United States', minFollowers: 10_000 });
    const filtered = data?.['filtered'].rival;
    assert.equal(filtered.crossoverLookedUp, rival.both);
    assert.ok(filtered.crossoverMatched > 0 && filtered.crossoverMatched < filtered.crossoverLookedUp);
    assert.ok(filtered.estimatedEitherMatching < rival.either);
    assert.ok(data?.['filtered'].baseline);
    assert.equal(data?.['comparison'].rivalShare, filtered.crossoverShare);
    assert.match(data?.['comparison'].reading, /picking a side/);

    const cost = data?.['cost'];
    assert.ok(cost.creditsThisCall > 0);
    assert.ok(cost.creditsThisCall <= data?.['ceiling'].totalCredits);
    assert.equal(await spent(client), cost.creditsThisCall);
  });

  it('says when the page cap cut a week short', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_brand_crossover', { ...question, sampleWeeks: 1, maxPagesPerWeek: 1 });
    assert.ok(data?.['brandPulls'].some((brand: { truncatedWeeks: number }) => brand.truncatedWeeks > 0));
    assert.ok(data?.['caveats'].some((caveat: string) => /cut short/.test(caveat)));
  });

  it('runs without a baseline, and says that answers nothing on its own', async () => {
    const { client } = await session;
    const { data } = await call(client, 'modash_brand_crossover', { ...question, baseline: undefined, sampleWeeks: 1 });
    assert.equal(data?.['baseline'], undefined);
    assert.match(data?.['comparison'].reading, /No baseline/);
  });
});
