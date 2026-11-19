import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EmailEvidence, type EmailListing } from '../src/email-evidence.js';

const listing = (email: string, platform: EmailListing['platform'], userId: string): EmailListing => ({ email, platform, userId });

const evidence = (claimed: string[], hits: EmailListing[] | undefined) => {
  const emails = new EmailEvidence();
  emails.claim(claimed);
  emails.recordSearch(hits);
  return emails;
};

describe('email evidence', () => {
  it('calls an email shared when two accounts on one platform list it', () => {
    const emails = evidence(['team@example.com'], [listing('team@example.com', 'tiktok', '8'), listing('team@example.com', 'tiktok', '9')]);
    assert.deepEqual([...emails.shared({})], ['team@example.com']);
  });

  it('calls an email shared when another account lists it on a matched platform', () => {
    const emails = evidence(['team@example.com'], [listing('team@example.com', 'youtube', 'UC2')]);
    assert.deepEqual([...emails.shared({})], []);
    assert.deepEqual([...emails.shared({ youtube: { userId: 'UC1' } })], ['team@example.com']);
  });

  it('confirms a candidate only by a claimed email no other account on its platform lists', () => {
    const emails = evidence(
      ['me@example.com', 'team@example.com'],
      [listing('team@example.com', 'tiktok', '8'), listing('me@example.com', 'tiktok', '9')],
    );
    const listed = ['me@example.com', 'team@example.com', 'other@example.com'];
    assert.deepEqual(emails.confirming('tiktok', '9', listed, {}), ['me@example.com']);
  });

  it('does not confirm a candidate by an email another account lists on a matched platform', () => {
    const emails = evidence(['team@example.com'], [listing('team@example.com', 'instagram', '2')]);
    assert.deepEqual(emails.confirming('tiktok', '9', ['team@example.com'], {}), ['team@example.com']);
    assert.deepEqual(emails.confirming('tiktok', '9', ['team@example.com'], { instagram: { userId: '1' } }), []);
  });

  it('confirms nothing by email when email search failed', () => {
    const emails = evidence(['me@example.com'], undefined);
    assert.deepEqual(emails.confirming('tiktok', '9', ['me@example.com'], {}), []);
  });

  it('finds agreement only on an unshared email listed on two platforms', () => {
    const emails = evidence(['team@example.com'], [listing('team@example.com', 'youtube', 'UC2')]);
    const listings = [
      listing('a@example.com', 'instagram', '1'),
      listing('a@example.com', 'tiktok', '8'),
      listing('team@example.com', 'instagram', '1'),
      listing('team@example.com', 'youtube', 'UC1'),
    ];
    const matched = { instagram: { userId: '1' }, tiktok: { userId: '8' }, youtube: { userId: 'UC1' } };
    assert.deepEqual(emails.agreeing(listings, matched).sort(), ['instagram', 'tiktok']);
  });
});
