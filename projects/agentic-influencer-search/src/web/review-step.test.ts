import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AudienceReport, Creator, Platform } from '../shared/creators';
import type { ChatMessage, ShortlistEntry } from '../shared/messages';
import { buildReviewStep } from './review-step';

const creator = (username: string, platform: Platform = 'instagram'): Creator => ({
  platform,
  username,
  profileUrl: `https://example/${username}`,
  matchedPosts: [],
});

const shortlisted = (username: string, platform: Platform = 'instagram'): ShortlistEntry => ({
  creator: creator(username, platform),
  reason: 'fits',
  fit: 'strong',
});

const report = (username: string, platform: Platform = 'instagram'): AudienceReport => ({
  platform,
  username,
  topCountries: [],
  genders: [],
  ageBrackets: [],
  contacts: [],
});

function withReports(...reports: AudienceReport[]): ChatMessage[] {
  return [
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'data-reports', data: { status: 'complete', usernames: reports.map((r) => r.username), reports } },
      ],
    },
  ];
}

test('no shortlist means no review step', () => {
  assert.equal(buildReviewStep([], []), undefined);
});

test('the cost is one credit per creator that still needs a report', () => {
  const step = buildReviewStep([], [shortlisted('a'), shortlisted('b'), shortlisted('c')]);
  assert.equal(step?.estimatedCredits, 3);
  assert.match(step?.label ?? '', /review/i);
});

test('reports already bought are not charged again', () => {
  const step = buildReviewStep(withReports(report('a'), report('b')), [
    shortlisted('a'),
    shortlisted('b'),
    shortlisted('c'),
  ]);
  assert.equal(step?.estimatedCredits, 1, 'only the unreported creator should cost anything');
});

test('a fully reported shortlist reviews for free', () => {
  const step = buildReviewStep(withReports(report('a')), [shortlisted('a')]);
  assert.equal(step?.estimatedCredits, undefined, 'no cost badge when nothing needs buying');
});

test('the same handle on two platforms is two different creators', () => {
  const step = buildReviewStep(withReports(report('a', 'instagram')), [
    shortlisted('a', 'instagram'),
    shortlisted('a', 'tiktok'),
  ]);
  assert.equal(step?.estimatedCredits, 1);
});
