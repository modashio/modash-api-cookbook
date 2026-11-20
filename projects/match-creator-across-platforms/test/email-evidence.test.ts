import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Platform } from '../src/contacts.js';
import { type EmailSearchHit, type Matched, searchEmailEvidence } from '../src/email-evidence.js';
import type { ReportProfile } from '../src/modash/responses.js';

const hit = (email: string, platform: Platform, userId: string): EmailSearchHit => ({
  email,
  platform,
  userId,
  username: null,
  followers: null,
});

const report = (emails: string[]): ReportProfile => ({ contacts: emails.map((value) => ({ type: 'email', value })) });

/** A creator whose matches a test can change between questions, with the reports it holds by `platform:userId`. */
const creatorWith = (matched: Matched, reports: Record<string, ReportProfile> = {}) => ({
  matched,
  heldReport: (platform: Platform, userId: string) => reports[`${platform}:${userId}`],
});

const evidence = (claimed: string[], matched: Matched, hits: EmailSearchHit[] | undefined) =>
  searchEmailEvidence(creatorWith(matched), claimed, async () => hits);

describe('email evidence', () => {
  it('calls an email shared when two accounts on one platform list it', async () => {
    const { verdicts } = await evidence(['team@example.com'], { instagram: { userId: '1' } }, [
      hit('team@example.com', 'tiktok', '8'),
      hit('team@example.com', 'tiktok', '9'),
    ]);
    const hows = verdicts.map(({ accept, candidate }) => ({ accept, userId: candidate.userId, how: candidate.how }));
    assert.deepEqual(hows, [
      { accept: false, userId: '8', how: 'email (team@example.com), shared by several accounts' },
      { accept: false, userId: '9', how: 'email (team@example.com), shared by several accounts' },
    ]);
  });

  it('calls an email shared when another account lists it on a matched platform', async () => {
    const hits = [hit('team@example.com', 'youtube', 'UC2'), hit('team@example.com', 'tiktok', '9')];
    const unmatched = await evidence(['team@example.com'], { instagram: { userId: '1' } }, hits);
    assert.deepEqual(
      unmatched.verdicts.map(({ accept, candidate }) => [accept, candidate.userId]),
      [
        [true, 'UC2'],
        [true, '9'],
      ],
    );
    const matched = await evidence(['team@example.com'], { instagram: { userId: '1' }, youtube: { userId: 'UC1' } }, hits);
    assert.deepEqual(
      matched.verdicts.map(({ accept, candidate }) => [accept, candidate.userId, candidate.how]),
      [[false, '9', 'email (team@example.com), shared by several accounts']],
    );
  });

  it('confirms a candidate only by a claimed email no other account on its platform lists', async () => {
    const { confirming } = await evidence(['me@example.com', 'team@example.com'], {}, [
      hit('team@example.com', 'tiktok', '8'),
      hit('me@example.com', 'tiktok', '9'),
    ]);
    const listed = ['me@example.com', 'team@example.com', 'other@example.com'];
    assert.deepEqual(confirming('tiktok', '9', listed), ['me@example.com']);
  });

  it('does not confirm a candidate by an email another account lists on a matched platform', async () => {
    const creator = creatorWith({});
    const { confirming } = await searchEmailEvidence(creator, ['team@example.com'], async () => [
      hit('team@example.com', 'instagram', '2'),
    ]);
    assert.deepEqual(confirming('tiktok', '9', ['team@example.com']), ['team@example.com']);
    creator.matched = { instagram: { userId: '1' } };
    assert.deepEqual(confirming('tiktok', '9', ['team@example.com']), []);
  });

  it('confirms nothing by email when email search failed', async () => {
    const { confirming } = await evidence(['me@example.com'], {}, undefined);
    assert.deepEqual(confirming('tiktok', '9', ['me@example.com']), []);
  });

  it('finds agreement only on an unshared email listed on two platforms', async () => {
    const creator = creatorWith(
      {},
      {
        'instagram:1': report(['a@example.com', 'team@example.com']),
        'tiktok:8': report(['a@example.com']),
        'youtube:UC1': report(['team@example.com']),
      },
    );
    const { agreeing } = await searchEmailEvidence(creator, ['team@example.com'], async () => [
      hit('team@example.com', 'youtube', 'UC2'),
    ]);
    creator.matched = { instagram: { userId: '1' }, tiktok: { userId: '8' }, youtube: { userId: 'UC1' } };
    assert.deepEqual(agreeing().sort(), ['instagram', 'tiktok']);
  });
});
