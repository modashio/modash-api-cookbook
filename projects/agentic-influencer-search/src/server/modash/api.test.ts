/**
 * What the API layer puts on the wire. These exist because a live run turned up
 * a request the model builds routinely and the API rejects outright.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiveApi } from './api';
import type { ModashClient } from './client';

/** Records the last request instead of making one. */
function recordingClient() {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = {
    post(path: string, body: unknown) {
      calls.push({ path, body });
      return Promise.resolve({ total: 0, profiles: [] });
    },
    get(path: string) {
      calls.push({ path, body: undefined });
      return Promise.resolve({ locations: [] });
    },
  } as unknown as ModashClient;

  return { client, calls };
}

test('empty filters are dropped rather than sent', async () => {
  const { client, calls } = recordingClient();

  await createLiveApi(client).textSearch({
    platform: 'instagram',
    query: 'evening wind-down routines',
    // A model writes these to mean "no preference". The API answers HTTP 400
    // invalid_body_params, which cost a real run a wasted round trip.
    filters: { followersCount: { min: 25_000 }, locations: [], textTags: [], brands: [], hasEmail: true },
    pageSize: 2,
  });

  const body = calls[0]?.body as { filters: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.filters).sort(), ['followersCount', 'hasEmail']);
  assert.deepEqual(body.filters.followersCount, { min: 25_000 });
});

test('a filter object with nothing left in it is omitted entirely', async () => {
  const { client, calls } = recordingClient();

  await createLiveApi(client).textSearch({
    platform: 'tiktok',
    query: 'street food',
    filters: { locations: [], brands: [], audience: {} },
  });

  assert.equal((calls[0]?.body as { filters?: unknown }).filters, undefined);
});

test('the query is omitted when absent, so results fall back to follower order', async () => {
  const { client, calls } = recordingClient();

  await createLiveApi(client).textSearch({ platform: 'youtube', filters: { hasEmail: true } });

  assert.ok(!('query' in (calls[0]?.body as object)));
  assert.equal(calls[0]?.path, '/ai/youtube/text-search');
});
