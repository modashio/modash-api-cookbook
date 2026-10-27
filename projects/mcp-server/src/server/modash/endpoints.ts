import type { ModashClient } from './client.js';
import type { Platform } from './filters.js';
import { aiSearchCost, CREDITS, emailSearchCost, searchCost } from './pricing.js';
import * as schemas from './responses.js';

/**
 * One function per Discovery endpoint: the path it hits, what it costs, and the schema it parses.
 *
 * Nothing above this file knows about URLs, and nothing below it knows about MCP. If you want to
 * audit which endpoints this server can reach and what each one spends, this file is the whole
 * answer. Per-endpoint pricing is documented at https://docs.modash.io.
 */

/**
 * Both `search` and `report` take an optional `calculationMethod`, and both default to `median`.
 *
 * It stays undefined here unless the caller actually wants `average`. Spelling out a value that is
 * already the default adds nothing to the request, and a request that carries extra parameters is
 * not necessarily priced like the bare one the documentation shows you.
 */
export type CalculationMethod = 'median' | 'average';

// ---------------------------------------------------------------------------------------------
// Free: GET /user/info, GET /{platform}/users, and the dictionaries
// ---------------------------------------------------------------------------------------------

/** `GET /user/info` — 0 credits. The right first call: it proves auth without spending anything. */
export const getUserInfo = (client: ModashClient) =>
  client.call({
    request: { method: 'GET', path: '/user/info' },
    schema: schemas.userInfoSchema,
    cost: 0,
    tool: 'modash_get_account',
    detail: 'user info',
  });

/**
 * `GET /{platform}/users` — 0 credits.
 *
 * Resolve handles here before spending a credit on a report. Getting the handle wrong and paying
 * for the resulting `account_not_found` is not a thing that happens (failures are not billed), but
 * getting the *wrong creator* and paying a credit for their report certainly is.
 */
export const listUsers = (
  client: ModashClient,
  { platform, query, limit }: { platform: Platform; query: string; limit?: number },
) =>
  client.call({
    request: { method: 'GET', path: `/${platform}/users`, query: { query, limit } },
    schema: schemas.listUsersSchema,
    cost: 0,
    tool: 'modash_find_creator',
    detail: `${platform} "${query}"`,
  });

export const DICTIONARY_KINDS = [
  'interests',
  'brands',
  'locations',
  'languages',
  'topics',
  'hashtags',
] as const;
export type DictionaryKind = (typeof DICTIONARY_KINDS)[number];

/**
 * `GET /{platform}/{kind}` — 0 credits.
 *
 * Six endpoints per platform behind one call. `interests` and `brands` are Instagram only; the
 * caller checks that, because "Instagram only" is easier to explain than a 400.
 */
export const getDictionary = (
  client: ModashClient,
  {
    platform,
    kind,
    query,
    limit,
  }: { platform: Platform; kind: DictionaryKind; query?: string; limit?: number },
) =>
  client.call({
    request: { method: 'GET', path: `/${platform}/${kind}`, query: { query, limit } },
    schema: schemas.dictionarySchema,
    cost: 0,
    tool: 'modash_lookup_dictionary',
    detail: `${platform} ${kind}`,
  });

/**
 * `GET /ai/brands` — 0 credits. Names for AI Search filters; unrelated to the numeric brand ids.
 *
 * Each result also carries a `brandId`, the brand identity hash. `/collaborations/posts` accepts
 * that hash as its `id` and then returns posts about every account the brand owns, which is what
 * the brand crossover analysis is built on. `domain` and `brandId` are exact matches; `query` is
 * fuzzy.
 */
export const getAiBrands = (
  client: ModashClient,
  {
    query,
    domain,
    brandId,
    platform,
  }: { query?: string; domain?: string; brandId?: string; platform?: Platform },
  tool = 'modash_lookup_ai_dictionary',
) =>
  client.call({
    request: { method: 'GET', path: '/ai/brands', query: { query, domain, brandId, platform } },
    schema: schemas.aiBrandsSchema,
    cost: 0,
    tool,
    detail: `ai brands ${domain ?? brandId ?? query ?? ''}`.trim(),
  });

/** `GET /ai/locations` — 0 credits. Location ids for AI Search filters only. */
export const getAiLocations = (
  client: ModashClient,
  { query, platform, limit }: { query: string; platform?: Platform; limit?: number },
  tool: string,
) =>
  client.call({
    request: { method: 'GET', path: '/ai/locations', query: { query, platform, limit } },
    schema: schemas.aiLocationsSchema,
    cost: 0,
    tool,
    detail: `ai locations "${query}"`,
  });

/**
 * `POST /ai/lists`, `POST /ai/lists/{listId}/members`, `DELETE /ai/lists/{listId}` — 0 credits.
 *
 * A list is how you ask AI Search a question about creators you already have ids for: put them in
 * a list, then search with `filters.lists` set to include it. Only the search is billed.
 */
export const createAiList = (
  client: ModashClient,
  { name, platform }: { name: string; platform: Platform },
  tool: string,
) =>
  client.call({
    request: { method: 'POST', path: '/ai/lists', body: { name, platform } },
    schema: schemas.aiListSchema,
    cost: 0,
    tool,
    detail: `create ai list (${platform})`,
  });

/** Max 10,000 ids per request. Platform user ids only; handles are rejected. */
export const addAiListMembers = (
  client: ModashClient,
  { listId, influencerIds }: { listId: string; influencerIds: string[] },
  tool: string,
) =>
  client.call({
    request: { method: 'POST', path: `/ai/lists/${encodeURIComponent(listId)}/members`, body: { influencerIds } },
    schema: schemas.aiListMembersSchema,
    cost: 0,
    tool,
    detail: `add ${influencerIds.length} ids to ai list`,
  });

export const deleteAiList = (client: ModashClient, { listId }: { listId: string }, tool: string) =>
  client.call({
    request: { method: 'DELETE', path: `/ai/lists/${encodeURIComponent(listId)}` },
    schema: schemas.emptySchema,
    cost: 0,
    tool,
    detail: 'delete ai list',
  });

/** `GET /ai/hashtags` and `GET /ai/mentions` — 0 credits. Mentions are not available for YouTube. */
export const getAiTags = (
  client: ModashClient,
  { kind, platform, query }: { kind: 'hashtags' | 'mentions'; platform: Platform; query?: string },
) =>
  client.call({
    request: { method: 'GET', path: `/ai/${kind}`, query: { platform, query } },
    schema: schemas.aiTagsSchema,
    cost: 0,
    tool: 'modash_lookup_ai_dictionary',
    detail: `ai ${kind} (${platform})`,
  });

// ---------------------------------------------------------------------------------------------
// Paid
// ---------------------------------------------------------------------------------------------

/**
 * `POST /{platform}/search` — 0.01 credits per result, and the page size is fixed at 15, so every
 * call costs 0.15 whether you read all fifteen results or one. There is no `limit` parameter to
 * turn down.
 *
 * Sending an empty `filter` object is free on Instagram, which is what mock mode's search fixture
 * is modelled on and what you can safely point a live token at while exploring.
 */
export const searchCreators = (
  client: ModashClient,
  {
    platform,
    filter,
    sort,
    page,
    calculationMethod,
  }: {
    platform: Platform;
    filter: unknown;
    sort?: unknown;
    page?: number;
    calculationMethod?: CalculationMethod;
  },
) => {
  // Always send a filter object, even an empty one: that is the shape the docs give for the free
  // Instagram probe, and it is what makes the cost below correct rather than optimistic.
  const body = { filter: filter ?? {}, sort, page, calculationMethod };
  const isFreeProbe = platform === 'instagram' && isEmptyFilter(body.filter);

  return client.call({
    request: { method: 'POST', path: `/${platform}/search`, body },
    schema: schemas.searchSchema,
    cost: isFreeProbe ? 0 : searchCost(),
    tool: 'modash_search_creators',
    detail: `${platform} search page ${page ?? 0}`,
  });
};

const isEmptyFilter = (filter: unknown): boolean =>
  typeof filter === 'object' &&
  filter !== null &&
  Object.values(filter).every((value) => value === undefined);

/**
 * `POST /ai/{platform}/text-search` — 0.025 credits per profile returned, so the cost is
 * `0.025 * pageSize` and is known before the call. At the maximum pageSize of 50 that is 1.25
 * credits, more than a full profile report. Limited to 1 request per second.
 */
export const aiTextSearch = (
  client: ModashClient,
  {
    platform,
    query,
    filters,
    page,
    pageSize,
  }: {
    platform: Platform;
    /** Optional in the API: without one, results come back sorted by follower count. */
    query?: string;
    filters?: unknown;
    page?: number;
    pageSize: number;
  },
  tool = 'modash_ai_search_creators',
) =>
  client.call({
    request: {
      method: 'POST',
      path: `/ai/${platform}/text-search`,
      body: { query, filters, page, pageSize },
    },
    schema: schemas.aiSearchSchema,
    cost: aiSearchCost(pageSize),
    tool,
    detail: `${platform} "${(query ?? '').slice(0, 60)}" x${pageSize}`,
    queue: 'ai-search',
  });

/** `POST /ai/{platform}/lookalikes` — 0.025 credits per returned profile. 1 request per second. */
export const aiLookalikes = (
  client: ModashClient,
  {
    platform,
    userIds,
    targetPlatform,
    filters,
    page,
    pageSize,
  }: {
    platform: Platform;
    userIds: string[];
    targetPlatform?: Platform;
    filters?: unknown;
    page?: number;
    pageSize: number;
  },
) =>
  client.call({
    request: {
      method: 'POST',
      path: `/ai/${platform}/lookalikes`,
      // Always `userIds`, even for one creator. The singular `userId` field is deprecated.
      body: { userIds, targetPlatform, filters, page, pageSize },
    },
    schema: schemas.aiLookalikesSchema,
    cost: aiSearchCost(pageSize),
    tool: 'modash_find_lookalikes',
    detail: `${platform} lookalikes of ${userIds.join(', ')} x${pageSize}`,
    queue: 'ai-search',
  });

/**
 * `GET /{platform}/profile/{userId}/report` — 1 credit, the most expensive routine call here.
 *
 * `userId=instagram` on the Instagram route is free *as a bare request* and returns a complete
 * report, which is how you inspect the full response shape without paying for it. Adding
 * `calculationMethod` — even the documented default of `median` — turns that probe into a billed
 * call, so the cost below only stays at zero when the query is left unset.
 */
export const getReport = (
  client: ModashClient,
  {
    platform,
    userId,
    calculationMethod,
  }: { platform: Platform; userId: string; calculationMethod?: CalculationMethod },
) => {
  const isFreeProbe =
    platform === 'instagram' && userId === 'instagram' && calculationMethod === undefined;

  return client.call({
    request: {
      method: 'GET',
      path: `/${platform}/profile/${encodeURIComponent(userId)}/report`,
      query: { calculationMethod },
    },
    schema: schemas.reportSchema,
    cost: isFreeProbe ? 0 : CREDITS.report,
    tool: 'modash_get_creator_report',
    detail: `${platform}/${userId}`,
  });
};

/** `POST /{platform}/reports/audience/overlap` — 1 credit flat. Instagram and YouTube only. */
export const getAudienceOverlap = (
  client: ModashClient,
  { platform, influencers }: { platform: 'instagram' | 'youtube'; influencers: string[] },
) =>
  client.call({
    request: {
      method: 'POST',
      path: `/${platform}/reports/audience/overlap`,
      body: { influencers },
    },
    schema: schemas.audienceOverlapSchema,
    cost: CREDITS.audienceOverlap,
    tool: 'modash_compare_audience_overlap',
    detail: `${platform}: ${influencers.join(', ')}`,
  });

/**
 * `POST /email-search` — 0.02 credits per *matched* email, but the account balance must cover
 * every email submitted, so that submitted count is what gets budgeted.
 */
export const searchByEmail = (client: ModashClient, { emails }: { emails: string[] }) =>
  client.call({
    request: { method: 'POST', path: '/email-search', body: { emails } },
    schema: schemas.emailSearchSchema,
    cost: emailSearchCost(emails.length),
    tool: 'modash_find_creators_by_email',
    detail: `${emails.length} email(s)`,
  });

/** `POST /collaborations/posts` — 0.2 credits. Cursor pagination; the cursor is valid for 2 days. */
export const getCollaborationPosts = (
  client: ModashClient,
  body: {
    id: string;
    platform: Platform;
    collaboratorId?: string;
    postCreationTimestampMs?: { gte?: number; lte?: number };
    cursor?: string;
    limit?: number;
    groupBrandCollaborations?: boolean;
  },
  tool = 'modash_list_collaborations',
) =>
  client.call({
    request: { method: 'POST', path: '/collaborations/posts', body },
    schema: schemas.collaborationsSchema,
    cost: CREDITS.collaborations,
    tool,
    detail: `${body.platform}/${body.id}`,
  });

/** `POST /collaborations/summary` — 0.2 credits. Brand ids are not accepted here, unlike /posts. */
export const getCollaborationSummary = (
  client: ModashClient,
  body: {
    id: string;
    platform: Platform;
    collaboratorId?: string;
    cursor?: string;
    limit?: number;
    groupBrandCollaborations?: boolean;
  },
) =>
  client.call({
    request: { method: 'POST', path: '/collaborations/summary', body },
    schema: schemas.collaborationsSchema,
    cost: CREDITS.collaborations,
    tool: 'modash_summarise_collaborations',
    detail: `${body.platform}/${body.id}`,
  });
