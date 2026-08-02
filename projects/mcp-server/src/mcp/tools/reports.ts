import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

import { getAudienceOverlap, getReport } from '../../server/modash/endpoints.js';
import { platformSchema } from '../../server/modash/filters.js';
import type { Report } from '../../server/modash/responses.js';
import type { ToolContext } from '../context.js';
import { guard, priced, problem, respond, withCost } from '../result.js';

const OPTIONAL_SECTIONS = [
  'recentPosts',
  'sponsoredPosts',
  'lookalikes',
  'followerHistory',
] as const;

const weightedSchema = z.array(z.object({ name: z.string(), share: z.number() }));

export function registerReportTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'modash_get_creator_report',
    {
      title: 'Get a creator report',
      description:
        'Returns Modash\'s full analysis of one creator: engagement averages, audience geography, ' +
        'age, gender and language breakdowns, audience credibility (the inverse of the estimated ' +
        'fake-follower share), brand affinity, contact details, and how sponsored posts perform ' +
        'against organic ones. Costs 1 credit per call, the most expensive call available, so ' +
        'resolve the handle with modash_find_creator first and only run this on a shortlist. ' +
        'Reports are stable enough to cache for weeks; do not call it twice for the same creator.',
      inputSchema: z.object({
        platform: platformSchema,
        userId: z
          .string()
          .min(1)
          .describe('Handle or userId. Prefer the userId from modash_find_creator.'),
        calculationMethod: z
          .enum(['median', 'average'])
          .optional()
          .describe('How averages are computed. Modash uses median unless you say otherwise.'),
        include: z
          .array(z.enum(OPTIONAL_SECTIONS))
          .default([])
          .describe(
            'Extra sections to return. Omitted by default because a full report is very large; ' +
              'the summary below is returned either way.',
          ),
      }),
      outputSchema: withCost({
        creator: z.object({
          userId: z.string().optional(),
          username: z.string().optional(),
          fullname: z.string().optional(),
          url: z.string().optional(),
          followers: z.number().optional(),
          engagementRate: z.number().optional(),
          avgLikes: z.number().optional(),
          avgComments: z.number().optional(),
          avgViews: z.number().optional(),
          isVerified: z.boolean().optional(),
          bio: z.string().optional(),
          country: z.string().optional(),
          contacts: z.array(z.object({ type: z.string(), value: z.string() })),
        }),
        audience: z.object({
          credibility: z.number().optional(),
          countries: weightedSchema,
          ages: weightedSchema,
          genders: weightedSchema,
          languages: weightedSchema,
          interests: weightedSchema,
        }),
        sponsored: z.object({
          /** Below 1 means sponsored posts underperform this creator's organic posts. */
          paidPostPerformance: z.number().optional(),
          sponsoredPostCount: z.number(),
        }),
        sections: z.record(z.string(), z.unknown()),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, userId, calculationMethod, include }) => {
      const { data, cost } = await priced(ctx.ledger, () =>
        getReport(ctx.client, { platform, userId, calculationMethod }),
      );

      const profile = data.profile;
      if (profile === undefined) {
        return problem(`Modash returned no report for ${platform}/${userId}.`);
      }

      return respond({ ...digest(profile), sections: sections(profile, include), cost });
    }),
  );

  server.registerTool(
    'modash_compare_audience_overlap',
    {
      title: 'Compare audience overlap',
      description:
        'Compares the follower bases of several creators and reports how much they overlap and ' +
        'how much of each creator\'s audience is unique to them. Costs 1 credit per call ' +
        'regardless of how many creators you compare, so compare the whole shortlist at once. ' +
        'Instagram and YouTube only; Modash does not offer this for TikTok. Use it to avoid ' +
        'paying two creators to reach the same people.',
      inputSchema: z.object({
        platform: z.enum(['instagram', 'youtube']),
        creators: z
          .array(z.string().min(1))
          .min(2)
          .max(10)
          .describe('Handles or userIds. One call covers all of them.'),
      }),
      outputSchema: withCost({
        totalFollowers: z.number().optional(),
        totalUniqueFollowers: z.number().optional(),
        creators: z.array(
          z.object({
            username: z.string().optional(),
            followers: z.number().optional(),
            uniqueShare: z.number().optional(),
            overlappingShare: z.number().optional(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, creators }) => {
      const { data, cost } = await priced(ctx.ledger, () =>
        getAudienceOverlap(ctx.client, { platform, influencers: creators }),
      );

      return respond({
        totalFollowers: data.reportInfo?.totalFollowers,
        totalUniqueFollowers: data.reportInfo?.totalUniqueFollowers,
        creators: (data.data ?? []).map((entry) => ({
          username: entry.username,
          followers: entry.followers,
          uniqueShare: entry.uniquePercentage,
          overlappingShare: entry.overlappingPercentage,
        })),
        cost,
      });
    }),
  );
}

type ReportProfile = NonNullable<Report['profile']>;

/** The top few entries of a weighted list, renamed so `weight` reads as what it is. */
const top = (
  entries: { name?: string | undefined; code?: string | undefined; weight?: number | undefined }[] | undefined,
  count = 5,
) =>
  (entries ?? [])
    .slice(0, count)
    .map((entry) => ({ name: entry.name ?? entry.code ?? '', share: entry.weight ?? 0 }));

/**
 * A full report runs to tens of thousands of tokens — hundreds of posts, month-by-month history,
 * dozens of lookalikes. Returning all of it would spend most of a model's context on data nobody
 * asked for, so the tool returns this summary and fetches the rest only when `include` says so.
 */
function digest(profile: ReportProfile) {
  return {
    creator: {
      userId: profile.userId,
      username: profile.profile?.username,
      fullname: profile.profile?.fullname,
      url: profile.profile?.url,
      followers: profile.profile?.followers,
      engagementRate: profile.profile?.engagementRate,
      avgLikes: profile.avgLikes,
      avgComments: profile.avgComments,
      avgViews: profile.avgViews ?? profile.avgReelsPlays,
      isVerified: profile.isVerified,
      bio: profile.bio,
      country: profile.country,
      contacts: (profile.contacts ?? []).map((contact) => ({
        type: contact.type ?? '',
        value: contact.value ?? '',
      })),
    },
    audience: {
      credibility: profile.audience?.credibility,
      countries: top(profile.audience?.geoCountries),
      ages: top(profile.audience?.ages),
      genders: top(profile.audience?.genders),
      languages: top(profile.audience?.languages),
      interests: top(profile.audience?.interests),
    },
    sponsored: {
      paidPostPerformance: profile.paidPostPerformance,
      sponsoredPostCount: profile.sponsoredPosts?.length ?? 0,
    },
  };
}

function sections(
  profile: ReportProfile,
  include: readonly (typeof OPTIONAL_SECTIONS)[number][],
): Record<string, unknown> {
  const available = {
    recentPosts: profile.recentPosts,
    sponsoredPosts: profile.sponsoredPosts,
    lookalikes: profile.lookalikes,
    followerHistory: profile.statHistory,
  };

  return Object.fromEntries(include.map((name) => [name, available[name] ?? []]));
}
