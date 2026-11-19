import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runBatch } from '../src/batch.js';
import type { MatchResult } from '../src/creator-match.js';
import { Matcher } from '../src/match.js';
import { CreditBudgetExceededError } from '../src/modash/errors.js';
import { memoryReads } from './memory-reads.js';

const line = (handle: string, errors: string[]) =>
  JSON.stringify({ input: { platform: 'instagram', handle }, accounts: {}, candidates: [], missing: [], credits: 0, errors });

const recorded = (path: string) =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      const result = JSON.parse(l) as MatchResult;
      return `${result.input.handle} ${result.errors.length === 0 ? 'finished' : 'failed'}`;
    });

const rows = (...handles: string[]): [string, string][] => handles.map((handle) => ['instagram', handle]);

describe('batch run', () => {
  let dir: string;
  let resultsPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'match-creator-batch-'));
    resultsPath = join(dir, 'results.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('skips finished creators and reruns failed ones when a CSV run resumes', async () => {
    writeFileSync(resultsPath, [line('amy', []), line('bea', ['report failed'])].join('\n'));
    const matched: string[] = [];
    const outcome = await runBatch({
      rows: rows('amy', 'bea'),
      matcher: new Matcher(memoryReads({})),
      resultsPath,
      kind: 'csv',
      onResult: (result) => matched.push(result.input.handle),
    });
    assert.deepEqual(outcome, { ran: 1 });
    assert.deepEqual(matched, ['bea']);
    assert.deepEqual(recorded(resultsPath), ['amy finished', 'bea finished']);
  });

  it('stops at a stopping error and keeps the results finished before it', async () => {
    const stop = new CreditBudgetExceededError(1, 1);
    const reads = memoryReads({});
    const matcher = new Matcher({
      ...reads,
      async lookupAccounts(platform, query) {
        if (query === 'bea') throw stop;
        return reads.lookupAccounts(platform, query);
      },
    });
    const outcome = await runBatch({ rows: rows('amy', 'bea', 'cat'), matcher, resultsPath, kind: 'csv' });
    assert.deepEqual(outcome, { ran: 1, stoppedAt: { handle: 'bea', error: stop } });
    assert.deepEqual(recorded(resultsPath), ['amy finished']);
  });
});
