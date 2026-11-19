import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Platform } from '../src/contacts.js';
import { CreatorMatch, type EmailListing } from '../src/creator-match.js';

const listing = (email: string, platform: EmailListing['platform'], userId: string): EmailListing => ({ email, platform, userId });

const evidence = (claimed: string[], hits: EmailListing[] | undefined) => {
  const creator = new CreatorMatch('instagram', 'example_creator');
  creator.claim(claimed);
  creator.recordSearch(hits);
  return creator;
};

const accept = (creator: CreatorMatch, platform: Platform, userId: string) =>
  creator.accept({ platform, userId, username: null, followers: null, how: 'test' });

const hold = (creator: CreatorMatch, platform: Platform, userId: string, emails: string[]) =>
  creator.reportOnce(platform, userId, async () => ({ contacts: emails.map((value) => ({ type: 'email', value })) }));

describe('email evidence', () => {
  it('calls an email shared when two accounts on one platform list it', () => {
    const creator = evidence(['team@example.com'], [listing('team@example.com', 'tiktok', '8'), listing('team@example.com', 'tiktok', '9')]);
    assert.deepEqual([...creator.sharedEmails()], ['team@example.com']);
  });

  it('calls an email shared when another account lists it on a matched platform', () => {
    const creator = evidence(['team@example.com'], [listing('team@example.com', 'youtube', 'UC2')]);
    assert.deepEqual([...creator.sharedEmails()], []);
    accept(creator, 'youtube', 'UC1');
    assert.deepEqual([...creator.sharedEmails()], ['team@example.com']);
  });

  it('confirms a candidate only by a claimed email no other account on its platform lists', () => {
    const creator = evidence(
      ['me@example.com', 'team@example.com'],
      [listing('team@example.com', 'tiktok', '8'), listing('me@example.com', 'tiktok', '9')],
    );
    const listed = ['me@example.com', 'team@example.com', 'other@example.com'];
    assert.deepEqual(creator.confirming('tiktok', '9', listed), ['me@example.com']);
  });

  it('does not confirm a candidate by an email another account lists on a matched platform', () => {
    const creator = evidence(['team@example.com'], [listing('team@example.com', 'instagram', '2')]);
    assert.deepEqual(creator.confirming('tiktok', '9', ['team@example.com']), ['team@example.com']);
    accept(creator, 'instagram', '1');
    assert.deepEqual(creator.confirming('tiktok', '9', ['team@example.com']), []);
  });

  it('confirms nothing by email when email search failed', () => {
    const creator = evidence(['me@example.com'], undefined);
    assert.deepEqual(creator.confirming('tiktok', '9', ['me@example.com']), []);
  });

  it('finds agreement only on an unshared email listed on two platforms', async () => {
    const creator = evidence(['team@example.com'], [listing('team@example.com', 'youtube', 'UC2')]);
    accept(creator, 'instagram', '1');
    accept(creator, 'tiktok', '8');
    accept(creator, 'youtube', 'UC1');
    await hold(creator, 'instagram', '1', ['a@example.com', 'team@example.com']);
    await hold(creator, 'tiktok', '8', ['a@example.com']);
    await hold(creator, 'youtube', 'UC1', ['team@example.com']);
    creator.markEmailAgreement();
    const { accounts } = creator.result(0);
    const agreeing = Object.entries(accounts).flatMap(([platform, account]) => (account.email_agrees ? [platform] : []));
    assert.deepEqual(agreeing.sort(), ['instagram', 'tiktok']);
  });
});
