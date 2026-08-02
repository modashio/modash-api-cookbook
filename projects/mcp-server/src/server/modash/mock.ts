import type { ModashHttpRequest, ModashHttpResponse, ModashTransport } from './transport.js';

/**
 * Mock mode: synthetic responses for every endpoint this server can reach.
 *
 * Nothing here is real. The creators are invented, the numbers are round, and the pictures are
 * `data:` URIs generated locally. Modash responses contain third-party personal data — creator
 * names, handles, photos, contact emails, audience demographics — so a fixture file cut from a
 * real response is not something that belongs in a public repository.
 *
 * The fixtures deliberately reproduce the awkward parts of real responses rather than an idealised
 * version of them, because the point of running against mocks is to find out whether your parsing
 * survives contact with the API:
 *
 *   - fields the spec marks `required` are missing (`city`, `ageGroup`, `gender` on the report)
 *   - fields the spec does not document are present (`isVerified`, `isPrivate`, `count`)
 *   - errors come back in all three envelope shapes the API actually uses
 *   - unknown handles 404 instead of returning an empty success
 */

/** A 1x1 transparent GIF. Stands in for a profile picture without hotlinking anyone's face. */
const PLACEHOLDER_PICTURE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

interface MockCreator {
  userId: string;
  username: string;
  fullname: string;
  followers: number;
  engagementRate: number;
}

const CREATORS: readonly MockCreator[] = [
  { userId: 'mock-1', username: 'northlight.studio', fullname: 'Northlight Studio', followers: 480_000, engagementRate: 0.031 },
  { userId: 'mock-2', username: 'fernandfig', fullname: 'Fern & Fig', followers: 210_000, engagementRate: 0.045 },
  { userId: 'mock-3', username: 'atlas.brews', fullname: 'Atlas Brews', followers: 96_000, engagementRate: 0.052 },
  { userId: 'mock-4', username: 'quietloud.audio', fullname: 'Quiet Loud Audio', followers: 54_000, engagementRate: 0.068 },
  { userId: 'mock-5', username: 'mira.makes', fullname: 'Mira Makes', followers: 27_000, engagementRate: 0.074 },
] as const;

const profileOf = (creator: MockCreator, platform: string) => ({
  userId: creator.userId,
  username: creator.username,
  fullname: creator.fullname,
  url: `https://example.invalid/${platform}/${creator.username}`,
  picture: PLACEHOLDER_PICTURE,
  followers: creator.followers,
  engagements: Math.round(creator.followers * creator.engagementRate),
  engagementRate: creator.engagementRate,
  // Undocumented in the spec but present on real search results, so present here too.
  isVerified: creator.followers > 100_000,
  isPrivate: false,
});

const weighted = (entries: [string, string, number][]) =>
  entries.map(([code, name, weight]) => ({ code, name, weight }));

export class MockTransport implements ModashTransport {
  async send(request: ModashHttpRequest): Promise<ModashHttpResponse> {
    const body = this.#route(request);
    // Preserve the error envelope's own status so the client's error handling is exercised too.
    const status =
      typeof body === 'object' && body !== null && 'error' in body && body.error === true ? 400 : 200;
    return { status, body };
  }

  #route({ path, query, body }: ModashHttpRequest): unknown {
    const segments = path.split('/').filter(Boolean);
    const search = (query ?? {}) as Record<string, string | undefined>;
    const payload = (body ?? {}) as Record<string, unknown>;

    if (segments[0] === 'raw') {
      return this.#raw(path, search);
    }

    if (path === '/user/info') {
      return {
        error: false,
        billing: { credits: 1_000, rawRequests: 0 },
        rateLimits: { discoveryRatelimit: 2, rawRatelimit: 2 },
      };
    }

    if (path === '/email-search') {
      const emails = (payload['emails'] as string[] | undefined) ?? [];
      const [first, ...rest] = emails;
      return {
        error: false,
        totalMatches: first === undefined ? 0 : 1,
        matchedEmails:
          first === undefined
            ? []
            : [{ email: first, users: [{ platform: 'instagram', ...profileOf(CREATORS[0]!, 'instagram') }] }],
        notMatchedEmails: rest,
      };
    }

    if (path === '/collaborations/posts' || path === '/collaborations/summary') {
      return this.#collaborations(path, payload);
    }

    if (path === '/ai/brands') {
      return {
        error: false,
        result: [
          {
            brandId: 'mock-brand-1',
            name: 'Tidewater Coffee',
            accounts: [{ platform: 'instagram', username: 'tidewater.coffee', domain: 'example.invalid' }],
          },
        ],
      };
    }

    if (path === '/ai/hashtags' || path === '/ai/mentions') {
      if (path === '/ai/mentions' && search['platform'] === 'youtube') {
        // Shape (c): a framework-level error with no `code` field at all.
        return { message: 'Mentions dictionary is not supported for YouTube', error: true, statusCode: 400 };
      }
      const stem = search['query'] ?? 'coffee';
      return {
        error: false,
        result: [10_000, 4_000, 1_500].map((count, index) => ({
          value: `${stem}${['', 'lovers', 'daily'][index]}`,
          count,
        })),
      };
    }

    // /ai/{platform}/text-search, /ai/{platform}/image-search, /ai/{platform}/lookalikes
    if (segments[0] === 'ai') {
      return this.#aiSearch(segments[2] ?? 'text-search', payload);
    }

    const platform = segments[0] ?? 'instagram';

    if (segments[1] === 'users') {
      const wanted = (search['query'] ?? '').toLowerCase();
      return {
        error: false,
        users: CREATORS.filter((creator) => creator.username.includes(wanted)).map((creator) => ({
          userId: creator.userId,
          username: creator.username,
          fullname: creator.fullname,
          picture: PLACEHOLDER_PICTURE,
          followers: creator.followers,
          isVerified: creator.followers > 100_000,
        })),
      };
    }

    if (segments[1] === 'search') {
      return this.#search(platform, payload);
    }

    if (segments[1] === 'profile' && segments[3] === 'report') {
      return this.#report(platform, decodeURIComponent(segments[2] ?? ''));
    }

    if (segments[1] === 'reports') {
      const influencers = (payload['influencers'] as string[] | undefined) ?? [];
      return {
        error: false,
        reportInfo: { totalFollowers: 600_000, totalUniqueFollowers: 540_000 },
        data: influencers.map((name, index) => ({
          userId: CREATORS[index % CREATORS.length]!.userId,
          username: name,
          followers: CREATORS[index % CREATORS.length]!.followers,
          uniquePercentage: 0.9 - index * 0.05,
          overlappingPercentage: 0.1 + index * 0.05,
        })),
      };
    }

    return this.#dictionary(segments[1] ?? '', search);
  }

  #dictionary(kind: string, query: Record<string, string | undefined>): unknown {
    const needle = (query['query'] ?? '').toLowerCase();
    const keep = <T extends { name?: string }>(items: T[]) =>
      items.filter((item) => (item.name ?? '').toLowerCase().includes(needle));

    switch (kind) {
      case 'interests':
        return {
          error: false,
          total: 3,
          interests: keep([
            { id: 1, name: 'Coffee & Tea' },
            { id: 2, name: 'Camping & Hiking' },
            { id: 3, name: 'Music' },
          ]),
        };
      case 'brands':
        // `count` is undocumented but real. Loose response schemas let it through.
        return {
          error: false,
          total: 2,
          brands: keep([
            { id: 100, name: 'Tidewater Coffee', count: 1_200 },
            { id: 101, name: 'Northpath Outdoors', count: 800 },
          ]),
        };
      case 'locations':
        return {
          error: false,
          total: 2,
          locations: keep([
            { id: 900, name: 'Tallinn', title: 'Tallinn, Harju County, Estonia' },
            { id: 901, name: 'London', title: 'London, England, United Kingdom' },
          ]),
        };
      case 'languages':
        return {
          error: false,
          total: 2,
          languages: keep([
            { code: 'en', name: 'English' },
            { code: 'et', name: 'Estonian' },
          ]),
        };
      case 'topics':
      case 'hashtags':
        // Note the different shape: `tags`, and no `total`.
        return { error: false, tags: ['coffee', 'coffeeroasting', 'slowmornings'] };
      default:
        return { error: true, code: 'bad_request', message: `Unknown dictionary "${kind}"` };
    }
  }

  #search(platform: string, payload: Record<string, unknown>): unknown {
    const page = Number(payload['page'] ?? 0);
    if (page > 665) {
      // The real API returns `bad_request` here, not the `page_limit` code you would expect.
      return { error: true, code: 'bad_request', message: 'You can search up to 665 pages.' };
    }
    return {
      error: false,
      total: 12_345,
      isExactMatch: true,
      directs: [],
      lookalikes: CREATORS.map((creator) => ({
        userId: creator.userId,
        profile: profileOf(creator, platform),
      })),
    };
  }

  #aiSearch(kind: string, payload: Record<string, unknown>): unknown {
    const pageSize = Number(payload['pageSize'] ?? 6);
    const profiles = CREATORS.slice(0, Math.min(pageSize, CREATORS.length)).map((creator) => ({
      userId: creator.userId,
      username: creator.username,
      fullName: creator.fullname,
      url: `https://example.invalid/${creator.username}`,
      profilePicture: PLACEHOLDER_PICTURE,
      followersCount: creator.followers,
      engagementRate: creator.engagementRate,
      postingFrequency: 12,
      viewsCountMedian: creator.followers * 2,
      accountCategory: 'Digital creator',
      matchedPosts: [{ id: `${creator.userId}-post-1`, url: `https://example.invalid/p/${creator.userId}` }],
    }));

    if (kind === 'lookalikes') {
      const userIds = (payload['userIds'] as string[] | undefined) ?? [];
      return {
        error: false,
        total: profiles.length,
        sourceProfiles: userIds.map((id, index) => ({ ...profiles[index % profiles.length]!, username: id })),
        lookalikes: profiles,
      };
    }

    return { error: false, total: profiles.length, profiles };
  }

  #report(platform: string, userId: string): unknown {
    const creator =
      CREATORS.find((entry) => entry.username === userId || entry.userId === userId) ??
      (userId === 'instagram' ? CREATORS[0]! : undefined);

    if (creator === undefined) {
      return { error: true, code: 'account_not_found', message: 'Requested account does not exist.' };
    }

    return {
      error: false,
      profile: {
        userId: creator.userId,
        profile: profileOf(creator, platform),
        isVerified: creator.followers > 100_000,
        isPrivate: false,
        accountType: 'Creator',
        bio: 'Synthetic profile. Not a real account.',
        country: 'EE',
        // `city`, `gender` and `ageGroup` are marked required in the spec and are routinely absent.
        language: { code: 'en', name: 'English' },
        postsCount: 400,
        avgLikes: Math.round(creator.followers * creator.engagementRate * 0.9),
        avgComments: Math.round(creator.followers * creator.engagementRate * 0.1),
        avgViews: creator.followers * 2,
        paidPostPerformance: 0.85,
        contacts: [{ type: 'email', value: `hello@${creator.username}.invalid` }],
        interests: [{ id: 1, name: 'Coffee & Tea' }],
        brandAffinity: [{ id: 100, name: 'Tidewater Coffee' }],
        audience: {
          credibility: 0.86,
          notable: 0.04,
          genders: weighted([
            ['FEMALE', 'Female', 0.62],
            ['MALE', 'Male', 0.38],
          ]),
          ages: weighted([
            ['18-24', '18-24', 0.28],
            ['25-34', '25-34', 0.41],
            ['35-44', '35-44', 0.19],
          ]),
          geoCountries: weighted([
            ['US', 'United States', 0.34],
            ['GB', 'United Kingdom', 0.12],
            ['EE', 'Estonia', 0.08],
          ]),
          languages: weighted([
            ['en', 'English', 0.81],
            ['et', 'Estonian', 0.06],
          ]),
          interests: weighted([
            ['', 'Coffee & Tea', 0.44],
            ['', 'Travel & Tourism', 0.29],
          ]),
        },
        recentPosts: [
          {
            id: `${creator.userId}-recent-1`,
            url: `https://example.invalid/p/${creator.userId}-recent-1`,
            text: 'Synthetic post.',
            created: '2026-07-01T09:00:00.000Z',
            likes: 12_000,
            comments: 300,
            type: 'reel',
          },
        ],
        sponsoredPosts: [
          {
            id: `${creator.userId}-sponsored-1`,
            url: `https://example.invalid/p/${creator.userId}-sponsored-1`,
            text: 'Synthetic sponsored post. #ad',
            created: '2026-06-14T09:00:00.000Z',
            likes: 9_000,
            comments: 210,
            type: 'reel',
          },
        ],
        statHistory: [
          { month: '2026-05', followers: creator.followers - 8_000, avgLikes: 11_000, avgViews: 90_000 },
          { month: '2026-06', followers: creator.followers - 3_000, avgLikes: 11_500, avgViews: 95_000 },
          { month: '2026-07', followers: creator.followers, avgLikes: 12_000, avgViews: 99_000 },
        ],
      },
    };
  }

  #collaborations(path: string, payload: Record<string, unknown>): unknown {
    const platform = String(payload['platform'] ?? 'instagram');
    const id = String(payload['id'] ?? '');
    const creator = CREATORS.find((entry) => entry.username === id || entry.userId === id) ?? CREATORS[0]!;

    if (path === '/collaborations/summary') {
      return {
        error: false,
        influencer: {
          id: creator.userId,
          platform,
          username: creator.username,
          summary: {
            total_collaborations: 18,
            total_distinct_posts: 22,
            total_distinct_brands: 7,
            first_collaboration_timestamp: 1_735_689_600_000,
            last_collaboration_timestamp: 1_753_920_000_000,
          },
          per_brand_summary: [
            { brand_name: 'Tidewater Coffee', total_collaborations: 6, total_likes: 54_000 },
          ],
        },
      };
    }

    return {
      error: false,
      cursor: 'mock-cursor',
      influencer: {
        id: creator.userId,
        platform,
        username: creator.username,
        is_more_available: false,
        posts: [
          {
            post_id: `${creator.userId}-collab-1`,
            post_timestamp: 1_753_920_000_000,
            title: 'Synthetic collaboration post',
            label: 'Properly Disclosed Sponsorship: uses #ad',
            collaboration_type: 'Paid',
            stats: { likes: 9_000, comments: 210, views: 140_000 },
            sponsors: [
              { name: 'Tidewater Coffee', domain: 'example.invalid', category: 'Food Beverage Restaurants' },
            ],
          },
        ],
      },
    };
  }

  /**
   * RAW fixtures, which exist mainly to reproduce the thing that makes RAW awkward: there is no
   * common envelope. Instagram returns a bare object or `{items, more_available, end_cursor}`,
   * TikTok returns `{success, ..., hasMore, maxCursor}`, and YouTube buries its cursor inside the
   * list object. If mock mode smoothed that over, it would hide the exact problem the cursor
   * normalisation in `raw.ts` exists to solve.
   */
  #raw(path: string, query: Record<string, string | undefined>): unknown {
    const target = query['url'] ?? query['code'] ?? query['keyword'] ?? query['hashtag'] ?? '';

    // Searches and hashtag/sound/playlist feeds take a free-text term; everything else addresses a
    // specific creator or post and 400s on an identifier the platform cannot parse. Reproducing
    // that matters, because a 400 is where RAW and Discovery billing diverge: RAW charges for it.
    const addressesACreator = !/search|hashtag-feed|challenge-feed|music-feed|audio-info|playlist-videos/.test(path);
    const creator = CREATORS.find((entry) => target.includes(entry.username)) ?? CREATORS[0]!;

    if (addressesACreator && !CREATORS.some((entry) => target.includes(entry.username))) {
      return { error: true, code: 'bad_request', message: `Could not resolve "${target}".` };
    }

    const page = query['after'] === undefined ? 0 : 1;
    const posts = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${creator.userId}-raw-${page}-${index}`,
        caption: 'Synthetic post. Not real platform data.',
        taken_at: 1_753_920_000 + index,
        like_count: 12_000 - index * 100,
        comment_count: 300 - index,
        play_count: 99_000 - index * 500,
      }));

    // Instagram: bare object for a profile, {items, more_available, end_cursor} for a list.
    if (path.startsWith('/raw/ig/user-info')) {
      return {
        pk: creator.userId,
        username: creator.username,
        full_name: creator.fullname,
        biography: 'Synthetic profile. Not a real account.',
        follower_count: creator.followers,
        following_count: 400,
        media_count: 512,
        is_verified: creator.followers > 100_000,
        is_private: false,
      };
    }
    if (path.startsWith('/raw/ig/')) {
      return { items: posts(12), more_available: page === 0, end_cursor: page === 0 ? 'mock-ig-cursor' : '' };
    }

    // TikTok: a success flag, camelCase pagination, and a differently named list on every route.
    if (path.startsWith('/raw/tiktok/user-info')) {
      return {
        success: true,
        user_info: {
          id: creator.userId,
          uniqueId: creator.username,
          nickname: creator.fullname,
          followerCount: creator.followers,
          videoCount: 240,
          verified: creator.followers > 100_000,
        },
      };
    }
    if (path.startsWith('/raw/tiktok/search-users')) {
      return { success: true, result: { user_list: [{ user: { uniqueId: creator.username } }], input_keyword: target } };
    }
    if (path.startsWith('/raw/tiktok/')) {
      return { success: true, user_feed: posts(12), hasMore: page === 0, maxCursor: page === 0 ? 'mock-tt-cursor' : '' };
    }

    // YouTube: cursor nested inside the list object rather than beside it.
    if (path.startsWith('/raw/youtube/channel-info')) {
      return {
        success: true,
        channel_info: {
          channel_id: creator.userId,
          handle: `@${creator.username}`,
          fullname: creator.fullname,
          followers: creator.followers,
          total_views: creator.followers * 40,
          video_count: 310,
          is_verified: creator.followers > 100_000,
        },
      };
    }
    return { success: true, videos_list: { videos: posts(12), cursor: page === 0 ? 'mock-yt-cursor' : '' } };
  }
}
