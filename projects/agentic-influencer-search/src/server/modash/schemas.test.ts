/**
 * Checks the response schemas against the shapes documented in the API
 * reference, and that unknown fields survive rather than blowing up — Modash adds
 * fields over time and an example app should not break when it happens.
 *
 * The payloads below are hand-written from the public docs (which use the
 * sanitised `instagram` account); no real creator data is committed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accountInfoResponseSchema,
  aiSearchFiltersSchema,
  brandsResponseSchema,
  languagesResponseSchema,
  locationsResponseSchema,
  lookalikesResponseSchema,
  textSearchResponseSchema,
  textTagsResponseSchema,
} from './schemas';

test('AI Search text-search responses parse, including unknown fields', () => {
  const parsed = textSearchResponseSchema.parse({
    error: false,
    total: 1234,
    profiles: [
      {
        userId: '173560420',
        fullName: 'Instagram',
        username: 'instagram',
        profilePicture: 'https://imgigp.modash.io/example.jpg',
        followersCount: 313560626,
        engagementRate: 0.01,
        postingFrequency: 12,
        viewsCountMedian: 25000,
        viewsCountMean: 32000,
        accountCategory: 'Digital creator',
        matchedPosts: [
          {
            id: 'p1',
            url: 'https://instagram.com/p/p1',
            thumbnail: 'https://example/p1.jpg',
            // -1 means the creator hides their like count.
            stats: { likesCount: -1, commentsCount: 20, playsCount: 5000 },
          },
        ],
        recentPosts: [],
        fieldAddedInSomeFutureRelease: true,
      },
    ],
  });

  assert.equal(parsed.total, 1234);
  assert.equal(parsed.profiles[0]?.matchedPosts?.[0]?.stats?.playsCount, 5000);
});

test('nulls are accepted wherever the API sends them, and normalise to undefined', () => {
  // Shape observed against the live API. The reference documents `accountCategory`
  // and `stats.playsCount` as required, but both arrive as null in practice, and
  // an earlier schema that allowed only `undefined` failed the whole search.
  const parsed = textSearchResponseSchema.parse({
    error: false,
    total: 673,
    profiles: [
      {
        userId: '1',
        fullName: 'Example',
        username: 'example',
        profilePicture: 'https://example/a.jpg',
        followersCount: 21742,
        engagementRate: 0.24,
        postingFrequency: 5,
        viewsCountMedian: 5563,
        viewsCountMean: 6631,
        accountCategory: null,
        matchedPosts: [
          {
            id: 'p1',
            url: 'https://example/p1',
            thumbnail: 'https://example/p1.jpg',
            stats: { likesCount: 235, commentsCount: 9, playsCount: null },
          },
        ],
        recentPosts: [],
      },
    ],
  });

  const profile = parsed.profiles[0];
  assert.equal(profile?.accountCategory, undefined);
  assert.equal(profile?.matchedPosts?.[0]?.stats?.playsCount, undefined);
  assert.equal(profile?.followersCount, 21742);
});

test('a null anywhere optional does not fail the parse', () => {
  const parsed = textSearchResponseSchema.parse({
    total: null,
    profiles: [
      {
        userId: null,
        username: 'example',
        fullName: null,
        profilePicture: null,
        followersCount: null,
        engagementRate: null,
        postingFrequency: null,
        viewsCountMedian: null,
        viewsCountMean: null,
        accountCategory: null,
        matchedPosts: null,
        recentPosts: null,
      },
    ],
  });

  assert.equal(parsed.profiles[0]?.username, 'example');
  assert.equal(parsed.profiles[0]?.matchedPosts, undefined);
});

test('lookalike responses parse both the current and deprecated source fields', () => {
  const profile = {
    username: 'instagram',
    profilePicture: 'https://example/a.jpg',
    followersCount: 100,
    engagementRate: 0.1,
    postingFrequency: 4,
  };

  const parsed = lookalikesResponseSchema.parse({
    total: 5,
    sourceProfiles: [{ ...profile, url: 'https://instagram.com/instagram' }],
    lookalikes: [{ ...profile, username: 'other', recentPosts: [] }],
    sourceProfile: { ...profile, url: 'https://instagram.com/instagram' },
  });

  assert.equal(parsed.lookalikes[0]?.username, 'other');
  assert.equal(parsed.sourceProfiles.length, 1);
});

test('dictionary responses parse', () => {
  assert.equal(
    locationsResponseSchema.parse({
      error: false,
      locations: [{ id: 51800, name: 'London', title: 'London, United Kingdom' }],
      total: 8477,
    }).locations[0]?.title,
    'London, United Kingdom',
  );

  assert.equal(
    languagesResponseSchema.parse({ error: false, languages: [{ code: 'en', name: 'English' }], total: 98 })
      .languages[0]?.name,
    'English',
  );

  assert.equal(
    brandsResponseSchema.parse({
      error: false,
      result: [
        {
          brandId: 'hash',
          name: 'Example Brand',
          logoUrl: 'https://example/logo.png',
          accounts: [{ platform: 'instagram', domain: 'example.com' }],
        },
      ],
    }).result[0]?.name,
    'Example Brand',
  );

  assert.equal(
    textTagsResponseSchema.parse({ error: false, result: [{ value: 'carsofinstagram', count: 1000 }] }).result[0]
      ?.value,
    'carsofinstagram',
  );

  assert.equal(
    accountInfoResponseSchema.parse({
      error: false,
      user: { name: '', email: '' },
      billing: { credits: 3000, rawRequests: 4500 },
      rateLimits: { discoveryRatelimit: 500, rawRatelimit: 500 },
    }).billing?.credits,
    3000,
  );
});

test('the filter schema accepts the documented example filter object', () => {
  const filters = aiSearchFiltersSchema.parse({
    followersCount: { min: 10000 },
    gender: 'MALE',
    lastPostedInDays: 90,
    accountType: 'creator',
    language: 'es',
    age: { min: '18' },
    engagementRate: { min: 0.01 },
    postingFrequency: { min: 2 },
    viewsCount: { min: 10000, calculationMethod: 'median' },
    hasEmail: true,
    maxPostAgeMonths: 3,
    contentType: 'video',
    textTags: [
      { type: 'hashtag', value: 'carsofinstagram' },
      { type: 'mention', value: 'topgear', mode: 'exclude' },
    ],
    bio: 'travel photographer',
    keywords: 'supercars',
    audience: { credibility: 0.75 },
  });

  assert.equal(filters.followersCount?.min, 10000);
  assert.equal(filters.textTags?.[1]?.mode, 'exclude');
});

test('the filter schema rejects values the API would reject', () => {
  assert.throws(() => aiSearchFiltersSchema.parse({ maxPostAgeMonths: 5 }));
  assert.throws(() => aiSearchFiltersSchema.parse({ age: { min: '21' } }));
  assert.throws(() => aiSearchFiltersSchema.parse({ gender: 'male' }));
  assert.throws(() => aiSearchFiltersSchema.parse({ audience: { credibility: 1.5 } }));
});
