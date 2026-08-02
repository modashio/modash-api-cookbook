/**
 * The Modash surface this project uses, behind one interface with two
 * implementations: `createLiveApi` (real HTTP) and `createMockApi` (synthetic
 * data, no token, no credits — see `mock.ts`).
 *
 * Endpoints used here:
 *   POST /ai/{platform}/text-search   0.025 credits per returned profile
 *   POST /ai/{platform}/lookalikes    0.025 credits per returned profile
 *   GET  /{platform}/locations        free
 *   GET  /{platform}/languages        free
 *   GET  /ai/brands                   free
 *   GET  /ai/hashtags, /ai/mentions   free
 *   GET  /user/info                   free
 */

import type { AudienceReport, Creator, Platform } from '../../shared/creators';
import { profileUrl } from '../../shared/creators';
import type { ModashClient } from './client';
import type { AiSearchFilters, ModashProfile } from './schemas';
import {
  accountInfoResponseSchema,
  brandsResponseSchema,
  languagesResponseSchema,
  locationsResponseSchema,
  lookalikesResponseSchema,
  reportResponseSchema,
  textSearchResponseSchema,
  textTagsResponseSchema,
} from './schemas';

export interface TextSearchInput {
  platform: Platform;
  /** Optional: without it, results are ordered by follower count. */
  query?: string;
  filters?: AiSearchFilters;
  page?: number;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface LookalikesInput {
  sourcePlatform: Platform;
  /** 1–5 usernames or user IDs. */
  userIds: string[];
  targetPlatform: Platform;
  filters?: AiSearchFilters;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface SearchResult {
  /** Total matches available server-side, not the number returned. */
  total: number;
  creators: Creator[];
}

export interface LookalikesResult extends SearchResult {
  sources: Creator[];
}

export interface LocationHit {
  id: number;
  title: string;
}

export interface LanguageHit {
  code: string;
  name: string;
}

export interface AccountInfo {
  credits?: number;
  discoveryRateLimit?: number;
}

export interface ModashApi {
  readonly isMock: boolean;
  textSearch(input: TextSearchInput): Promise<SearchResult>;
  lookalikes(input: LookalikesInput): Promise<LookalikesResult>;
  /** GET /{platform}/profile/{userId}/report — 1 credit each. */
  profileReport(platform: Platform, userIdOrUsername: string, signal?: AbortSignal): Promise<AudienceReport>;
  locations(platform: Platform, query: string): Promise<LocationHit[]>;
  languages(platform: Platform, query: string): Promise<LanguageHit[]>;
  brands(query: string, platform?: Platform): Promise<string[]>;
  textTags(platform: Platform, type: 'hashtag' | 'mention', query: string): Promise<string[]>;
  accountInfo(): Promise<AccountInfo>;
}

export function createLiveApi(client: ModashClient): ModashApi {
  return {
    isMock: false,

    async textSearch({ platform, query, filters, page = 0, pageSize = 10, signal }) {
      const payload = await client.post(
        `/ai/${platform}/text-search`,
        // `query` is optional; omitting it sorts purely by follower count.
        { ...(query ? { query } : {}), filters: pruneEmpty(filters), page, pageSize },
        signal,
      );
      const parsed = textSearchResponseSchema.parse(payload);
      return {
        total: parsed.total ?? parsed.profiles.length,
        creators: parsed.profiles.map((profile) => toCreator(platform, profile)),
      };
    },

    async lookalikes({ sourcePlatform, userIds, targetPlatform, filters, pageSize = 10, signal }) {
      const payload = await client.post(
        `/ai/${sourcePlatform}/lookalikes`,
        { userIds, targetPlatform, filters: pruneEmpty(filters), page: 0, pageSize },
        signal,
      );
      const parsed = lookalikesResponseSchema.parse(payload);
      return {
        total: parsed.total ?? parsed.lookalikes.length,
        creators: parsed.lookalikes.map((profile) => toCreator(targetPlatform, profile)),
        sources: parsed.sourceProfiles.map((profile) => toCreator(sourcePlatform, profile)),
      };
    },

    async profileReport(platform, userIdOrUsername, signal) {
      const payload = await client.get(
        `/${platform}/profile/${encodeURIComponent(userIdOrUsername)}/report`,
        undefined,
        signal,
      );
      const { profile } = reportResponseSchema.parse(payload);
      const audience = profile.audience;

      return {
        platform,
        username: profile.profile?.username ?? userIdOrUsername,
        credibility: audience?.credibility,
        followers: profile.profile?.followers,
        engagementRate: profile.profile?.engagementRate,
        topCountries: toWeighted(audience?.geoCountries, 3),
        genders: toWeighted(audience?.genders, 2),
        ageBrackets: toWeighted(audience?.ages, 3),
        contacts: profile.contacts ?? [],
      };
    },

    async locations(platform, query) {
      const payload = await client.get(`/${platform}/locations`, { query, limit: 8 });
      const parsed = locationsResponseSchema.parse(payload);
      return parsed.locations.map((location) => ({
        id: location.id,
        title: location.title ?? location.name ?? String(location.id),
      }));
    },

    async languages(platform, query) {
      const payload = await client.get(`/${platform}/languages`, { query, limit: 8 });
      const parsed = languagesResponseSchema.parse(payload);
      return parsed.languages.map((language) => ({
        code: language.code,
        name: language.name ?? language.code,
      }));
    },

    async brands(query, platform) {
      const payload = await client.get('/ai/brands', { query, platform });
      const parsed = brandsResponseSchema.parse(payload);
      return parsed.result.map((brand) => brand.name);
    },

    async textTags(platform, type, query) {
      const path = type === 'hashtag' ? '/ai/hashtags' : '/ai/mentions';
      const payload = await client.get(path, { platform, query });
      const parsed = textTagsResponseSchema.parse(payload);
      return parsed.result.map((row) => row.value);
    },

    async accountInfo() {
      const payload = await client.get('/user/info');
      const parsed = accountInfoResponseSchema.parse(payload);
      return {
        credits: parsed.billing?.credits,
        discoveryRateLimit: parsed.rateLimits?.discoveryRatelimit,
      };
    },
  };
}

/**
 * Strips empty values out of a filter object before it goes on the wire.
 *
 * Models routinely emit `locations: []` or `textTags: []` to mean "no preference",
 * and the API answers that with `invalid_body_params` and an HTTP 400 — a wasted
 * round trip and a red error in the UI for something that just means "omit me".
 */
function pruneEmpty<T extends Record<string, unknown>>(filters: T | undefined): T | undefined {
  if (!filters) return undefined;

  const entries = Object.entries(filters).flatMap(([key, value]) => {
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) return value.length > 0 ? [[key, value] as const] : [];
    if (typeof value === 'object') {
      const nested = pruneEmpty(value as Record<string, unknown>);
      return nested && Object.keys(nested).length > 0 ? [[key, nested] as const] : [];
    }
    return [[key, value] as const];
  });

  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/** Weighted audience breakdowns come back unsorted and long; keep the top few. */
function toWeighted(
  rows: Array<{ code?: string | undefined; name?: string | undefined; weight?: number | undefined }> | undefined,
  limit: number,
): Array<{ label: string; weight: number }> {
  return (rows ?? [])
    .map((row) => ({ label: row.name ?? row.code ?? '', weight: row.weight ?? 0 }))
    .filter((row) => row.label !== '')
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

/** Normalises a Modash profile into the shape the UI renders. */
function toCreator(platform: Platform, profile: ModashProfile): Creator {
  const posts = profile.matchedPosts?.length ? profile.matchedPosts : (profile.recentPosts ?? []);

  return {
    platform,
    userId: profile.userId,
    username: profile.username,
    fullName: profile.fullName,
    profilePicture: profile.profilePicture,
    profileUrl: profile.url ?? profileUrl(platform, profile.username),
    followers: profile.followersCount,
    engagementRate: profile.engagementRate,
    postsPerMonth: profile.postingFrequency,
    medianViews: profile.viewsCountMedian ?? profile.viewsCountMean,
    accountCategory: profile.accountCategory,
    matchedPosts: posts.slice(0, 4).map((post) => ({
      url: post.url,
      thumbnail: post.thumbnail,
      likes: post.stats?.likesCount,
      comments: post.stats?.commentsCount,
      // Instagram and TikTok report `playsCount`; YouTube reports `viewsCount`.
      views: post.stats?.viewsCount ?? post.stats?.playsCount,
    })),
  };
}
