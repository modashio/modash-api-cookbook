import * as z from 'zod';

/**
 * Response schemas for the Discovery endpoints this server exposes.
 *
 * Two rules, both learned the hard way and both the opposite of what you would write from the
 * OpenAPI document alone:
 *
 *  1. **Every field is optional.** Plenty of fields the spec marks `required` are simply absent
 *     from real responses — a profile report will happily omit `city`, `state`, `gender` and
 *     `ageGroup` for a creator Modash has not resolved those for. A schema that enforces the
 *     documented required set throws on ordinary data.
 *
 *  2. **Every object is loose** (`z.looseObject`, the Zod 4 spelling of `.passthrough()`). Real
 *     responses carry fields the spec does not mention — `isVerified` and `isPrivate` on search
 *     profiles, `count` on brand dictionary entries. Stripping them would quietly discard data the
 *     caller asked for. Never use `z.strictObject` on a response.
 *
 * A schema here is a *floor*, not a contract: it guarantees the fields we read are the right type
 * when present, and lets everything else through untouched.
 */

/** Declared on essentially every 200 response. `errors.ts` checks it; schemas just tolerate it. */
const errorFlag = { error: z.boolean().optional() };

const number = z.number().optional();
const string = z.string().optional();

// ---------------------------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------------------------

export const userInfoSchema = z.looseObject({
  ...errorFlag,
  billing: z
    .looseObject({
      // Credits are fractional floats. Never model them as integers.
      credits: number,
      rawRequests: number,
    })
    .optional(),
  rateLimits: z
    .looseObject({
      discoveryRatelimit: number,
      rawRatelimit: number,
    })
    .optional(),
});

// ---------------------------------------------------------------------------------------------
// Free lookups and dictionaries
// ---------------------------------------------------------------------------------------------

export const listUsersSchema = z.looseObject({
  ...errorFlag,
  users: z
    .array(
      z.looseObject({
        userId: string,
        username: string,
        fullname: string,
        followers: number,
        isVerified: z.boolean().optional(),
        // YouTube only.
        handle: string,
      }),
    )
    .optional(),
});

/**
 * The six dictionary families return four different body shapes. Rather than four schemas and a
 * switch at every call site, this one schema accepts all of them and the caller reads the key it
 * expects. `topics` and `hashtags` return `{ tags: string[] }` and carry no `total`.
 */
export const dictionarySchema = z.looseObject({
  ...errorFlag,
  total: number,
  interests: z.array(z.looseObject({ id: number, name: string })).optional(),
  brands: z.array(z.looseObject({ id: number, name: string, count: number })).optional(),
  locations: z.array(z.looseObject({ id: number, name: string, title: string })).optional(),
  languages: z.array(z.looseObject({ code: string, name: string })).optional(),
  tags: z.array(z.string()).optional(),
});

export const aiBrandsSchema = z.looseObject({
  ...errorFlag,
  result: z
    .array(
      z.looseObject({
        brandId: string,
        name: string,
        accounts: z
          .array(z.looseObject({ platform: string, username: string, domain: string }))
          .optional(),
      }),
    )
    .optional(),
});

/** `GET /ai/locations`. These ids are only valid in AI Search filters, not in regular search. */
export const aiLocationsSchema = z.looseObject({
  ...errorFlag,
  result: z.array(z.looseObject({ id: number, name: string, title: string })).optional(),
});

export const aiListSchema = z.looseObject({
  ...errorFlag,
  listId: z.string(),
  approximateMemberCount: number,
});

export const aiListMembersSchema = z.looseObject({
  ...errorFlag,
  addedCount: number,
  existingCount: number,
  approximateMemberCount: number,
});

/** `DELETE /ai/lists/{listId}` documents no 200 body, so accept whatever comes back. */
export const emptySchema = z.unknown();

export const aiTagsSchema = z.looseObject({
  ...errorFlag,
  result: z.array(z.looseObject({ value: string, count: number })).optional(),
});

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

const searchProfileSchema = z.looseObject({
  userId: string,
  username: string,
  fullname: string,
  url: string,
  picture: string,
  followers: number,
  engagements: number,
  engagementRate: number,
  // Present on YouTube results, and undocumented but present on all three.
  averageViews: number,
  handle: string,
  isVerified: z.boolean().optional(),
  isPrivate: z.boolean().optional(),
});

export const searchSchema = z.looseObject({
  ...errorFlag,
  total: number,
  /**
   * `isExactMatch: false` means Modash could not satisfy every filter and dropped some to find
   * anything at all. Surfacing it stops a model from reporting loose matches as exact ones.
   */
  isExactMatch: z.boolean().optional(),
  directs: z.array(z.looseObject({ userId: string, profile: searchProfileSchema })).optional(),
  lookalikes: z.array(z.looseObject({ userId: string, profile: searchProfileSchema })).optional(),
});

// ---------------------------------------------------------------------------------------------
// AI Search and lookalikes
// ---------------------------------------------------------------------------------------------

/**
 * Note the field names differ from regular search: `followersCount` not `followers`,
 * `profilePicture` not `picture`, `fullName` not `fullname`. The two families do not share a type.
 */
const aiProfileSchema = z.looseObject({
  userId: string,
  username: string,
  fullName: string,
  url: string,
  profilePicture: string,
  followersCount: number,
  engagementRate: number,
  postingFrequency: number,
  viewsCountMedian: number,
  accountCategory: string,
  matchedPosts: z.array(z.looseObject({ id: string, url: string })).optional(),
});

export const aiSearchSchema = z.looseObject({
  ...errorFlag,
  total: number,
  profiles: z.array(aiProfileSchema).optional(),
});

export const aiLookalikesSchema = z.looseObject({
  ...errorFlag,
  total: number,
  sourceProfiles: z.array(aiProfileSchema).optional(),
  lookalikes: z.array(aiProfileSchema).optional(),
});

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const weightedSchema = z
  .array(z.looseObject({ code: string, name: string, weight: number }))
  .optional();

const postSchema = z.looseObject({
  id: string,
  url: string,
  text: string,
  created: string,
  likes: number,
  comments: number,
  views: number,
  type: string,
});

/**
 * A report is the largest response in the API — tens of thousands of tokens once serialised — so
 * this schema names only the fields the report tool digests. Everything else survives via
 * `z.looseObject` and is available if you want it, but is not forced into a model's context.
 */
export const reportSchema = z.looseObject({
  ...errorFlag,
  profile: z
    .looseObject({
      userId: string,
      profile: searchProfileSchema.optional(),
      isVerified: z.boolean().optional(),
      isPrivate: z.boolean().optional(),
      accountType: string,
      bio: string,
      country: string,
      city: string,
      gender: string,
      ageGroup: string,
      language: z.looseObject({ code: string, name: string }).optional(),
      postsCount: number,
      avgLikes: number,
      avgComments: number,
      avgViews: number,
      avgReelsPlays: number,
      /** Ratio of sponsored to organic performance. Below 1 means sponsored posts underperform. */
      paidPostPerformance: number,
      contacts: z.array(z.looseObject({ type: string, value: string })).optional(),
      interests: z.array(z.looseObject({ id: number, name: string })).optional(),
      brandAffinity: z.array(z.looseObject({ id: number, name: string })).optional(),
      audience: z
        .looseObject({
          /** 0..1, the inverse of the estimated fake-follower share. 0.75 means 25% look fake. */
          credibility: number,
          notable: number,
          genders: weightedSchema,
          ages: weightedSchema,
          geoCountries: weightedSchema,
          geoCities: weightedSchema,
          languages: weightedSchema,
          interests: weightedSchema,
          ethnicities: weightedSchema,
        })
        .optional(),
      recentPosts: z.array(postSchema).optional(),
      popularPosts: z.array(postSchema).optional(),
      sponsoredPosts: z.array(postSchema).optional(),
      lookalikes: z.array(searchProfileSchema).optional(),
      statHistory: z
        .array(z.looseObject({ month: string, followers: number, avgLikes: number, avgViews: number }))
        .optional(),
    })
    .optional(),
});

export type Report = z.infer<typeof reportSchema>;

// ---------------------------------------------------------------------------------------------
// Audience overlap, email search, collaborations
// ---------------------------------------------------------------------------------------------

export const audienceOverlapSchema = z.looseObject({
  ...errorFlag,
  reportInfo: z
    .looseObject({ totalFollowers: number, totalUniqueFollowers: number })
    .optional(),
  data: z
    .array(
      z.looseObject({
        userId: string,
        username: string,
        followers: number,
        uniquePercentage: number,
        overlappingPercentage: number,
      }),
    )
    .optional(),
});

export const emailSearchSchema = z.looseObject({
  ...errorFlag,
  totalMatches: number,
  matchedEmails: z
    .array(
      z.looseObject({
        email: string,
        users: z
          .array(
            z.looseObject({
              platform: string,
              userId: string,
              username: string,
              url: string,
              followers: number,
              engagementRate: number,
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  notMatchedEmails: z.array(z.string()).optional(),
});

const collaborationPostSchema = z.looseObject({
  post_id: string,
  post_timestamp: number,
  title: string,
  description: string,
  /** Free text, prefixed with a disclosure category such as "Properly Disclosed Sponsorship". */
  label: string,
  collaboration_type: string,
  stats: z.looseObject({ likes: number, comments: number, views: number, plays: number }).optional(),
  sponsors: z.array(z.looseObject({ name: string, domain: string, category: string })).optional(),
  /** Brand-side posts only: the creator who published the post. */
  user_id: string,
  username: string,
  platform: string,
});

const collaborationSideSchema = z
  .looseObject({
    id: string,
    platform: string,
    username: string,
    brand_name: string,
    brand_domain: string,
    is_more_available: z.boolean().optional(),
    posts: z.array(collaborationPostSchema).optional(),
    /**
     * The summary endpoint returns one of three platform-shaped objects with no discriminator
     * field, so it stays unknown here. You already know the platform from your own request.
     */
    summary: z.unknown().optional(),
    per_brand_summary: z.unknown().optional(),
    per_influencer_summary: z.unknown().optional(),
  })
  .optional();

export const collaborationsSchema = z.looseObject({
  ...errorFlag,
  /** Opaque pagination cursor. Documented as valid for two days. */
  cursor: string,
  influencer: collaborationSideSchema,
  brand: collaborationSideSchema,
});

// ---------------------------------------------------------------------------------------------
// RAW API
// ---------------------------------------------------------------------------------------------

/**
 * The RAW API promises "data returned as-is, without filtering", and delivers on it: four
 * endpoints produce four unrelated shapes, one of them a bare object with no envelope at all.
 * There is no contract here to encode, so this validates nothing and passes the payload through.
 *
 * That is not laziness — writing a schema would mean inventing a guarantee the product does not
 * make, and it would break the first time a platform changed a field. The error envelope is still
 * checked, in `errors.ts`, because that part *is* documented.
 */
export const rawResponseSchema = z.unknown();
