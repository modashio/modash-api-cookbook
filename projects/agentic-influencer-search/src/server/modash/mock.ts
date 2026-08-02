/**
 * Mock implementation of `ModashApi`.
 *
 * Purpose: you can clone this repo, run it with no Modash token, and still see
 * the whole agent loop and UI work. Nothing here calls the network and nothing
 * costs credits.
 *
 * Everything below is INVENTED. The handles, names, avatars and thumbnails are
 * generated locally and do not correspond to real people or real accounts — this
 * is a public repo, so no real creator data is committed. The response *shapes*
 * match the API; the values do not.
 */

import type { AudienceReport, Creator, Platform } from '../../shared/creators';
import { profileUrl } from '../../shared/creators';
import type {
  AccountInfo,
  LanguageHit,
  LocationHit,
  LookalikesInput,
  LookalikesResult,
  ModashApi,
  SearchResult,
  TextSearchInput,
} from './api';
import type { AiSearchFilters } from './schemas';

interface MockCreatorSeed {
  handle: string;
  name: string;
  topics: string[];
  category: string;
  followers: number;
  engagementRate: number;
  postsPerMonth: number;
  medianViews: number;
  language: string;
  hasEmail: boolean;
}

const SEEDS: MockCreatorSeed[] = [
  { handle: 'demo.aurora.sleeps', name: 'Aurora (demo)', topics: ['sleep', 'wellness', 'supplements', 'nighttime routine', 'magnesium'], category: 'Health & wellness', followers: 48_000, engagementRate: 0.041, postsPerMonth: 11, medianViews: 62_000, language: 'en', hasEmail: true },
  { handle: 'demo.calm.commute', name: 'Bo (demo)', topics: ['sleep', 'meditation', 'anxiety', 'wellness', 'journalling'], category: 'Mindfulness', followers: 121_000, engagementRate: 0.028, postsPerMonth: 8, medianViews: 140_000, language: 'en', hasEmail: false },
  { handle: 'demo.gutcheck.mom', name: 'Cass (demo)', topics: ['gut health', 'family', 'kids nutrition', 'wellness', 'supplements'], category: 'Parenting', followers: 34_000, engagementRate: 0.055, postsPerMonth: 16, medianViews: 41_000, language: 'en', hasEmail: true },
  { handle: 'demo.liftandlentils', name: 'Dee (demo)', topics: ['fitness', 'strength training', 'high protein', 'meal prep', 'supplements'], category: 'Fitness', followers: 260_000, engagementRate: 0.022, postsPerMonth: 20, medianViews: 310_000, language: 'en', hasEmail: true },
  { handle: 'demo.slowmorning.co', name: 'Eli (demo)', topics: ['morning routine', 'coffee', 'slow living', 'wellness', 'journalling'], category: 'Lifestyle', followers: 76_000, engagementRate: 0.038, postsPerMonth: 9, medianViews: 88_000, language: 'en', hasEmail: false },
  { handle: 'demo.trailandtent', name: 'Fen (demo)', topics: ['hiking', 'camping', 'outdoors', 'gear reviews', 'recovery'], category: 'Outdoor', followers: 158_000, engagementRate: 0.031, postsPerMonth: 12, medianViews: 205_000, language: 'en', hasEmail: true },
  { handle: 'demo.skinsciencedaily', name: 'Gia (demo)', topics: ['skincare', 'dermatology', 'beauty', 'routines', 'ingredients'], category: 'Beauty', followers: 410_000, engagementRate: 0.019, postsPerMonth: 18, medianViews: 520_000, language: 'en', hasEmail: true },
  { handle: 'demo.kitchen.minimal', name: 'Hal (demo)', topics: ['cooking', 'meal prep', 'high protein', 'budget recipes'], category: 'Food', followers: 92_000, engagementRate: 0.034, postsPerMonth: 22, medianViews: 130_000, language: 'en', hasEmail: false },
  { handle: 'demo.nachtruhe', name: 'Ida (demo)', topics: ['sleep', 'wellness', 'supplements', 'bedroom design'], category: 'Health & wellness', followers: 27_000, engagementRate: 0.047, postsPerMonth: 10, medianViews: 33_000, language: 'de', hasEmail: true },
  { handle: 'demo.dormirbien', name: 'Javi (demo)', topics: ['sleep', 'meditation', 'wellness', 'anxiety'], category: 'Health & wellness', followers: 65_000, engagementRate: 0.036, postsPerMonth: 14, medianViews: 71_000, language: 'es', hasEmail: false },
  { handle: 'demo.runsonrecovery', name: 'Kit (demo)', topics: ['running', 'recovery', 'sleep', 'supplements', 'marathon'], category: 'Fitness', followers: 183_000, engagementRate: 0.026, postsPerMonth: 15, medianViews: 240_000, language: 'en', hasEmail: true },
  { handle: 'demo.deskandplants', name: 'Lou (demo)', topics: ['productivity', 'home office', 'plants', 'slow living'], category: 'Lifestyle', followers: 19_000, engagementRate: 0.062, postsPerMonth: 7, medianViews: 22_000, language: 'en', hasEmail: false },
  { handle: 'demo.thriftedfits', name: 'Mira (demo)', topics: ['fashion', 'thrifting', 'styling', 'sustainability'], category: 'Fashion', followers: 340_000, engagementRate: 0.021, postsPerMonth: 24, medianViews: 460_000, language: 'en', hasEmail: true },
  { handle: 'demo.babystepsnaps', name: 'Nia (demo)', topics: ['parenting', 'baby sleep', 'family', 'kids nutrition'], category: 'Parenting', followers: 58_000, engagementRate: 0.044, postsPerMonth: 13, medianViews: 67_000, language: 'en', hasEmail: true },
  { handle: 'demo.gadgetgrease', name: 'Osk (demo)', topics: ['tech reviews', 'gadgets', 'home office', 'productivity'], category: 'Technology', followers: 520_000, engagementRate: 0.017, postsPerMonth: 10, medianViews: 780_000, language: 'en', hasEmail: true },
  { handle: 'demo.pilateswithp', name: 'Pia (demo)', topics: ['pilates', 'fitness', 'mobility', 'recovery', 'wellness'], category: 'Fitness', followers: 145_000, engagementRate: 0.033, postsPerMonth: 19, medianViews: 190_000, language: 'en', hasEmail: false },
  { handle: 'demo.quietcabin', name: 'Quinn (demo)', topics: ['slow living', 'cabin', 'outdoors', 'sleep', 'interiors'], category: 'Lifestyle', followers: 88_000, engagementRate: 0.037, postsPerMonth: 6, medianViews: 96_000, language: 'en', hasEmail: false },
  { handle: 'demo.reeltalkfinance', name: 'Rue (demo)', topics: ['personal finance', 'budgeting', 'investing'], category: 'Finance', followers: 230_000, engagementRate: 0.024, postsPerMonth: 21, medianViews: 300_000, language: 'en', hasEmail: true },
  { handle: 'demo.saunaandsalt', name: 'Sol (demo)', topics: ['recovery', 'sauna', 'cold plunge', 'sleep', 'wellness'], category: 'Health & wellness', followers: 41_000, engagementRate: 0.049, postsPerMonth: 12, medianViews: 55_000, language: 'en', hasEmail: true },
  { handle: 'demo.tinyapartmentbig', name: 'Tam (demo)', topics: ['interiors', 'small space', 'bedroom design', 'diy'], category: 'Home', followers: 112_000, engagementRate: 0.03, postsPerMonth: 14, medianViews: 150_000, language: 'en', hasEmail: false },
];

const LOCATION_FIXTURES: Array<{ id: number; title: string }> = [
  { id: 900001, title: 'Berlin, Germany (mock)' },
  { id: 900002, title: 'London, United Kingdom (mock)' },
  { id: 900003, title: 'New York, United States (mock)' },
  { id: 900004, title: 'United States (mock)' },
  { id: 900005, title: 'United Kingdom (mock)' },
  { id: 900006, title: 'Germany (mock)' },
  { id: 900007, title: 'Spain (mock)' },
  { id: 900008, title: 'Australia (mock)' },
];

const LANGUAGE_FIXTURES: LanguageHit[] = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'German' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'pt', name: 'Portuguese' },
];

export function createMockApi(): ModashApi {
  return {
    isMock: true,

    async textSearch({ platform, query, filters, page = 0, pageSize = 10 }: TextSearchInput): Promise<SearchResult> {
      await simulateLatency();

      const ranked = SEEDS.map((seed) => ({ seed, score: relevance(seed, query ?? '') }))
        .filter(({ seed }) => matchesFilters(seed, filters))
        .sort((a, b) => b.score - a.score || b.seed.followers - a.seed.followers);

      const window = ranked.slice(page * pageSize, page * pageSize + pageSize);

      return {
        total: ranked.length,
        creators: window.map(({ seed, score }) => toMockCreator(platform, seed, score)),
      };
    },

    async lookalikes({
      sourcePlatform,
      userIds,
      targetPlatform,
      filters,
      pageSize = 10,
    }: LookalikesInput): Promise<LookalikesResult> {
      await simulateLatency();

      const sources = userIds.map((id) => findSeed(id));
      const sourceTopics = new Set(sources.flatMap((seed) => seed.topics));

      const ranked = SEEDS.filter((seed) => !userIds.includes(seed.handle))
        .filter((seed) => matchesFilters(seed, filters))
        .map((seed) => ({
          seed,
          score: seed.topics.filter((topic) => sourceTopics.has(topic)).length,
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);

      return {
        total: ranked.length,
        creators: ranked.slice(0, pageSize).map(({ seed, score }) => toMockCreator(targetPlatform, seed, score)),
        sources: sources.map((seed) => toMockCreator(sourcePlatform, seed, 1)),
      };
    },

    async profileReport(platform: Platform, userIdOrUsername: string): Promise<AudienceReport> {
      await simulateLatency();
      const seed = findSeed(userIdOrUsername);
      const skew = (hash(seed.handle) % 30) / 100;

      return {
        platform,
        username: seed.handle,
        credibility: Number((0.68 + skew).toFixed(2)),
        followers: seed.followers,
        engagementRate: seed.engagementRate,
        topCountries: [
          { label: 'United States (mock)', weight: Number((0.4 + skew / 2).toFixed(2)) },
          { label: 'United Kingdom (mock)', weight: 0.14 },
          { label: 'Canada (mock)', weight: 0.09 },
        ],
        genders: [
          { label: 'FEMALE', weight: Number((0.55 + skew / 3).toFixed(2)) },
          { label: 'MALE', weight: Number((0.45 - skew / 3).toFixed(2)) },
        ],
        ageBrackets: [
          { label: '25-34', weight: 0.38 },
          { label: '18-24', weight: 0.27 },
          { label: '35-44', weight: 0.19 },
        ],
        contacts: seed.hasEmail ? [{ type: 'email', value: `hello@${seed.handle}.example` }] : [],
      };
    },

    async locations(_platform: Platform, query: string): Promise<LocationHit[]> {
      const needle = query.toLowerCase();
      return LOCATION_FIXTURES.filter((location) => location.title.toLowerCase().includes(needle)).slice(0, 8);
    },

    async languages(_platform: Platform, query: string): Promise<LanguageHit[]> {
      const needle = query.toLowerCase();
      return LANGUAGE_FIXTURES.filter(
        (language) => language.name.toLowerCase().includes(needle) || language.code === needle,
      );
    },

    async brands(query: string): Promise<string[]> {
      return [`${query} (mock brand)`];
    },

    async textTags(_platform: Platform, type: 'hashtag' | 'mention', query: string): Promise<string[]> {
      const slug = query.toLowerCase().replace(/[^a-z0-9]/g, '');
      return type === 'hashtag'
        ? [slug, `${slug}tips`, `${slug}routine`, `${slug}community`]
        : [`demo.${slug}`, `${slug}.official.demo`];
    },

    async accountInfo(): Promise<AccountInfo> {
      return { credits: 3_000, discoveryRateLimit: 500 };
    },
  };
}

function findSeed(idOrHandle: string): MockCreatorSeed {
  const normalised = idOrHandle.replace(/^@/, '').toLowerCase();
  return (
    SEEDS.find((seed) => seed.handle.toLowerCase() === normalised) ??
    SEEDS.find((seed) => seed.handle.toLowerCase().includes(normalised)) ??
    SEEDS[0]!
  );
}

/** Crude bag-of-words stand-in for vector similarity. */
function relevance(seed: MockCreatorSeed, query: string): number {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);

  const haystack = [...seed.topics, seed.category, seed.name].join(' ').toLowerCase();
  const hits = words.filter((word) => haystack.includes(word)).length;
  return hits + (seed.engagementRate > 0.035 ? 0.5 : 0);
}

function matchesFilters(seed: MockCreatorSeed, filters?: AiSearchFilters): boolean {
  if (!filters) return true;
  if (filters.followersCount?.min && seed.followers < filters.followersCount.min) return false;
  if (filters.followersCount?.max && seed.followers > filters.followersCount.max) return false;
  if (filters.engagementRate?.min && seed.engagementRate < filters.engagementRate.min) return false;
  if (filters.postingFrequency?.min && seed.postsPerMonth < filters.postingFrequency.min) return false;
  if (filters.postingFrequency?.max && seed.postsPerMonth > filters.postingFrequency.max) return false;
  if (filters.viewsCount?.min && seed.medianViews < filters.viewsCount.min) return false;
  if (filters.language && seed.language !== filters.language) return false;
  if (filters.hasEmail && !seed.hasEmail) return false;
  return true;
}

function toMockCreator(platform: Platform, seed: MockCreatorSeed, score: number): Creator {
  return {
    platform,
    userId: `mock-${seed.handle}`,
    username: seed.handle,
    fullName: seed.name,
    profilePicture: avatarDataUri(seed),
    profileUrl: profileUrl(platform, seed.handle),
    followers: seed.followers,
    engagementRate: seed.engagementRate,
    postsPerMonth: seed.postsPerMonth,
    medianViews: seed.medianViews,
    accountCategory: seed.category,
    matchedPosts: Array.from({ length: Math.min(3, 1 + Math.round(score)) }, (_, index) => ({
      thumbnail: thumbnailDataUri(seed, index),
      likes: Math.round(seed.medianViews * seed.engagementRate * (1 - index * 0.15)),
      comments: Math.round(seed.medianViews * seed.engagementRate * 0.06),
      views: Math.round(seed.medianViews * (1 - index * 0.1)),
    })),
  };
}

/** Locally generated placeholder art, so mock mode needs no network at all. */
function avatarDataUri(seed: MockCreatorSeed): string {
  const hue = hash(seed.handle) % 360;
  const initials = seed.name.slice(0, 1).toUpperCase();
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="hsl(${hue} 55% 32%)"/><text x="48" y="60" font-family="system-ui,sans-serif" font-size="38" fill="hsl(${hue} 90% 88%)" text-anchor="middle">${initials}</text></svg>`,
  );
}

function thumbnailDataUri(seed: MockCreatorSeed, index: number): string {
  const hue = (hash(seed.handle) + index * 47) % 360;
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 45%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 60% 22%)"/></linearGradient></defs><rect width="160" height="160" fill="url(#g)"/><text x="80" y="86" font-family="system-ui,sans-serif" font-size="13" fill="rgba(255,255,255,.75)" text-anchor="middle">mock post</text></svg>`,
  );
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function hash(value: string): number {
  let result = 0;
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) % 100_000;
  return result;
}

/** AI Search is a vector search over a large index; it is not instant. */
function simulateLatency(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 400));
}
