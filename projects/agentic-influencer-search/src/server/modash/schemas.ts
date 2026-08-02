/**
 * Zod schemas for the slice of the Modash AI Search API this project uses.
 *
 * The filter schema is also handed to the language model as a tool input
 * schema, so the `.describe()` calls are doing double duty: they document the
 * API for the reader *and* teach the agent how to use each filter. Descriptions
 * are condensed from https://docs.modash.io/products/discovery_api/openapi_doc/discovery/ai-search
 *
 * Response schemas are intentionally loose (`.loose()`): Modash adds fields over
 * time, and an example app should not break when they do.
 */

import { z } from 'zod';

export const platformSchema = z.enum(['instagram', 'tiktok', 'youtube']);
export type Platform = z.infer<typeof platformSchema>;

/**
 * Follower/view thresholds snap to the nearest bucket server-side, so there is
 * no point asking for `min: 12_345`.
 */
const FOLLOWER_BUCKETS = [
  1_000, 3_000, 5_000, 10_000, 15_000, 20_000, 25_000, 35_000, 50_000, 75_000, 100_000, 125_000,
  150_000, 175_000, 200_000, 250_000, 300_000, 350_000, 500_000, 1_000_000, 2_000_000, 3_000_000,
] as const;

export const FOLLOWER_BUCKET_HINT = FOLLOWER_BUCKETS.join(', ');

export const aiSearchFiltersSchema = z.object({
  followersCount: z
    .object({
      min: z.number().int().positive().optional(),
      max: z.number().int().positive().optional(),
    })
    .optional()
    .describe(
      `Follower range. Values snap to the nearest bucket: ${FOLLOWER_BUCKET_HINT}. AI Search only covers creators above 10000 followers.`,
    ),

  locations: z
    .array(z.number().int())
    .optional()
    .describe('Creator location IDs. Resolve names to IDs with resolveLocations first — never guess an ID.'),

  language: z
    .string()
    .optional()
    .describe('Creator language code, e.g. "en". Resolve with resolveLanguage first.'),

  gender: z
    .enum(['MALE', 'FEMALE', 'KNOWN', 'UNKNOWN'])
    .optional()
    .describe('Creator gender. KNOWN means male or female; UNKNOWN means gender neutral.'),

  age: z
    .object({
      min: z.enum(['13', '18', '25', '35', '45', '65']).optional(),
      max: z.enum(['18', '25', '35', '45', '65']).optional(),
    })
    .optional()
    .describe('Creator age bracket (the creator, not the audience).'),

  accountType: z
    .enum(['creator', 'individual_creator', 'group_creator', 'brand', 'anonymous_content'])
    .optional()
    .describe(
      'individual_creator = one identifiable person; group_creator = two or more co-equal faces; brand = business or media entity; anonymous_content = no identifiable person. "creator" covers individual + group.',
    ),

  engagementRate: z
    .object({ min: z.number().positive().optional() })
    .optional()
    .describe('Minimum engagement rate as a fraction: 0.02 means 2%.'),

  postingFrequency: z
    .object({
      min: z.number().positive().optional(),
      max: z.number().positive().optional(),
    })
    .optional()
    .describe('Average posts per 30 days.'),

  viewsCount: z
    .object({
      min: z.number().int().positive().optional(),
      max: z.number().int().positive().optional(),
      calculationMethod: z.enum(['median', 'average']).optional(),
    })
    .optional()
    .describe('Average per-post views over the last 60 days. Snaps to the same buckets as followers.'),

  lastPostedInDays: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Only creators who posted within this many days. Profiles refresh every ~4 weeks, so allow slack.'),

  maxPostAgeMonths: z
    .union([z.literal(3), z.literal(6), z.literal(9), z.literal(12)])
    .optional()
    .describe('Only match against posts newer than this. Use 3 or 6 when recency of the content matters.'),

  contentType: z
    .enum(['video', 'image'])
    .optional()
    .describe('Restrict semantic matching to video or image content. Omit for both.'),

  hasEmail: z
    .boolean()
    .optional()
    .describe('Only creators with a public contact email. Useful when the goal is outreach.'),

  brands: z
    .array(z.string())
    .optional()
    .describe('Brand names the creator has posted about. Resolve with resolveBrands first.'),

  textTags: z
    .array(
      z.object({
        type: z.enum(['hashtag', 'mention']),
        value: z.string().describe('Without the # or @ prefix.'),
        mode: z.enum(['include', 'exclude']).optional(),
      }),
    )
    .optional()
    .describe('Hashtags or @mentions used in the creator\'s posts. Resolve with resolveTextTags first.'),

  bio: z.string().optional().describe('Full-text match inside the creator biography.'),

  keywords: z
    .string()
    .optional()
    .describe('Full-text match inside post captions (Instagram/TikTok caption, YouTube title and description).'),

  audience: z
    .object({
      credibility: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Inverse of fake-follower share: 0.75 means at most 25% fake followers.'),
    })
    .optional()
    .describe('Audience quality filters.'),
});

export type AiSearchFilters = z.infer<typeof aiSearchFiltersSchema>;

// --- Responses -------------------------------------------------------------

/**
 * The API signals "no value" with `null` rather than by omitting the key, and it
 * does so for fields the reference documents as required — a creator with no
 * `accountCategory` and a post with no `playsCount` both come back as `null`.
 * Treating those as optional-but-not-nullable fails the whole parse on the first
 * real search, so every response field goes through this. `null` is normalised to
 * `undefined` so the rest of the app has one absent-value type to handle.
 */
function maybe<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value) => value ?? undefined);
}

const postStatsSchema = z
  .object({
    likesCount: maybe(z.number()),
    commentsCount: maybe(z.number()),
    playsCount: maybe(z.number()),
    viewsCount: maybe(z.number()),
  })
  .loose();

const postSchema = z
  .object({
    id: maybe(z.string()),
    url: maybe(z.string()),
    thumbnail: maybe(z.string()),
    stats: maybe(postStatsSchema),
  })
  .loose();

const profileSchema = z
  .object({
    userId: maybe(z.string()),
    // The one field we genuinely cannot render without.
    username: z.string(),
    fullName: maybe(z.string()),
    profilePicture: maybe(z.string()),
    followersCount: maybe(z.number()),
    engagementRate: maybe(z.number()),
    postingFrequency: maybe(z.number()),
    viewsCountMedian: maybe(z.number()),
    viewsCountMean: maybe(z.number()),
    accountCategory: maybe(z.string()),
    url: maybe(z.string()),
    matchedPosts: maybe(z.array(postSchema)),
    recentPosts: maybe(z.array(postSchema)),
  })
  .loose();

export const textSearchResponseSchema = z
  .object({
    total: maybe(z.number()),
    profiles: z.array(profileSchema).default([]),
  })
  .loose();

export const lookalikesResponseSchema = z
  .object({
    total: maybe(z.number()),
    sourceProfiles: z.array(profileSchema).default([]),
    lookalikes: z.array(profileSchema).default([]),
  })
  .loose();

export const locationsResponseSchema = z
  .object({
    locations: z
      .array(z.object({ id: z.number(), name: maybe(z.string()), title: maybe(z.string()) }).loose())
      .default([]),
    total: maybe(z.number()),
  })
  .loose();

export const languagesResponseSchema = z
  .object({
    languages: z.array(z.object({ code: z.string(), name: maybe(z.string()) }).loose()).default([]),
    total: maybe(z.number()),
  })
  .loose();

export const brandsResponseSchema = z
  .object({
    result: z
      .array(z.object({ brandId: maybe(z.string()), name: z.string(), logoUrl: maybe(z.string()) }).loose())
      .default([]),
  })
  .loose();

/** Shared by GET /ai/hashtags and GET /ai/mentions: values without the # or @ prefix. */
export const textTagsResponseSchema = z
  .object({
    result: z.array(z.object({ value: z.string(), count: maybe(z.number()) }).loose()).default([]),
  })
  .loose();

/**
 * GET /{platform}/profile/{userId}/report — 1 credit, and by far the most
 * expensive call here. Only the audience fields the UI shows are modelled; a
 * real report carries a lot more (post history, brand affinity, notable users,
 * lookalikes) and `.loose()` keeps all of it intact for anyone who wants it.
 */
const weightedSchema = z.object({ code: maybe(z.string()), name: maybe(z.string()), weight: maybe(z.number()) }).loose();

export const reportResponseSchema = z
  .object({
    profile: z
      .object({
        userId: maybe(z.string()),
        profile: maybe(
          z
            .object({
              username: maybe(z.string()),
              url: maybe(z.string()),
              picture: maybe(z.string()),
              followers: maybe(z.number()),
              engagementRate: maybe(z.number()),
            })
            .loose(),
        ),
        audience: maybe(
          z
            .object({
              credibility: maybe(z.number()),
              genders: maybe(z.array(weightedSchema)),
              ages: maybe(z.array(weightedSchema)),
              geoCountries: maybe(z.array(weightedSchema)),
            })
            .loose(),
        ),
        contacts: maybe(z.array(z.object({ type: z.string(), value: z.string() }).loose())),
      })
      .loose(),
  })
  .loose();

export const accountInfoResponseSchema = z
  .object({
    billing: maybe(z.object({ credits: maybe(z.number()), rawRequests: maybe(z.number()) }).loose()),
    rateLimits: maybe(
      z.object({ discoveryRatelimit: maybe(z.number()), rawRatelimit: maybe(z.number()) }).loose(),
    ),
  })
  .loose();

export type ModashProfile = z.infer<typeof profileSchema>;
export type ModashPost = z.infer<typeof postSchema>;
