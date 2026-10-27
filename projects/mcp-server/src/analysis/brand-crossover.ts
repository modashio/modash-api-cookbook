import type { ModashClient } from '../server/modash/client.js';
import {
  addAiListMembers,
  aiTextSearch,
  createAiList,
  deleteAiList,
  getAiBrands,
  getAiLocations,
  getCollaborationPosts,
} from '../server/modash/endpoints.js';
import { ModashApiError } from '../server/modash/errors.js';
import type { Platform } from '../server/modash/filters.js';
import { aiSearchCost, CREDITS, roundCredits } from '../server/modash/pricing.js';
import { AI_SEARCH_INTERVAL_MS, DISCOVERY_INTERVAL_MS } from '../server/modash/rate-limit.js';

/**
 * Do creators pick a side between rival brands?
 *
 * The method, in five steps:
 *
 *   1. Resolve both brands to a brand identity hash with `GET /ai/brands` (free).
 *   2. Pull the posts about each brand from `POST /collaborations/posts`, passing that hash as the
 *      `id`, one week at a time (0.2 credits a page of up to 30 posts).
 *   3. Creators in both lists are the crossover; creators in either list are the base. The share is
 *      crossover / base.
 *   4. The posts log carries no creator location or size. To restrict the answer to, say, US
 *      creators with 10k+ followers, put the crossover creators and a random sample of the rest of
 *      the base into an AI Search list and ask AI Search which of them match (0.025 credits per
 *      creator returned). The sample is scaled up to estimate the filtered base.
 *   5. Repeat for two unrelated brands. A share means little on its own; the comparison with the
 *      unrelated pair is the answer.
 *
 * Everything that knows about URLs and prices stays in `server/modash/`. This file only decides
 * which calls to make, in what order, and what the numbers mean.
 */

export const TOOL = 'modash_brand_crossover';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** The documented maximum `limit` for `/collaborations/posts`. */
export const POSTS_PER_PAGE = 30;
/** AI Search pages at most 50 profiles, and `(page + 1) * pageSize` may not exceed 1,500. */
const AI_PAGE_SIZE = 50;
const AI_MAX_DEPTH = 1_500;
/** Below this many creators in both lists, a difference between two shares is mostly noise. */
export const SMALL_COUNT = 30;

/** AI Search snaps `followersCount.min` down to the nearest of these, per the API reference. */
const FOLLOWER_RUNGS = [
  1_000, 3_000, 5_000, 10_000, 15_000, 20_000, 25_000, 35_000, 50_000, 75_000, 100_000, 125_000,
  150_000, 175_000, 200_000, 250_000, 300_000, 350_000, 500_000, 1_000_000, 2_000_000, 3_000_000,
] as const;

export interface CrossoverOptions {
  platform: Platform;
  brandA: string;
  brandB: string;
  /** Two brands from unrelated categories, run the same way, as the yardstick. */
  baseline?: [string, string] | undefined;
  windowDays: number;
  /** `YYYY-MM-DD`, exclusive. Defaults to today (UTC). */
  endDate?: string | undefined;
  /** How many 7-day weeks to pull, spread evenly across the window. */
  sampleWeeks: number;
  maxPagesPerWeek: number;
  location?: string | undefined;
  minFollowers?: number | undefined;
  maxCrossoverLookups: number;
  baseSampleSize: number;
  seed: number;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers: the window, the sample, the ceiling
// ---------------------------------------------------------------------------------------------

export interface Week {
  from: number;
  /** Inclusive, in epoch milliseconds, as `postCreationTimestampMs.lte` expects. */
  to: number;
}

export function buildWindow(windowDays: number, endDate?: string, now = Date.now()) {
  const end =
    endDate === undefined ? Math.floor(now / DAY_MS) * DAY_MS : Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(end)) throw new Error(`endDate "${endDate}" is not a YYYY-MM-DD date.`);
  const start = end - windowDays * DAY_MS;

  const weeks: Week[] = [];
  for (let from = start; from < end; from += WEEK_MS) {
    weeks.push({ from, to: Math.min(from + WEEK_MS, end) - 1 });
  }
  return { from: start, to: end - 1, weeks };
}

/** `count` weeks spread evenly over the window, so a sample covers every season it spans. */
export function pickWeeks(weeks: Week[], count: number): Week[] {
  if (count >= weeks.length) return weeks;
  const picked = new Set<number>();
  for (let i = 0; i < count; i += 1) picked.add(Math.floor(((i + 0.5) * weeks.length) / count));
  return [...picked].sort((a, b) => a - b).map((index) => weeks[index]!);
}

export const snapFollowers = (min: number): number =>
  [...FOLLOWER_RUNGS].reverse().find((rung) => rung <= min) ?? FOLLOWER_RUNGS[0];

export interface Ceiling {
  postsCredits: number;
  lookupCredits: number;
  totalCredits: number;
  paidCalls: number;
  /** At this server's rate limits, before network time. */
  worstCaseSeconds: number;
}

/**
 * The most this analysis can spend, worked out before anything is sent.
 *
 * There is no documented way to count a brand's posts for free (`/collaborations/summary` does not
 * accept a brand id), so this is a ceiling rather than a forecast: every sampled week is assumed to
 * fill `maxPagesPerWeek` pages, and every lookup page is assumed full. Real runs cost less, because
 * a week with fewer posts stops early and an empty week answers `posts_not_found`, which is free.
 */
export function ceilingFor(
  options: Pick<
    CrossoverOptions,
    'maxPagesPerWeek' | 'maxCrossoverLookups' | 'baseSampleSize' | 'location' | 'minFollowers'
  >,
  brandCount: number,
  weekCount: number,
): Ceiling {
  const postPages = brandCount * weekCount * options.maxPagesPerWeek;
  const pairs = brandCount / 2;
  const lookupPagesPerPair = hasCreatorFilter(options)
    ? Math.ceil((options.maxCrossoverLookups + options.baseSampleSize) / AI_PAGE_SIZE)
    : 0;
  const lookupPages = pairs * lookupPagesPerPair;

  const postsCredits = roundCredits(postPages * CREDITS.collaborations);
  const lookupCredits = roundCredits(lookupPages * aiSearchCost(AI_PAGE_SIZE));
  return {
    postsCredits,
    lookupCredits,
    totalCredits: roundCredits(postsCredits + lookupCredits),
    paidCalls: postPages + lookupPages,
    worstCaseSeconds: Math.ceil(
      (postPages * DISCOVERY_INTERVAL_MS + lookupPages * AI_SEARCH_INTERVAL_MS) / 1000,
    ),
  };
}

const hasCreatorFilter = (options: Pick<CrossoverOptions, 'location' | 'minFollowers'>) =>
  options.location !== undefined || options.minFollowers !== undefined;

export interface CheaperOption {
  change: string;
  ceilingCredits: number;
}

/** The knobs worth turning when a run does not fit, each priced the same way as the run itself. */
export function cheaperOptions(
  options: CrossoverOptions,
  weeksInWindow: number,
  remaining: number,
): CheaperOption[] {
  const brands = options.baseline ? 4 : 2;
  const weeks = Math.min(options.sampleWeeks, weeksInWindow);
  const out: CheaperOption[] = [];
  const add = (change: string, opts: CrossoverOptions, brandCount: number, weekCount: number) =>
    out.push({ change, ceilingCredits: ceilingFor(opts, brandCount, weekCount).totalCredits });

  const lookups = ceilingFor(options, brands, 0).lookupCredits;
  const perWeek = brands * options.maxPagesPerWeek * CREDITS.collaborations;
  const fitWeeks = Math.min(weeksInWindow, Math.floor((remaining - lookups) / perWeek));
  if (fitWeeks >= 1 && fitWeeks < weeks) {
    add(`sampleWeeks: ${fitWeeks} (the most weeks that fit the remaining budget)`, options, brands, fitWeeks);
  }
  if (options.maxPagesPerWeek > 1) {
    const pages = Math.max(1, Math.floor(options.maxPagesPerWeek / 2));
    add(`maxPagesPerWeek: ${pages}`, { ...options, maxPagesPerWeek: pages }, brands, weeks);
  }
  if (weeks >= weeksInWindow && options.windowDays > 90) {
    const shorter = buildWindow(90).weeks.length;
    add('windowDays: 90', options, brands, Math.min(weeks, shorter));
  }
  if (hasCreatorFilter(options)) {
    add(
      'drop location and minFollowers (answers for all creators, skips the lookup step)',
      { ...options, location: undefined, minFollowers: undefined },
      brands,
      weeks,
    );
  }
  if (weeks < weeksInWindow) {
    add(`sampleWeeks: ${weeksInWindow} (every week; the full pull, most accurate)`, options, brands, weeksInWindow);
  }
  return out;
}

/** mulberry32: a few lines, seedable, and good enough to draw a sample a reader can reproduce. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function sample<T>(items: T[], count: number, random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, count);
}

// ---------------------------------------------------------------------------------------------
// Step 1: resolve the brands (free)
// ---------------------------------------------------------------------------------------------

export interface ResolvedBrand {
  input: string;
  brandId: string;
  name: string;
  matchedBy: 'domain' | 'brandId' | 'name';
  /** Other brand identities the same lookup returned. A domain can map to a sub-label too. */
  alternatives: { brandId: string; name: string }[];
}

const looksLikeBrandId = (value: string) => /^[0-9a-f]{16,}$/i.test(value);
const asDomain = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]!;

export async function resolveBrand(client: ModashClient, input: string): Promise<ResolvedBrand> {
  const value = input.trim();
  const matchedBy: ResolvedBrand['matchedBy'] = looksLikeBrandId(value)
    ? 'brandId'
    : /^[^\s]+\.[a-z]{2,}(\/.*)?$/i.test(value)
      ? 'domain'
      : 'name';

  const response = await getAiBrands(
    client,
    matchedBy === 'brandId'
      ? { brandId: value }
      : matchedBy === 'domain'
        ? { domain: asDomain(value) }
        : { query: value },
    TOOL,
  );

  const found = (response.result ?? []).filter(
    (brand): brand is typeof brand & { brandId: string } => typeof brand.brandId === 'string',
  );
  const [first, ...rest] = found;
  if (first === undefined) {
    throw new Error(
      `No brand found for "${input}" (looked up by ${matchedBy}). Try the brand's main website ` +
        `domain, e.g. "example.com", or its name.`,
    );
  }
  return {
    input,
    brandId: first.brandId,
    name: first.name ?? first.brandId,
    matchedBy,
    alternatives: rest.map((brand) => ({ brandId: brand.brandId, name: brand.name ?? brand.brandId })),
  };
}

// ---------------------------------------------------------------------------------------------
// Step 2: pull the posts about each brand
// ---------------------------------------------------------------------------------------------

export interface BrandPull {
  brand: ResolvedBrand;
  /** Creator user id to what we know about them from the log. */
  creators: Map<string, { username: string | undefined; posts: number }>;
  posts: number;
  /** Grouped brand ids return posts from every platform; only the one asked about is counted. */
  otherPlatformPosts: number;
  pages: number;
  weeksWithPosts: number;
  /** Weeks that still had more posts when `maxPagesPerWeek` ran out. */
  truncatedWeeks: number;
}

export async function pullBrand(
  client: ModashClient,
  brand: ResolvedBrand,
  platform: Platform,
  weeks: Week[],
  maxPagesPerWeek: number,
): Promise<BrandPull> {
  const pull: BrandPull = {
    brand,
    creators: new Map(),
    posts: 0,
    otherPlatformPosts: 0,
    pages: 0,
    weeksWithPosts: 0,
    truncatedWeeks: 0,
  };
  // A post with two co-authors comes back once per author; each author counts once.
  const seen = new Set<string>();

  for (const week of weeks) {
    let cursor: string | undefined;
    let pagesThisWeek = 0;
    let postsThisWeek = 0;

    for (;;) {
      if (pagesThisWeek === maxPagesPerWeek) {
        pull.truncatedWeeks += 1;
        break;
      }

      let page;
      try {
        page = await getCollaborationPosts(
          client,
          {
            id: brand.brandId,
            platform,
            groupBrandCollaborations: true,
            postCreationTimestampMs: { gte: week.from, lte: week.to },
            limit: POSTS_PER_PAGE,
            cursor,
          },
          TOOL,
        );
      } catch (error) {
        // Documented as a 404 that is not billed: nothing about this brand in this week.
        if (error instanceof ModashApiError && error.code === 'posts_not_found') break;
        throw error;
      }
      pagesThisWeek += 1;
      pull.pages += 1;

      const side = page.brand;
      for (const post of side?.posts ?? []) {
        if (post.user_id === undefined) continue;
        if (post.platform !== undefined && post.platform !== platform) {
          pull.otherPlatformPosts += 1;
          continue;
        }
        const key = `${post.post_id ?? ''}:${post.user_id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        postsThisWeek += 1;
        const creator = pull.creators.get(post.user_id) ?? { username: post.username, posts: 0 };
        creator.posts += 1;
        pull.creators.set(post.user_id, creator);
      }

      cursor = page.cursor;
      if (!side?.is_more_available || !cursor || (side.posts ?? []).length === 0) break;
    }

    pull.posts += postsThisWeek;
    if (postsThisWeek > 0) pull.weeksWithPosts += 1;
  }

  return pull;
}

// ---------------------------------------------------------------------------------------------
// Step 3: crossover and base
// ---------------------------------------------------------------------------------------------

export interface PairResult {
  brands: [string, string];
  creatorsA: number;
  creatorsB: number;
  /** Creators who posted about either brand: the base. */
  either: number;
  /** Creators who posted about both: the crossover. */
  both: number;
  /** both / either. */
  crossoverShare: number;
  /** both / creatorsA: of the creators who posted about A, how many also posted about B. */
  shareOfAAlsoB: number;
  shareOfBAlsoA: number;
  exampleCrossoverCreators: { username: string; postsAboutA: number; postsAboutB: number }[];
}

const ratio = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 10_000) / 10_000);

export function comparePair(a: BrandPull, b: BrandPull) {
  const both = [...a.creators.keys()].filter((id) => b.creators.has(id)).sort();
  const eitherOnly = [...new Set([...a.creators.keys(), ...b.creators.keys()])]
    .filter((id) => !(a.creators.has(id) && b.creators.has(id)))
    .sort();
  const either = both.length + eitherOnly.length;

  const result: PairResult = {
    brands: [a.brand.name, b.brand.name],
    creatorsA: a.creators.size,
    creatorsB: b.creators.size,
    either,
    both: both.length,
    crossoverShare: ratio(both.length, either),
    shareOfAAlsoB: ratio(both.length, a.creators.size),
    shareOfBAlsoA: ratio(both.length, b.creators.size),
    exampleCrossoverCreators: both
      .map((id) => ({
        username: a.creators.get(id)?.username ?? b.creators.get(id)?.username ?? id,
        postsAboutA: a.creators.get(id)!.posts,
        postsAboutB: b.creators.get(id)!.posts,
      }))
      .sort((x, y) => y.postsAboutA + y.postsAboutB - (x.postsAboutA + x.postsAboutB))
      .slice(0, 5),
  };
  return { result, bothIds: both, eitherOnlyIds: eitherOnly };
}

// ---------------------------------------------------------------------------------------------
// Step 4: the optional location and follower filter, via an AI Search list
// ---------------------------------------------------------------------------------------------

export interface CreatorFilter {
  locationId?: number | undefined;
  locationTitle?: string | undefined;
  minFollowers?: number | undefined;
}

export interface FilteredPairResult {
  crossoverLookedUp: number;
  crossoverMatched: number;
  baseSampled: number;
  baseSampleMatched: number;
  /** Scaled up from the lookups: how many creators in both lists match the filter. */
  estimatedBothMatching: number;
  estimatedEitherMatching: number;
  crossoverShare: number;
}

export async function resolveLocation(client: ModashClient, platform: Platform, location: string) {
  const response = await getAiLocations(client, { query: location, platform, limit: 5 }, TOOL);
  const first = response.result?.[0];
  if (first?.id === undefined) {
    throw new Error(`No AI Search location matches "${location}". Try a country or city name.`);
  }
  return { id: first.id, title: first.title ?? first.name ?? location };
}

export async function filterPair(
  client: ModashClient,
  platform: Platform,
  pair: { bothIds: string[]; eitherOnlyIds: string[] },
  filter: CreatorFilter,
  limits: { maxCrossoverLookups: number; baseSampleSize: number },
  random: () => number,
): Promise<FilteredPairResult> {
  const crossLooked =
    pair.bothIds.length > limits.maxCrossoverLookups
      ? sample(pair.bothIds, limits.maxCrossoverLookups, random)
      : pair.bothIds;
  const baseLooked = sample(pair.eitherOnlyIds, limits.baseSampleSize, random);
  const ids = [...crossLooked, ...baseLooked];

  const matched = new Set<string>();
  if (ids.length > 0) {
    const list = await createAiList(client, { name: 'brand crossover lookup', platform }, TOOL);
    try {
      await addAiListMembers(client, { listId: list.listId, influencerIds: ids }, TOOL);
      const filters = {
        lists: { listIds: [list.listId], mode: 'include' },
        ...(filter.locationId === undefined ? {} : { locations: [filter.locationId] }),
        ...(filter.minFollowers === undefined ? {} : { followersCount: { min: filter.minFollowers } }),
      };
      const pages = Math.ceil(ids.length / AI_PAGE_SIZE);
      for (let page = 0; page < pages && (page + 1) * AI_PAGE_SIZE <= AI_MAX_DEPTH; page += 1) {
        const response = await aiTextSearch(
          client,
          { platform, filters, page, pageSize: AI_PAGE_SIZE },
          TOOL,
        );
        const profiles = response.profiles ?? [];
        for (const profile of profiles) if (profile.userId !== undefined) matched.add(String(profile.userId));
        if (profiles.length < AI_PAGE_SIZE) break;
      }
    } finally {
      // Lists count towards a per-account limit, so do not leave one behind, even after a failure.
      await deleteAiList(client, { listId: list.listId }, TOOL).catch(() => undefined);
    }
  }

  const crossoverMatched = crossLooked.filter((id) => matched.has(id)).length;
  const baseSampleMatched = baseLooked.filter((id) => matched.has(id)).length;
  const estimatedBoth = crossLooked.length === 0 ? 0 : (crossoverMatched / crossLooked.length) * pair.bothIds.length;
  const estimatedRest =
    baseLooked.length === 0 ? 0 : (baseSampleMatched / baseLooked.length) * pair.eitherOnlyIds.length;

  return {
    crossoverLookedUp: crossLooked.length,
    crossoverMatched,
    baseSampled: baseLooked.length,
    baseSampleMatched,
    estimatedBothMatching: Math.round(estimatedBoth),
    estimatedEitherMatching: Math.round(estimatedBoth + estimatedRest),
    crossoverShare: ratio(estimatedBoth, estimatedBoth + estimatedRest),
  };
}

// ---------------------------------------------------------------------------------------------
// Step 5: read rival against baseline
// ---------------------------------------------------------------------------------------------

export function readComparison(rival: { share: number; both: number }, baseline?: { share: number; both: number }) {
  if (baseline === undefined) {
    return {
      ratio: undefined,
      reading:
        'No baseline was run, so there is nothing to say whether this share is high or low. Run ' +
        'two unrelated brands as the baseline to answer the question.',
    };
  }
  const value = baseline.share === 0 ? undefined : Math.round((rival.share / baseline.share) * 100) / 100;
  if (rival.both < SMALL_COUNT || baseline.both < SMALL_COUNT) {
    return {
      ratio: value,
      reading:
        `Fewer than ${SMALL_COUNT} creators posted about both brands in at least one pair ` +
        `(rival ${rival.both}, baseline ${baseline.both}), so the difference is mostly noise. ` +
        'Pull more weeks or a longer window before reading anything into it.',
    };
  }
  if (value === undefined) {
    return { ratio: value, reading: 'The baseline pair shares no creators, so there is nothing to compare against.' };
  }
  const reading =
    value < 0.8
      ? 'Creators of one rival post about the other less often than creators of two unrelated ' +
        'brands share each other. That is consistent with creators picking a side.'
      : value > 1.25
        ? 'The rivals share more creators than the unrelated baseline does. Creators in this ' +
          'category tend to work with both brands rather than pick a side.'
        : 'The rivals share creators at about the same rate as the unrelated baseline. No sign ' +
          'that creators pick a side.';
  return { ratio: value, reading };
}

// ---------------------------------------------------------------------------------------------
// The plan and the run
// ---------------------------------------------------------------------------------------------

export interface CrossoverPlan {
  platform: Platform;
  window: { from: string; to: string; days: number };
  sampling: { weeksInWindow: number; weeksPulled: number; maxPagesPerWeek: number; fullPull: boolean };
  brands: ResolvedBrand[];
  creatorFilter: CreatorFilter | undefined;
  ceiling: Ceiling;
  weeks: Week[];
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Everything free: resolve the names, lay out the weeks, and price the worst case. */
export async function planCrossover(client: ModashClient, options: CrossoverOptions): Promise<CrossoverPlan> {
  const window = buildWindow(options.windowDays, options.endDate);
  const weeks = pickWeeks(window.weeks, options.sampleWeeks);

  const inputs = [options.brandA, options.brandB, ...(options.baseline ?? [])];
  const brands: ResolvedBrand[] = [];
  for (const input of inputs) brands.push(await resolveBrand(client, input));

  const ids = brands.map((brand) => brand.brandId);
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      `Two of the inputs resolved to the same brand (${brands.map((b) => `${b.input} -> ${b.name}`).join(', ')}). ` +
        'Use four different brands, or pass a brandId from the alternatives.',
    );
  }

  let creatorFilter: CreatorFilter | undefined;
  if (hasCreatorFilter(options)) {
    const location =
      options.location === undefined ? undefined : await resolveLocation(client, options.platform, options.location);
    creatorFilter = {
      locationId: location?.id,
      locationTitle: location?.title,
      minFollowers: options.minFollowers === undefined ? undefined : snapFollowers(options.minFollowers),
    };
  }

  return {
    platform: options.platform,
    window: { from: isoDay(window.from), to: isoDay(window.to), days: options.windowDays },
    sampling: {
      weeksInWindow: window.weeks.length,
      weeksPulled: weeks.length,
      maxPagesPerWeek: options.maxPagesPerWeek,
      fullPull: weeks.length === window.weeks.length,
    },
    brands,
    creatorFilter,
    ceiling: ceilingFor(options, brands.length, weeks.length),
    weeks,
  };
}

export async function runCrossover(client: ModashClient, options: CrossoverOptions, plan: CrossoverPlan) {
  const pulls: BrandPull[] = [];
  for (const brand of plan.brands) {
    pulls.push(await pullBrand(client, brand, options.platform, plan.weeks, options.maxPagesPerWeek));
  }

  const [a, b, c, d] = pulls;
  const rival = comparePair(a!, b!);
  const baseline = c && d ? comparePair(c, d) : undefined;

  const random = seededRandom(options.seed);
  const limits = { maxCrossoverLookups: options.maxCrossoverLookups, baseSampleSize: options.baseSampleSize };
  let filtered: { rival: FilteredPairResult; baseline: FilteredPairResult | undefined } | undefined;
  if (plan.creatorFilter !== undefined) {
    filtered = {
      rival: await filterPair(client, options.platform, rival, plan.creatorFilter, limits, random),
      baseline: baseline
        ? await filterPair(client, options.platform, baseline, plan.creatorFilter, limits, random)
        : undefined,
    };
  }

  const shares = filtered
    ? {
        rival: { share: filtered.rival.crossoverShare, both: filtered.rival.crossoverMatched },
        baseline: filtered.baseline && {
          share: filtered.baseline.crossoverShare,
          both: filtered.baseline.crossoverMatched,
        },
      }
    : {
        rival: { share: rival.result.crossoverShare, both: rival.result.both },
        baseline: baseline && { share: baseline.result.crossoverShare, both: baseline.result.both },
      };

  return {
    pulls,
    rival: rival.result,
    baseline: baseline?.result,
    filtered,
    comparison: {
      rivalShare: shares.rival.share,
      baselineShare: shares.baseline?.share,
      ...readComparison(shares.rival, shares.baseline),
    },
  };
}
