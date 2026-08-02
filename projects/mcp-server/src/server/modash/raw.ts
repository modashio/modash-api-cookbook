import type { ModashClient } from './client.js';
import type { Platform } from './filters.js';
import { rawResponseSchema } from './responses.js';

/**
 * The RAW API: live, unfiltered data pulled from the platforms at the moment you ask for it.
 *
 * It is a **separate product from Discovery**, and almost everything about how it bills and
 * responds is different. Three differences drive the whole design of this file:
 *
 *  1. **It is metered in requests, not credits.** The allowance is `billing.rawRequests` from
 *     `GET /user/info` — a different pool with a different number in it. One request per call,
 *     including each page of a paginated list.
 *
 *  2. **Failed requests are billed.** Discovery's docs are explicit that a failure costs nothing,
 *     and that holds. RAW is the opposite: a `400 bad_request` for a malformed URL still comes out
 *     of your allowance. Retrying is not free here, and neither is a URL a model guessed at.
 *
 *  3. **There is no common response envelope.** Discovery responses look alike. RAW returns
 *     whatever the platform returns: `/raw/ig/user-info` is a bare object, `/raw/ig/user-feed` is
 *     `{items, more_available, end_cursor}`, `/raw/tiktok/user-feed` is
 *     `{success, user_feed, hasMore, maxCursor}`, and `/raw/youtube/uploaded-videos` hides its
 *     cursor inside `videos_list`. That is the product working as documented — "data is returned
 *     as-is, without filtering" — so this file passes payloads through untouched and normalises
 *     only the cursor, which is the one thing a caller cannot paginate without.
 */

/** One request per call, drawn from `billing.rawRequests` rather than from credits. */
export const RAW_REQUEST_COST = 1;

export interface RawEndpoint {
  path: string;
  /** The query parameter that carries the thing being looked up. */
  param: string;
  /** What that parameter wants, which is rarely the same twice. */
  hint: string;
}

type PlatformMap = Partial<Record<Platform, RawEndpoint>>;

export const PROFILE_ENDPOINTS: PlatformMap = {
  instagram: { path: '/raw/ig/user-info', param: 'url', hint: '@handle, user id, or profile URL' },
  tiktok: { path: '/raw/tiktok/user-info', param: 'url', hint: '@handle or profile URL' },
  youtube: {
    path: '/raw/youtube/channel-info',
    param: 'url',
    hint: 'channel URL, e.g. https://www.youtube.com/@name',
  },
};

export const POST_LIST_ENDPOINTS: Record<string, PlatformMap> = {
  posts: {
    instagram: { path: '/raw/ig/user-feed', param: 'url', hint: '@handle or user id' },
    tiktok: { path: '/raw/tiktok/user-feed', param: 'url', hint: '@handle or profile URL' },
    youtube: { path: '/raw/youtube/uploaded-videos', param: 'url', hint: 'channel URL' },
  },
  shortForm: {
    instagram: { path: '/raw/ig/user-reels', param: 'url', hint: '@handle or user id' },
    youtube: { path: '/raw/youtube/uploaded-shorts', param: 'url', hint: 'channel URL' },
  },
  live: {
    youtube: { path: '/raw/youtube/uploaded-lives', param: 'url', hint: 'channel URL' },
  },
  tagged: {
    instagram: { path: '/raw/ig/user-tags-feed', param: 'url', hint: '@handle or user id' },
  },
};

export const POST_ENDPOINTS: PlatformMap = {
  instagram: {
    path: '/raw/ig/media-info',
    param: 'code',
    hint: 'post shortcode — the part after instagram.com/p/',
  },
  tiktok: { path: '/raw/tiktok/media-info', param: 'url', hint: 'post id or full post URL' },
  youtube: {
    path: '/raw/youtube/video-info',
    param: 'url',
    hint: 'watch URL, e.g. https://www.youtube.com/watch?v=...',
  },
};

/** Shorts have their own endpoint on YouTube; the other two use the same one as any other post. */
export const YOUTUBE_SHORT_ENDPOINT: RawEndpoint = {
  path: '/raw/youtube/short-info',
  param: 'url',
  hint: 'shorts URL, e.g. https://www.youtube.com/shorts/...',
};

export const COMMENT_ENDPOINTS: PlatformMap = {
  instagram: { path: '/raw/ig/media-comments', param: 'code', hint: 'post shortcode' },
  tiktok: { path: '/raw/tiktok/comments', param: 'url', hint: 'post id or full post URL' },
  youtube: { path: '/raw/youtube/video-comments', param: 'url', hint: 'watch URL' },
};

export const COMMENT_REPLY_ENDPOINTS: PlatformMap = {
  instagram: { path: '/raw/ig/media-comment-replies', param: 'code', hint: 'post shortcode' },
  tiktok: { path: '/raw/tiktok/comments-replies', param: 'url', hint: 'post id or full post URL' },
  youtube: { path: '/raw/youtube/video-comment-replies', param: 'url', hint: 'watch URL' },
};

export const SEARCH_ENDPOINTS: Record<string, PlatformMap> = {
  creators: {
    instagram: { path: '/raw/ig/search', param: 'keyword', hint: 'what to search for' },
    tiktok: { path: '/raw/tiktok/search-users', param: 'keyword', hint: 'what to search for' },
  },
  hashtags: {
    instagram: { path: '/raw/ig/search-hashtags', param: 'keyword', hint: 'hashtag text, no #' },
  },
};

export const BROWSE_ENDPOINTS: Record<string, PlatformMap> = {
  hashtag: {
    instagram: { path: '/raw/ig/hashtag-feed', param: 'hashtag', hint: 'hashtag text, no #' },
    tiktok: { path: '/raw/tiktok/challenge-feed', param: 'url', hint: 'challenge id or URL' },
  },
  sound: {
    instagram: {
      path: '/raw/ig/audio-info',
      param: 'url',
      hint: 'audio id or full instagram.com/reels/audio/... URL',
    },
    tiktok: { path: '/raw/tiktok/music-feed', param: 'url', hint: 'music id' },
  },
  playlist: {
    youtube: { path: '/raw/youtube/playlist-videos', param: 'url', hint: 'playlist URL' },
  },
};

export interface RawCall {
  endpoint: RawEndpoint;
  target: string;
  /** Cursor from a previous page, and any endpoint-specific extras. */
  query?: Record<string, string | number | undefined>;
  tool: string;
}

export const callRaw = (client: ModashClient, { endpoint, target, query, tool }: RawCall) =>
  client.call({
    request: {
      method: 'GET',
      path: endpoint.path,
      query: { [endpoint.param]: target, ...query },
    },
    // The payload is whatever the platform said. Validating it would mean inventing a contract
    // the product explicitly does not offer.
    schema: rawResponseSchema,
    rawRequests: RAW_REQUEST_COST,
    tool,
    detail: `${endpoint.path} ${target}`,
    queue: 'raw',
  });

// ---------------------------------------------------------------------------------------------
// Making sense of the response
// ---------------------------------------------------------------------------------------------

/**
 * Every list endpoint paginates, and no two of them agree on what the cursor is called or where it
 * lives. Rather than a lookup table that has to be maintained per endpoint, this looks for any of
 * the names the API actually uses, one level down as well as at the top, and hands back a single
 * `nextCursor` the caller can pass straight back as `after`.
 */
const CURSOR_KEYS = ['end_cursor', 'maxCursor', 'max_cursor', 'cursor', 'next_max_id', 'next'];
const HAS_MORE_KEYS = ['more_available', 'hasMore', 'has_more'];

export function findPageInfo(body: unknown): { nextCursor?: string; hasMore?: boolean } {
  const found: { nextCursor?: string; hasMore?: boolean } = {};

  const scan = (value: unknown, depth: number): void => {
    if (depth > 2 || typeof value !== 'object' || value === null || Array.isArray(value)) return;

    const record = value as Record<string, unknown>;
    for (const key of CURSOR_KEYS) {
      const candidate = record[key];
      if (found.nextCursor === undefined && typeof candidate === 'string' && candidate !== '') {
        found.nextCursor = candidate;
      }
    }
    for (const key of HAS_MORE_KEYS) {
      if (found.hasMore === undefined && typeof record[key] === 'boolean') {
        found.hasMore = record[key] as boolean;
      }
    }

    for (const nested of Object.values(record)) scan(nested, depth + 1);
  };

  scan(body, 0);
  return found;
}

/**
 * Caps how many entries of each array survive into the result.
 *
 * A RAW feed page can be tens of thousands of tokens once serialised, and a model that asks for
 * three creators' feeds has spent its context before it reads any of them. Nothing is dropped from
 * the request — you have already paid for the full page either way — so this is purely about what
 * gets handed back, and the result says when it happened.
 */
export function capArrays(value: unknown, maxItems: number): { value: unknown; capped: boolean } {
  let capped = false;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      if (node.length > maxItems) capped = true;
      return node.slice(0, maxItems).map(walk);
    }
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([key, nested]) => [key, walk(nested)]),
      );
    }
    return node;
  };

  return { value: walk(value), capped };
}
