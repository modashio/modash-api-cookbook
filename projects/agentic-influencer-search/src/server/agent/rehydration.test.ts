/**
 * State carried across turns. Both cases here cost real money when they break —
 * one resurrects creators the user cut, the other buys reports twice — and
 * neither is visible without replaying a multi-turn conversation.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AudienceReport, Creator, Platform } from '../../shared/creators';
import type { ChatMessage, ReportsDataPart, ShortlistEntry } from '../../shared/messages';
import type { ModashApi } from '../modash/api';
import { createMockApi } from '../modash/mock';
import { scriptedToolModel } from '../testing/scripted-model';
import { runAgent } from './agent';

const creator = (username: string, platform: Platform = 'instagram'): Creator => ({
  platform,
  username,
  profileUrl: `https://example/${username}`,
  followers: 50_000,
  matchedPosts: [],
});

const entry = (username: string): ShortlistEntry => ({
  creator: creator(username),
  reason: 'fits',
  fit: 'strong',
});

async function collect(stream: ReadableStream<{ type: string }>) {
  const chunks: Array<Record<string, unknown>> = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Record<string, unknown>);
  }
  return chunks;
}

test('a later shortlist snapshot replaces the earlier one instead of merging', async () => {
  // Turn 1 shortlisted three. Auto-review then cut two, writing a snapshot of one.
  // Rehydrating by union would bring the cut creators straight back.
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'find creators' }] },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'data-search',
          data: {
            kind: 'text-search',
            status: 'complete',
            platform: 'instagram',
            query: 'q',
            filterSummary: [],
            creators: [creator('keep'), creator('cut.one'), creator('cut.two'), creator('added.later')],
          },
        },
        { type: 'data-shortlist', data: { entries: [entry('keep'), entry('cut.one'), entry('cut.two')] } },
        { type: 'data-shortlist', data: { entries: [entry('keep')] } },
      ],
    },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'add one more' }] },
  ];

  const chunks = await collect(
    runAgent({
      model: scriptedToolModel('shortlistCreators', {
        creators: [{ platform: 'instagram', username: 'added.later', reason: 'good', fit: 'strong' }],
      }),
      api: createMockApi(),
      creditBudget: 5,
      maxPageSize: 20,
      messages,
    }),
  );

  const written = chunks
    .filter((chunk) => chunk.type === 'data-shortlist')
    .map((chunk) => chunk.data as { entries: ShortlistEntry[] })
    .at(-1);

  const usernames = (written?.entries ?? []).map((item) => item.creator.username).sort();
  assert.deepEqual(usernames, ['added.later', 'keep'], 'the cut creators must not come back');
});

test('reports bought before a mid-batch failure are still reported and billed', async () => {
  // Reports are billed one at a time. Losing the successful ones on failure means
  // the next turn rehydrates without them and pays for them again.
  const mock = createMockApi();
  let calls = 0;
  const flaky: ModashApi = {
    ...mock,
    async profileReport(platform, username, signal): Promise<AudienceReport> {
      calls++;
      if (calls === 2) throw new Error('upstream exploded');
      return mock.profileReport(platform, username, signal);
    },
  };

  const chunks = await collect(
    runAgent({
      model: scriptedToolModel('getAudienceReports', {
        creators: [
          { platform: 'instagram', username: 'demo.aurora.sleeps' },
          { platform: 'instagram', username: 'demo.saunaandsalt' },
        ],
      }),
      api: flaky,
      creditBudget: 5,
      maxPageSize: 20,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'pull reports' }] }],
    }),
  );

  const part = chunks
    .filter((chunk) => chunk.type === 'data-reports')
    .map((chunk) => chunk.data as ReportsDataPart)
    .at(-1);

  assert.equal(part?.status, 'error');
  assert.equal(part?.reports?.length, 1, 'the report bought before the failure must survive');
  assert.equal(part?.creditsSpent, 1);

  const usage = chunks
    .filter((chunk) => chunk.type === 'data-usage')
    .map((chunk) => chunk.data as { creditsSpent: number })
    .at(-1);
  assert.equal(usage?.creditsSpent, 1, 'the meter must show what was actually spent');
});

test('a rejected creator is never worth a credit', async () => {
  let bought = 0;
  const mock = createMockApi();
  const counting: ModashApi = {
    ...mock,
    async profileReport(platform, username, signal) {
      bought++;
      return mock.profileReport(platform, username, signal);
    },
  };

  const chunks = await collect(
    runAgent({
      model: scriptedToolModel('getAudienceReports', {
        creators: [
          { platform: 'instagram', username: 'demo.aurora.sleeps' },
          { platform: 'instagram', username: 'demo.saunaandsalt' },
        ],
      }),
      api: counting,
      creditBudget: 5,
      maxPageSize: 20,
      verdicts: [{ platform: 'instagram', username: 'demo.saunaandsalt', verdict: 'dislike' }],
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'pull reports' }] }],
    }),
  );

  assert.equal(bought, 1, 'only the creator that was not vetoed should be bought');

  const part = chunks
    .filter((chunk) => chunk.type === 'data-reports')
    .map((chunk) => chunk.data as ReportsDataPart)
    .at(-1);
  assert.deepEqual(part?.usernames, ['demo.aurora.sleeps']);
});
