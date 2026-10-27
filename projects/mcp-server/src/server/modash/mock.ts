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

/**
 * Brands for the brand crossover tools. Invented names on the reserved `.example` domain, each
 * with a pool of synthetic creators. Pools overlap by design: the two outdoor brands share fewer
 * creators than the coffee and games pair, so the fixtures tell a "creators pick a side" story.
 */
interface MockBrand {
  brandId: string;
  name: string;
  domain: string;
  /** Creators numbered `first`..`last` post about this brand. */
  first: number;
  last: number;
}

const BRANDS: readonly MockBrand[] = [
  { brandId: '00000000000000000000000000000001', name: 'Northpath Outdoors', domain: 'northpath.example', first: 1, last: 100 },
  { brandId: '00000000000000000000000000000002', name: 'Summitline Athletic', domain: 'summitline.example', first: 31, last: 130 },
  { brandId: '00000000000000000000000000000003', name: 'Tidewater Coffee', domain: 'tidewater.example', first: 201, last: 280 },
  { brandId: '00000000000000000000000000000004', name: 'Pixelforge Games', domain: 'pixelforge.example', first: 211, last: 290 },
  // A second identity on a domain, the way a sub-label can share its parent's website.
  { brandId: '00000000000000000000000000000005', name: 'Northpath Kids', domain: 'northpath.example', first: 380, last: 420 },
];

/** AI Search locations. Synthetic creators are in 1001 or 1002, never 1003. */
const MOCK_LOCATIONS = [
  { id: 1001, name: 'United States', title: 'United States' },
  { id: 1002, name: 'United Kingdom', title: 'United Kingdom' },
  { id: 1003, name: 'Estonia', title: 'Estonia' },
];

const DAY_MS = 86_400_000;

/** FNV-1a. Deterministic, so the same window always yields the same synthetic posts. */
const hash = (text: string): number => {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
};

const creatorId = (n: number) => `mock-creator-${String(n).padStart(3, '0')}`;
const creatorNumber = (id: string) => Number(id.replace('mock-creator-', ''));
/** Four in five synthetic creators are "in" location 1001; follower counts run 2k to 201k. */
const creatorFollowers = (n: number) => 2_000 + ((n * 7_919) % 200) * 1_000;
const creatorLocation = (n: number) => (n % 5 === 0 ? 1002 : 1001);

export class MockTransport implements ModashTransport {
  readonly #lists = new Map<string, { platform: string; members: Set<string> }>();

  async send(request: ModashHttpRequest): Promise<ModashHttpResponse> {
    const body = this.#route(request);
    // Preserve the error envelope's own status so the client's error handling is exercised too.
    const failed = typeof body === 'object' && body !== null && 'error' in body && body.error === true;
    const code = failed ? (body as { code?: string }).code : undefined;
    const status = !failed ? 200 : code === 'posts_not_found' || code === 'entity_not_found' ? 404 : 400;
    return { status, body };
  }

  #route({ method, path, query, body }: ModashHttpRequest): unknown {
    const segments = path.split('/').filter(Boolean);
    const search = (query ?? {}) as Record<string, string | undefined>;
    const payload = (body ?? {}) as Record<string, unknown>;

    if (segments[0] === 'raw') {
      return this.#raw(path, search);
    }

    if (segments[0] === 'ai' && segments[1] === 'lists') {
      return this.#aiLists(method, segments[2], segments[3], payload);
    }

    if (path === '/ai/locations') {
      const needle = (search['query'] ?? '').toLowerCase();
      return { error: false, result: MOCK_LOCATIONS.filter((entry) => entry.name.toLowerCase().includes(needle)) };
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
      const { domain, brandId } = search;
      const needle = (search['query'] ?? '').toLowerCase();
      const matches = BRANDS.filter((brand) =>
        domain !== undefined
          ? brand.domain === domain
          : brandId !== undefined
            ? brand.brandId === brandId
            : brand.name.toLowerCase().includes(needle),
      );
      return {
        error: false,
        result: matches.map((brand) => ({
          brandId: brand.brandId,
          name: brand.name,
          logoUrl: PLACEHOLDER_PICTURE,
          accounts: [{ platform: 'instagram', username: brand.domain.replace('.example', ''), domain: brand.domain }],
        })),
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
      const filters = payload['filters'] as { lists?: { listIds?: string[] } } | undefined;
      if (filters?.lists !== undefined) return this.#listSearch(payload);
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

  /**
   * Posts about one brand, from its synthetic creator pool. Most creators post once a week, on a
   * day a hash picks, about one week in six is quiet (answered with the documented, unbilled
   * `posts_not_found`), and roughly one post in nine is on TikTok, because a grouped brand id
   * returns posts from every platform.
   */
  #brandPosts(brand: MockBrand, payload: Record<string, unknown>): unknown {
    const window = (payload['postCreationTimestampMs'] ?? {}) as { gte?: number; lte?: number };
    const gte = window.gte ?? Date.now() - 30 * DAY_MS;
    const lte = window.lte ?? Date.now();
    const limit = Math.min(30, Number(payload['limit'] ?? 30));
    const offset = Number(payload['cursor'] ?? 0);

    const posts = [];
    for (let week = Math.floor(gte / (7 * DAY_MS)); week <= Math.floor(lte / (7 * DAY_MS)); week += 1) {
      if (hash(`${brand.brandId}:week:${week}`) % 6 === 0) continue;
      for (let n = brand.first; n <= brand.last; n += 1) {
        const roll = hash(`${brand.brandId}:${n}:${week}`);
        if (roll % 100 >= 85) continue;
        const day = week * 7 + ((roll >>> 8) % 7);
        const timestamp = day * DAY_MS + ((roll >>> 4) % 86_400) * 1000;
        if (timestamp < gte || timestamp > lte) continue;
        posts.push({
          post_id: `mock-post-${brand.brandId.slice(-2)}-${day}-${n}`,
          post_thumbnail: PLACEHOLDER_PICTURE,
          post_timestamp: timestamp,
          description: 'Synthetic post. Not real platform data.',
          label: 'Properly Disclosed Sponsorship: uses #ad',
          collaboration_type: 'Paid',
          type: 'photo',
          feed_type: 'feed',
          stats: { likes: 1_000, comments: 50 },
          sponsors: [{ name: brand.name, domain: brand.domain }],
          user_id: creatorId(n),
          username: `synthetic.creator.${String(n).padStart(3, '0')}`,
          platform: (roll >>> 12) % 9 === 0 ? 'tiktok' : 'instagram',
        });
      }
    }
    posts.sort((a, b) => b.post_timestamp - a.post_timestamp);

    if (posts.length === 0) {
      return { error: true, code: 'posts_not_found', message: 'No collaboration posts found for the given filters.' };
    }

    const page = posts.slice(offset, offset + limit);
    const more = offset + limit < posts.length;
    return {
      error: false,
      ...(more ? { cursor: String(offset + limit) } : {}),
      brand: {
        id: brand.brandId,
        platform: String(payload['platform'] ?? 'instagram'),
        brand_id: brand.brandId,
        brand_name: brand.name,
        brand_domain: brand.domain,
        brand_category: 'Retail',
        is_more_available: more,
        posts: page,
      },
    };
  }

  #aiLists(method: string, listId: string | undefined, sub: string | undefined, payload: Record<string, unknown>): unknown {
    if (listId === undefined && method === 'POST') {
      const id = `mock-list-${String(this.#lists.size + 1).padStart(4, '0')}`;
      this.#lists.set(id, { platform: String(payload['platform'] ?? 'instagram'), members: new Set() });
      return { listId: id, name: payload['name'], platform: payload['platform'], approximateMemberCount: 0 };
    }

    const list = listId === undefined ? undefined : this.#lists.get(listId);
    if (list === undefined) {
      return { error: true, code: 'entity_not_found', message: 'List not found' };
    }
    if (sub === 'members' && method === 'POST') {
      const ids = (payload['influencerIds'] as string[] | undefined) ?? [];
      const before = list.members.size;
      for (const id of ids) list.members.add(id);
      return {
        addedCount: list.members.size - before,
        existingCount: ids.length - (list.members.size - before),
        approximateMemberCount: list.members.size,
      };
    }
    if (method === 'DELETE' && sub === undefined) {
      this.#lists.delete(listId!);
      return {};
    }
    return { error: true, code: 'bad_request', message: `Unsupported list call ${method}` };
  }

  /** AI Search restricted to a list: members that pass the location and follower filters. */
  #listSearch(payload: Record<string, unknown>): unknown {
    const filters = payload['filters'] as {
      lists: { listIds: string[]; mode: string };
      locations?: number[];
      followersCount?: { min?: number };
    };
    const list = this.#lists.get(filters.lists.listIds[0] ?? '');
    if (list === undefined) {
      return { error: true, code: 'bad_request', message: 'Unknown list id' };
    }
    const page = Number(payload['page'] ?? 0);
    const pageSize = Number(payload['pageSize'] ?? 6);

    const matching = [...list.members]
      .map(creatorNumber)
      .filter((n) => filters.locations === undefined || filters.locations.includes(creatorLocation(n)))
      .filter((n) => creatorFollowers(n) >= (filters.followersCount?.min ?? 0))
      .sort((a, b) => creatorFollowers(b) - creatorFollowers(a));

    return {
      error: false,
      total: matching.length,
      profiles: matching.slice(page * pageSize, (page + 1) * pageSize).map((n) => ({
        userId: creatorId(n),
        username: `synthetic.creator.${String(n).padStart(3, '0')}`,
        fullName: 'Synthetic Creator',
        url: `https://example.invalid/${creatorId(n)}`,
        profilePicture: PLACEHOLDER_PICTURE,
        followersCount: creatorFollowers(n),
        engagementRate: 0.03,
      })),
    };
  }

  #collaborations(path: string, payload: Record<string, unknown>): unknown {
    const platform = String(payload['platform'] ?? 'instagram');
    const id = String(payload['id'] ?? '');

    const brand = BRANDS.find((entry) => entry.brandId === id);
    if (brand !== undefined && path === '/collaborations/posts') return this.#brandPosts(brand, payload);
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
