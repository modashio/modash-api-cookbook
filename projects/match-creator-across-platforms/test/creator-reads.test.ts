import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CreatorReads } from '../src/creator-reads.js';
import { CreditBudgetExceededError } from '../src/modash/errors.js';
import type { ModashReads } from '../src/modash/reads.js';
import { memoryReads } from './memory-reads.js';

describe('creator reads', () => {
  it('counts only the credits spent after it was made', async () => {
    const memory = memoryReads({ reports: [{ platform: 'instagram', userId: '1', contacts: [] }] });
    let spent = 3;
    const reads: ModashReads = {
      ...memory,
      get spent() {
        return spent;
      },
      async report(platform, userId) {
        spent += 1;
        return memory.report(platform, userId);
      },
    };
    const creator = new CreatorReads(reads);
    await creator.report('instagram', '1');
    await creator.report('instagram', '1');
    assert.equal(creator.credits, 1);
  });

  it('records a failed report once, asks for it once, and holds nothing for it', async () => {
    let asked = 0;
    const memory = memoryReads({});
    const creator = new CreatorReads({
      ...memory,
      async report(platform, userId) {
        asked += 1;
        return memory.report(platform, userId);
      },
    });
    assert.equal(await creator.report('tiktok', '9'), undefined);
    assert.equal(await creator.report('tiktok', '9'), undefined);
    assert.equal(asked, 1);
    assert.equal(creator.heldReport('tiktok', '9'), undefined);
    assert.deepEqual(creator.errors, ['report tiktok 9: no report for tiktok 9']);
  });

  it('lets an error that stops the run through', async () => {
    const stop = new CreditBudgetExceededError(1, 1);
    const creator = new CreatorReads({ ...memoryReads({}), searchEmails: () => Promise.reject(stop) });
    await assert.rejects(creator.searchEmails(['a@example.com']), stop);
    assert.deepEqual(creator.errors, []);
  });
});
