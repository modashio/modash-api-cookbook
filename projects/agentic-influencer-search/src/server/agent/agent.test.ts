/**
 * Exercises the whole loop — tool call, Modash request, data parts, credit
 * ledger — with a scripted mock model and the mock Modash API.
 *
 * No API token and no model provider key required, which is the point: this can
 * run in CI without spending anyone's credits.
 *
 * Run with `npm test`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ChatMessage, SearchDataPart, UsageDataPart } from '../../shared/messages';
import { createMockApi } from '../modash/mock';
import { scriptedSearchModel } from '../testing/scripted-model';
import { runAgent } from './agent';

test('the agent searches, streams result cards, and meters credits', async () => {
  const { searches, usage, text } = await run({ creditBudget: 5 });

  assert.ok(searches.length >= 2, 'expected a running and a completed search data part');
  assert.equal(searches.at(0)?.status, 'running');

  const completed = searches.at(-1);
  assert.equal(completed?.status, 'complete');
  assert.equal(completed?.platform, 'instagram');
  assert.ok(completed?.creators && completed.creators.length > 0, 'expected creators in the result');
  assert.ok(
    completed.filterSummary.some((filter) => filter.includes('followers')),
    'expected the follower filter to be summarised for the UI',
  );

  // 5 profiles requested at 0.025 credits each.
  const finalUsage = usage.at(-1);
  assert.ok(finalUsage);
  assert.equal(finalUsage.paidCalls, 1);
  assert.ok(finalUsage.creditsSpent > 0 && finalUsage.creditsSpent <= 0.125);
  assert.equal(finalUsage.mock, true);

  assert.match(text, /candidates/);
});

test('the credit budget stops a search that would overspend', async () => {
  // Less than the cost of a single profile.
  const { searches } = await run({ creditBudget: 0.01 });

  const failed = searches.at(-1);
  assert.equal(failed?.status, 'error');
  assert.match(failed?.error ?? '', /credits/i);
});

interface RunResult {
  searches: SearchDataPart[];
  usage: UsageDataPart[];
  text: string;
}

async function run({ creditBudget }: { creditBudget: number }): Promise<RunResult> {
  const messages: ChatMessage[] = [
    {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: 'Find me sleep-adjacent wellness creators on Instagram.' }],
    },
  ];

  const stream = runAgent({
    model: scriptedSearchModel(),
    api: createMockApi(),
    creditBudget,
    maxPageSize: 20,
    messages,
  });

  const result: RunResult = { searches: [], usage: [], text: '' };
  const reader = stream.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    switch (value.type) {
      case 'data-search':
        result.searches.push(value.data as SearchDataPart);
        break;
      case 'data-usage':
        result.usage.push(value.data as UsageDataPart);
        break;
      case 'text-delta':
        result.text += value.delta;
        break;
      default:
        break;
    }
  }

  return result;
}
