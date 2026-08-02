import * as z from 'zod';

/**
 * Request schemas for the two search families.
 *
 * These are the schemas that stop the server wasting money. The Discovery API validates the
 * top-level body of a search request, but it does **not** validate the contents of the nested
 * `filter` object: send `filter.influencer.followers.min` as the string `"not-a-number"` and you
 * get back HTTP 200, a full page of results, and a bill for 0.15 credits. Nothing tells you the
 * filter was ignored.
 *
 * That is a survivable bug when a human wrote the filter and can eyeball the results. It is not
 * survivable when a language model wrote it, because a model that invents `minFollowers` instead
 * of `followers.min` will get a plausible-looking answer and no signal to correct itself.
 *
 * So filters are `z.strictObject` throughout — unknown keys are rejected locally, before a request
 * is sent, and the model gets an error naming the field it made up. This is the one place in the
 * server where strict parsing is right; response schemas stay loose (see `responses.ts`).
 */

export const PLATFORMS = ['instagram', 'tiktok', 'youtube'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const platformSchema = z.enum(PLATFORMS);

const rangeSchema = z.strictObject({
  min: z.number().nonnegative().optional(),
  max: z.number().nonnegative().optional(),
});

const growthRateSchema = z.strictObject({
  interval: z.enum(['i1month', 'i2months', 'i3months', 'i4months', 'i5months', 'i6months']),
  value: z.number().optional(),
  operator: z.enum(['gte', 'gt', 'lt', 'lte']),
});

const textTagSchema = z.strictObject({
  type: z.enum(['hashtag', 'mention']),
  value: z.string().min(1).describe('Tag without its leading # or @'),
});

const CONTACT_TYPES = [
  'bbm', 'email', 'facebook', 'instagram', 'itunes', 'kakao', 'kik', 'lineid', 'linktree',
  'pinterest', 'sarahah', 'sayat', 'skype', 'snapchat', 'tiktok', 'tumblr', 'twitchtv',
  'twitter', 'vk', 'wechat', 'youtube',
] as const;

/** Ages are buckets, not free numbers. 25 means "the 25-34 bucket". */
const AGE_BUCKETS = [18, 25, 35, 45, 65] as const;

// ---------------------------------------------------------------------------------------------
// Regular search: POST /{platform}/search
// ---------------------------------------------------------------------------------------------

export const influencerFilterSchema = z.strictObject({
  followers: rangeSchema.optional(),
  engagements: rangeSchema.optional().describe('Average engagements per post. Values are rounded.'),
  engagementRate: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum engagement rate as a fraction, so 0.02 means at least 2%.'),
  location: z
    .array(z.number().int())
    .max(20)
    .optional()
    .describe('Location ids from modash_lookup_dictionary(kind="locations"). Not names.'),
  language: z
    .string()
    .min(1)
    .max(3)
    .optional()
    .describe('Language code from modash_lookup_dictionary(kind="languages").'),
  lastposted: z.number().int().min(30).optional().describe('Posted within this many days. Minimum 30.'),
  relevance: z
    .array(z.string().min(1))
    .max(100)
    .optional()
    .describe('Topics as "#topic" and/or creators as "@handle" the creator should be relevant to.'),
  audienceRelevance: z
    .array(z.string().min(1))
    .optional()
    .describe('"@handle" entries whose *audience* the creator\'s audience should resemble.'),
  gender: z.enum(['MALE', 'FEMALE', 'KNOWN', 'UNKNOWN']).optional(),
  age: z
    .strictObject({
      min: z.union(AGE_BUCKETS.map((age) => z.literal(age))).optional(),
      max: z.union(AGE_BUCKETS.map((age) => z.literal(age))).optional(),
    })
    .optional(),
  followersGrowthRate: growthRateSchema.optional(),
  bio: z.string().min(1).optional().describe('Phrase to match in the bio or full name.'),
  hasAudienceData: z
    .boolean()
    .optional()
    .describe('Defaults to true, meaning only creators Modash has audience demographics for.'),
  hasContactDetails: z
    .array(
      z.strictObject({
        contactType: z.enum(CONTACT_TYPES),
        filterAction: z.enum(['must', 'should', 'not']).optional(),
      }),
    )
    .optional(),
  keywords: z
    .string()
    .min(1)
    .optional()
    .describe('Phrase in post captions. On YouTube this searches words spoken in videos.'),
  isVerified: z.boolean().optional(),

  // Instagram only.
  accountTypes: z
    .array(z.union([z.literal(1), z.literal(2), z.literal(3)]))
    .optional()
    .describe('Instagram only. 1 = Regular, 2 = Business, 3 = Creator.'),
  brands: z
    .array(z.number().int())
    .optional()
    .describe('Instagram only. Brand ids from modash_lookup_dictionary(kind="brands").'),
  interests: z
    .array(z.number().int())
    .optional()
    .describe('Instagram only. Interest ids from modash_lookup_dictionary(kind="interests").'),
  reelsPlays: rangeSchema.optional().describe('Instagram only.'),
  hasSponsoredPosts: z
    .boolean()
    .optional()
    .describe('Instagram only. Detected from commercial hashtags or the paid partnership tag.'),

  // Instagram and TikTok only.
  textTags: z.array(textTagSchema).max(20).optional().describe('Instagram and TikTok only.'),

  // TikTok only.
  likesGrowthRate: growthRateSchema.optional().describe('TikTok only.'),
  shares: rangeSchema.optional().describe('TikTok only.'),
  saves: rangeSchema.optional().describe('TikTok only.'),

  // TikTok and YouTube only.
  views: rangeSchema.optional().describe('TikTok and YouTube only.'),

  // YouTube only.
  isOfficialArtist: z.boolean().optional().describe('YouTube only.'),
  viewsGrowthRate: growthRateSchema.optional().describe('YouTube only.'),
});

const weight = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe('Share of the audience that must match, so 0.3 means at least 30%.');

export const audienceFilterSchema = z.strictObject({
  /**
   * Watch the shapes: `location`, `age` and `interests` are arrays and combine with OR, while
   * `language` and `gender` are single objects. Getting this backwards is the most common mistake
   * against this endpoint, and because nested filters are not server-validated it fails silently.
   */
  location: z.array(z.strictObject({ id: z.number().int(), weight })).optional(),
  age: z
    .array(
      z.strictObject({
        id: z.enum(['13-17', '18-24', '25-34', '35-44', '45-64', '65-']),
        weight,
      }),
    )
    .optional(),
  ageRange: z
    .strictObject({
      min: z.enum(['13', '18', '25', '35', '45', '65']).optional(),
      max: z.enum(['17', '24', '34', '44', '64']).optional(),
      weight,
    })
    .optional(),
  language: z.strictObject({ id: z.string().min(1).max(2), weight }).optional(),
  gender: z.strictObject({ id: z.enum(['MALE', 'FEMALE']), weight }).optional(),

  // Instagram only.
  interests: z
    .array(z.strictObject({ id: z.number().int(), weight }))
    .optional()
    .describe('Instagram only.'),
  credibility: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Instagram only. Minimum share of real-looking followers, so 0.75 allows 25% fake.'),
});

export const searchFilterSchema = z.strictObject({
  influencer: influencerFilterSchema.optional(),
  audience: audienceFilterSchema.optional(),
});

const SORT_FIELDS_BY_PLATFORM = {
  instagram: [
    'followers', 'engagements', 'engagementRate', 'keywords', 'audienceGeo', 'audienceLang',
    'audienceGender', 'audienceAge', 'audienceRelevance', 'relevance', 'followersGrowth',
    'audienceInterest', 'reelsPlays',
  ],
  tiktok: [
    'followers', 'engagements', 'engagementRate', 'keywords', 'audienceGeo', 'audienceLang',
    'audienceGender', 'audienceAge', 'audienceRelevance', 'relevance', 'followersGrowth',
    'views', 'shares', 'saves', 'likesGrowth',
  ],
  youtube: [
    'followers', 'engagements', 'engagementRate', 'keywords', 'audienceGeo', 'audienceLang',
    'audienceGender', 'audienceAge', 'audienceRelevance', 'relevance', 'followersGrowth',
    'views', 'viewsGrowth',
  ],
} as const satisfies Record<Platform, readonly string[]>;

const ALL_SORT_FIELDS = [
  ...new Set(Object.values(SORT_FIELDS_BY_PLATFORM).flat()),
] as [string, ...string[]];

export const sortSchema = z.strictObject({
  field: z.enum(ALL_SORT_FIELDS),
  direction: z.enum(['asc', 'desc']).optional(),
  value: z.number().optional().describe('Required only when sorting by audienceGeo or audienceInterest.'),
});

/**
 * Which filter fields exist on which platform. Anything absent from this map is universal.
 *
 * The API ignores a filter that does not apply to the platform rather than rejecting it — and
 * still bills for the search — so this is checked locally.
 */
const PLATFORM_ONLY_INFLUENCER_FIELDS = {
  accountTypes: ['instagram'],
  brands: ['instagram'],
  interests: ['instagram'],
  reelsPlays: ['instagram'],
  hasSponsoredPosts: ['instagram'],
  textTags: ['instagram', 'tiktok'],
  likesGrowthRate: ['tiktok'],
  shares: ['tiktok'],
  saves: ['tiktok'],
  views: ['tiktok', 'youtube'],
  isOfficialArtist: ['youtube'],
  viewsGrowthRate: ['youtube'],
} as const satisfies Partial<Record<keyof z.infer<typeof influencerFilterSchema>, readonly Platform[]>>;

const PLATFORM_ONLY_AUDIENCE_FIELDS = {
  interests: ['instagram'],
  credibility: ['instagram'],
} as const satisfies Partial<Record<keyof z.infer<typeof audienceFilterSchema>, readonly Platform[]>>;

export interface SearchRequest {
  platform: Platform;
  filter?: z.infer<typeof searchFilterSchema>;
  sort?: z.infer<typeof sortSchema>;
}

/**
 * Rejects filter and sort fields the chosen platform does not support, with a message naming the
 * field. Returns the problems rather than throwing so the tool can report all of them at once.
 */
export function findPlatformMismatches({ platform, filter, sort }: SearchRequest): string[] {
  const problems: string[] = [];

  const check = (
    section: 'influencer' | 'audience',
    values: Record<string, unknown> | undefined,
    allowed: Record<string, readonly Platform[]>,
  ): void => {
    for (const [field, platforms] of Object.entries(allowed)) {
      if (values?.[field] === undefined) continue;
      if (platforms.includes(platform)) continue;
      problems.push(
        `filter.${section}.${field} is only supported on ${platforms.join(' and ')}, not ${platform}.`,
      );
    }
  };

  check('influencer', filter?.influencer, PLATFORM_ONLY_INFLUENCER_FIELDS);
  check('audience', filter?.audience, PLATFORM_ONLY_AUDIENCE_FIELDS);

  if (sort && !(SORT_FIELDS_BY_PLATFORM[platform] as readonly string[]).includes(sort.field)) {
    problems.push(
      `sort.field "${sort.field}" is not available on ${platform}. Allowed: ` +
        `${SORT_FIELDS_BY_PLATFORM[platform].join(', ')}.`,
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------
// AI Search: POST /ai/{platform}/text-search and /ai/{platform}/lookalikes
// ---------------------------------------------------------------------------------------------

/**
 * A different filter vocabulary from regular search, not a subset of it: `followersCount` rather
 * than `followers`, ids and buckets spelled differently, an `accountType` enum that shares no
 * values with the numeric `accountTypes` used above. Do not try to share a type between them.
 */
export const aiSearchFilterSchema = z.strictObject({
  followersCount: rangeSchema
    .optional()
    .describe('Snapped to buckets (1k, 3k, 5k, 10k, 15k, 20k, 25k, 35k, 50k, 75k, 100k, ...).'),
  viewsCount: rangeSchema
    .extend({ calculationMethod: z.enum(['median', 'average']).optional() })
    .optional(),
  locations: z.array(z.number().int()).min(1).max(100).optional(),
  gender: z.enum(['MALE', 'FEMALE', 'KNOWN', 'UNKNOWN']).optional(),
  lastPostedInDays: z.number().int().positive().optional(),
  accountType: z
    .enum(['creator', 'individual_creator', 'group_creator', 'brand', 'anonymous_content'])
    .optional(),
  language: z.string().min(1).optional(),
  age: z
    .strictObject({
      min: z.enum(['13', '18', '25', '35', '45', '65']).optional(),
      max: z.enum(['18', '25', '35', '45', '65']).optional(),
    })
    .optional(),
  engagementRate: z.strictObject({ min: z.number().min(0).max(1) }).optional(),
  postingFrequency: rangeSchema.optional().describe('Average posts per 30 days.'),
  hasEmail: z.boolean().optional(),
  brands: z
    .array(z.string().min(1))
    .min(1)
    .max(4)
    .optional()
    .describe('Brand names from modash_lookup_ai_dictionary(kind="brands"), not the numeric ids.'),
  username: z.string().min(1).max(100).optional(),
  maxPostAgeMonths: z.union([z.literal(3), z.literal(6), z.literal(9), z.literal(12)]).optional(),
  contentType: z.enum(['video', 'image']).optional(),
  textTags: z
    .array(textTagSchema.extend({ mode: z.enum(['include', 'exclude']).optional() }))
    .max(20)
    .optional(),
  bio: z.string().min(1).max(500).optional(),
  keywords: z.string().min(1).max(500).optional(),
  audience: z
    .strictObject({ credibility: z.number().min(0).max(1).optional() })
    .optional()
    .describe('Instagram only.'),
});

export function findAiPlatformMismatches(platform: Platform, filters?: { audience?: unknown }): string[] {
  if (filters?.audience !== undefined && platform !== 'instagram') {
    return [`filters.audience is only supported on instagram, not ${platform}.`];
  }
  return [];
}
