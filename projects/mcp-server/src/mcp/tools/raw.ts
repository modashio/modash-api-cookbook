import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

import { platformSchema, PLATFORMS, type Platform } from '../../server/modash/filters.js';
import {
  BROWSE_ENDPOINTS,
  callRaw,
  capArrays,
  COMMENT_ENDPOINTS,
  COMMENT_REPLY_ENDPOINTS,
  findPageInfo,
  POST_ENDPOINTS,
  POST_LIST_ENDPOINTS,
  PROFILE_ENDPOINTS,
  SEARCH_ENDPOINTS,
  type RawEndpoint,
  YOUTUBE_SHORT_ENDPOINT,
} from '../../server/modash/raw.js';
import type { ToolContext } from '../context.js';
import { guard, problem, respond } from '../result.js';

/**
 * The RAW API as six tools over twenty-eight of its thirty-three endpoints.
 *
 * The grouping is by job rather than by route, for the same reason the Discovery tools are: a
 * model picks worse from a longer list, and thirty-three more entries would roughly quadruple the
 * tool list. Each tool takes a `platform` and, where the platforms diverge, a `kind`, and the
 * combinations that do not exist are refused locally with a message saying so — which matters more
 * here than in Discovery, because a rejected RAW call is a request you would otherwise have paid
 * for.
 *
 * Not exposed: TikTok's two media-download endpoints, which return media files rather than data,
 * the challenge and music metadata endpoints, whose feeds are reachable through
 * `modash_raw_browse`, and YouTube's subtitle endpoint.
 */

/** Cost accounting, in the RAW API's own unit. Every result carries it. */
const spendSchema = z.object({
  rawRequestsThisCall: z.number(),
  rawRequestsThisSession: z.number(),
  rawRequestsRemainingInBudget: z.number(),
});

const pageSchema = {
  /** Pass back as `after` to get the next page. Each page is another billed request. */
  nextCursor: z.string().optional(),
  hasMore: z.boolean().optional(),
  /** True when arrays in `data` were shortened to fit `maxItems`. The full page was still paid for. */
  capped: z.boolean(),
};

const afterSchema = z
  .string()
  .optional()
  .describe('Cursor from a previous call, to get the next page. Costs another request.');

const maxItemsSchema = z
  .number()
  .int()
  .min(1)
  .max(200)
  .default(10)
  .describe('Cap on how many entries of each list come back. Local only; the full page is billed.');

export function registerRawTools(server: McpServer, ctx: ToolContext): void {
  /** Shared shape for a RAW result: what it spent, where the next page is, and the payload as-is. */
  const rawResult = <Extra extends z.ZodRawShape>(extra: Extra) =>
    z.object({ ...pageSchema, ...extra, spend: spendSchema, data: z.unknown() });

  const run = async (
    call: () => Promise<unknown>,
    maxItems: number,
    extra: Record<string, unknown> = {},
  ) => {
    const before = ctx.rawLedger.spent;
    const body = await call();
    const { value, capped } = capArrays(body, maxItems);

    return respond({
      ...extra,
      ...findPageInfo(body),
      capped,
      spend: {
        rawRequestsThisCall: ctx.rawLedger.spent - before,
        rawRequestsThisSession: ctx.rawLedger.spent,
        rawRequestsRemainingInBudget: ctx.rawLedger.remaining,
      },
      data: value,
    });
  };

  /**
   * Says which platforms a given job supports, rather than letting a 400 eat a request. The RAW
   * API is uneven — Instagram has tagged feeds, YouTube has streams, only Instagram searches
   * hashtags — and every unsupported combination a model tries would otherwise cost real quota.
   */
  const resolve = (
    map: Partial<Record<Platform, RawEndpoint>>,
    platform: Platform,
    what: string,
  ): { endpoint: RawEndpoint } | { error: string } => {
    const endpoint = map[platform];
    if (endpoint) return { endpoint };

    const supported = PLATFORMS.filter((candidate) => map[candidate]);
    return {
      error: supported.length
        ? `The RAW API has no ${what} endpoint for ${platform}. Supported: ${supported.join(', ')}.`
        : `The RAW API has no ${what} endpoint.`,
    };
  };

  server.registerTool(
    'modash_raw_get_profile',
    {
      title: 'Get a live creator profile',
      description:
        'Fetches a creator profile from the platform right now, unfiltered and uncached: follower ' +
        'counts, bio, links, verification, and whatever else the platform exposes. Costs 1 RAW ' +
        'request, which comes from a separate allowance to Discovery credits and is charged even ' +
        'if the call fails. Use this when freshness matters — a final check before activating a ' +
        'creator. For audience demographics, credibility or brand affinity use ' +
        'modash_get_creator_report instead; those are Modash analysis and are not in raw data.',
      inputSchema: z.object({
        platform: platformSchema,
        creator: z.string().min(1).describe('@handle, user id, or profile URL'),
        maxItems: maxItemsSchema,
      }),
      outputSchema: rawResult({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, creator, maxItems }) => {
      const resolved = resolve(PROFILE_ENDPOINTS, platform, 'profile');
      if ('error' in resolved) return problem(resolved.error);
      const { endpoint } = resolved;
      return run(
        () => callRaw(ctx.client, { endpoint, target: creator, tool: 'modash_raw_get_profile' }),
        maxItems,
      );
    }),
  );

  server.registerTool(
    'modash_raw_list_posts',
    {
      title: 'List a creator\'s posts',
      description:
        'Lists what a creator has posted, live from the platform, with per-post engagement as it ' +
        'stands now. Costs 1 RAW request per page, billed even on failure. Kinds: posts (all ' +
        'three platforms), shortForm for Instagram reels and YouTube shorts, live for YouTube ' +
        'streams, tagged for Instagram posts the creator was tagged in. Paginate with the ' +
        'nextCursor from the previous call; each page is another request, so stop as soon as you ' +
        'have what you need.',
      inputSchema: z.object({
        platform: platformSchema,
        creator: z.string().min(1).describe('@handle, user id, or profile or channel URL'),
        kind: z.enum(['posts', 'shortForm', 'live', 'tagged']).default('posts'),
        sortBy: z
          .enum(['date', 'popularity'])
          .optional()
          .describe('YouTube only. Defaults to date, newest first.'),
        after: afterSchema,
        maxItems: maxItemsSchema,
      }),
      outputSchema: rawResult({ kind: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, creator, kind, sortBy, after, maxItems }) => {
      const resolved = resolve(POST_LIST_ENDPOINTS[kind] ?? {}, platform, `"${kind}"`);
      if ('error' in resolved) return problem(resolved.error);
      const { endpoint } = resolved;

      // `/raw/ig/user-reels` is the one list endpoint where the cursor is not optional.
      if (endpoint.path === '/raw/ig/user-reels' && after === undefined) {
        return problem(
          'Instagram reels require a cursor. Call this with kind="posts" first and pass its ' +
            'nextCursor as `after`.',
        );
      }

      return run(
        () =>
          callRaw(ctx.client, {
            endpoint,
            target: creator,
            query: { after, ...(sortBy ? { sorted_by: sortBy === 'popularity' ? 'p' : 'dd' } : {}) },
            tool: 'modash_raw_list_posts',
          }),
        maxItems,
        { kind },
      );
    }),
  );

  server.registerTool(
    'modash_raw_get_post',
    {
      title: 'Get a live post',
      description:
        'Fetches one post with its current engagement counts, captions, media URLs and whatever ' +
        'else the platform returns. Costs 1 RAW request, billed even on failure. The identifier ' +
        'differs per platform: Instagram wants the shortcode from instagram.com/p/<code>, TikTok ' +
        'a post id or URL, YouTube a watch URL. Set isShort for a YouTube short, which has its ' +
        'own endpoint.',
      inputSchema: z.object({
        platform: platformSchema,
        post: z.string().min(1).describe('Instagram shortcode, TikTok post id or URL, YouTube URL'),
        isShort: z.boolean().default(false).describe('YouTube only. Shorts use a separate endpoint.'),
        maxItems: maxItemsSchema,
      }),
      outputSchema: rawResult({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, post, isShort, maxItems }) => {
      if (isShort && platform !== 'youtube') {
        return problem('isShort applies to YouTube only. Instagram reels are posts here.');
      }

      const resolved =
        isShort && platform === 'youtube'
          ? { endpoint: YOUTUBE_SHORT_ENDPOINT }
          : resolve(POST_ENDPOINTS, platform, 'post');
      if ('error' in resolved) return problem(resolved.error);
      const { endpoint } = resolved;

      return run(
        () => callRaw(ctx.client, { endpoint, target: post, tool: 'modash_raw_get_post' }),
        maxItems,
      );
    }),
  );

  server.registerTool(
    'modash_raw_list_comments',
    {
      title: 'List comments on a post',
      description:
        'Reads the comments on a post, or the replies under one comment when commentId is given. ' +
        'Costs 1 RAW request per page, billed even on failure. Useful for sentiment and for ' +
        'checking whether engagement looks genuine. Comment threads are long — paginate ' +
        'deliberately, since every page is another request.',
      inputSchema: z.object({
        platform: platformSchema,
        post: z.string().min(1).describe('Instagram shortcode, TikTok post id or URL, YouTube URL'),
        commentId: z
          .string()
          .optional()
          .describe('Given, returns replies to this comment instead of top-level comments'),
        after: afterSchema,
        maxItems: maxItemsSchema,
      }),
      outputSchema: rawResult({ replies: z.boolean() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, post, commentId, after, maxItems }) => {
      const replies = commentId !== undefined;
      const resolved = resolve(
        replies ? COMMENT_REPLY_ENDPOINTS : COMMENT_ENDPOINTS,
        platform,
        replies ? 'comment replies' : 'comments',
      );
      if ('error' in resolved) return problem(resolved.error);
      const { endpoint } = resolved;

      // YouTube identifies a reply thread by cursor alone; there is no comment id parameter.
      if (replies && platform === 'youtube' && after === undefined) {
        return problem(
          'YouTube reply threads are addressed by cursor, not by comment id. Pass the reply ' +
            'cursor from modash_raw_list_comments as `after`.',
        );
      }

      return run(
        () =>
          callRaw(ctx.client, {
            endpoint,
            target: post,
            query: { after, ...(platform === 'youtube' ? {} : { comment_id: commentId }) },
            tool: 'modash_raw_list_comments',
          }),
        maxItems,
        { replies },
      );
    }),
  );

  server.registerTool(
    'modash_raw_search',
    {
      title: 'Search the platform directly',
      description:
        'Runs the platform\'s own search for creators or hashtags and returns what it returns. ' +
        'Costs 1 RAW request, billed even on failure. This is the platform\'s ranking, not ' +
        'Modash\'s — it has no filters, no audience data and no follower thresholds. For finding ' +
        'creators to work with, modash_search_creators and modash_ai_search_creators are almost ' +
        'always the right tools; use this when you specifically want what the platform surfaces.',
      inputSchema: z.object({
        platform: platformSchema,
        kind: z.enum(['creators', 'hashtags']).default('creators'),
        keyword: z.string().min(1),
        maxItems: maxItemsSchema,
      }),
      outputSchema: rawResult({ kind: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, kind, keyword, maxItems }) => {
      const resolved = resolve(SEARCH_ENDPOINTS[kind] ?? {}, platform, `${kind} search`);
      if ('error' in resolved) return problem(resolved.error);
      const { endpoint } = resolved;
      return run(
        () => callRaw(ctx.client, { endpoint, target: keyword, tool: 'modash_raw_search' }),
        maxItems,
        { kind },
      );
    }),
  );

  server.registerTool(
    'modash_raw_browse',
    {
      title: 'Browse a hashtag, sound or playlist',
      description:
        'Lists posts under something that is not a creator: a hashtag, a sound or piece of music, ' +
        'or a YouTube playlist. Costs 1 RAW request per page, billed even on failure. Use it to ' +
        'see who is posting under a campaign hashtag or using a track. Instagram hashtag feeds ' +
        'can return recent or top posts; the others return the platform default.',
      inputSchema: z.object({
        platform: platformSchema,
        kind: z.enum(['hashtag', 'sound', 'playlist']),
        target: z
          .string()
          .min(1)
          .describe('Hashtag without #, sound or music id, or playlist URL'),
        feed: z
          .enum(['recent', 'top'])
          .optional()
          .describe('Instagram hashtag feeds only. Defaults to recent.'),
        after: afterSchema,
        maxItems: maxItemsSchema,
      }),
      outputSchema: rawResult({ kind: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, kind, target, feed, after, maxItems }) => {
      const resolved = resolve(BROWSE_ENDPOINTS[kind] ?? {}, platform, `${kind} feed`);
      if ('error' in resolved) return problem(resolved.error);
      const { endpoint } = resolved;

      const isInstagramHashtag = endpoint.path === '/raw/ig/hashtag-feed';
      if (feed !== undefined && !isInstagramHashtag) {
        return problem('The feed option applies to Instagram hashtag feeds only.');
      }

      return run(
        () =>
          callRaw(ctx.client, {
            endpoint,
            target,
            query: { after, ...(isInstagramHashtag && feed ? { type: feed } : {}) },
            tool: 'modash_raw_browse',
          }),
        maxItems,
        { kind },
      );
    }),
  );
}
