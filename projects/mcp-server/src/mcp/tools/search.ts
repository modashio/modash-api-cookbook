import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

import { aiLookalikes, aiTextSearch, searchCreators } from '../../server/modash/endpoints.js';
import {
  aiSearchFilterSchema,
  findAiPlatformMismatches,
  findPlatformMismatches,
  platformSchema,
  searchFilterSchema,
  sortSchema,
} from '../../server/modash/filters.js';
import { SEARCH_RESULTS_PER_PAGE } from '../../server/modash/pricing.js';
import type { ToolContext } from '../context.js';
import { guard, priced, problem, respond, withCost } from '../result.js';

const creatorSchema = z.object({
  userId: z.string().optional(),
  username: z.string().optional(),
  fullname: z.string().optional(),
  url: z.string().optional(),
  followers: z.number().optional(),
  engagementRate: z.number().optional(),
  isVerified: z.boolean().optional(),
});

/** Two searches with different vocabularies: structured filters, and natural language. */
export function registerSearchTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'modash_search_creators',
    {
      title: 'Search creators by filters',
      description:
        'Searches the Modash creator database with structured filters on the creator (followers, ' +
        'engagement rate, location, bio, contact details) and on their audience (geography, age, ' +
        'gender, language, credibility). Returns 15 creators per page and costs 0.15 credits per ' +
        'call — the page size is fixed, so paging four times costs 0.6 credits. Locations, ' +
        'interests and brands must be given as ids from modash_lookup_dictionary. Use this when ' +
        'you can express what you want as filters; use modash_ai_search_creators when the ' +
        'requirement is about what appears in the content itself.',
      inputSchema: z.object({
        platform: platformSchema,
        filter: searchFilterSchema.optional(),
        sort: sortSchema.optional(),
        page: z.number().int().min(0).max(665).default(0),
        calculationMethod: z
          .enum(['median', 'average'])
          .optional()
          .describe('How averages are computed. Modash uses median unless you say otherwise.'),
      }),
      outputSchema: withCost({
        totalMatches: z.number().optional(),
        /**
         * False means Modash could not satisfy every filter and dropped some to return anything
         * at all. Without this a model reports approximate matches as if they were exact.
         */
        isExactMatch: z.boolean().optional(),
        creators: z.array(creatorSchema),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, filter, sort, page, calculationMethod }) => {
      /**
       * The API accepts a filter for the wrong platform, ignores it, returns a full page of
       * results and bills for them. Catching that here is the difference between "your filter was
       * wrong" and "here are fifteen creators that have nothing to do with what you asked for,
       * that will be 0.15 credits".
       */
      const problems = findPlatformMismatches({ platform, filter, sort });
      if (problems.length > 0) return problem(problems.join('\n'));

      const { data, cost } = await priced(ctx.ledger, () =>
        searchCreators(ctx.client, { platform, filter, sort, page, calculationMethod }),
      );

      // `directs` are exact matches, `lookalikes` are Modash's suggestions. Exact first.
      const results = [...(data.directs ?? []), ...(data.lookalikes ?? [])];

      return respond({
        totalMatches: data.total,
        isExactMatch: data.isExactMatch,
        creators: results.slice(0, SEARCH_RESULTS_PER_PAGE).map((result) => ({
          userId: result.userId ?? result.profile?.userId,
          username: result.profile?.username,
          fullname: result.profile?.fullname,
          url: result.profile?.url,
          followers: result.profile?.followers,
          engagementRate: result.profile?.engagementRate,
          isVerified: result.profile?.isVerified,
        })),
        cost,
      });
    }),
  );

  server.registerTool(
    'modash_ai_search_creators',
    {
      title: 'Search creators by description',
      description:
        'Finds creators whose posts match a natural-language description of the content, using ' +
        'vector similarity over posts rather than keyword matching. Costs 0.025 credits per ' +
        'result returned, so pageSize is the entire cost: the default 6 costs 0.15 and the ' +
        'maximum 50 costs 1.25, more than a full profile report. Limited to one request per ' +
        'second and to creators above 10,000 followers. Describe what should be visible in the ' +
        'content; put anything with a filter (location, language, follower count, age) in ' +
        'filters instead, and do not phrase the query as a negation — "not vegan" will not work.',
      inputSchema: z.object({
        platform: platformSchema,
        query: z.string().min(1).max(8192),
        filters: aiSearchFilterSchema.optional(),
        page: z.number().int().min(0).default(0),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(6)
          .describe('Results per page. Each one costs 0.025 credits. Start small.'),
      }),
      outputSchema: withCost({
        totalMatches: z.number().optional(),
        creators: z.array(
          creatorSchema.extend({
            accountCategory: z.string().optional(),
            postingFrequency: z.number().optional().describe('Average posts per 30 days'),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, query, filters, page, pageSize }) => {
      const problems = findAiPlatformMismatches(platform, filters);
      if (problems.length > 0) return problem(problems.join('\n'));

      const { data, cost } = await priced(ctx.ledger, () =>
        aiTextSearch(ctx.client, { platform, query, filters, page, pageSize }),
      );

      return respond({
        totalMatches: data.total,
        creators: (data.profiles ?? []).map((profile) => ({
          userId: profile.userId,
          username: profile.username,
          fullname: profile.fullName,
          url: profile.url,
          followers: profile.followersCount,
          engagementRate: profile.engagementRate,
          accountCategory: profile.accountCategory,
          postingFrequency: profile.postingFrequency,
        })),
        cost,
      });
    }),
  );

  server.registerTool(
    'modash_find_lookalikes',
    {
      title: 'Find creators similar to known creators',
      description:
        'Given up to five creators you already know, finds others whose content and audience ' +
        'resemble them. Set targetPlatform to search a different platform from the one the source ' +
        'creators are on. Costs 0.025 credits per result, so pageSize sets the price, and is ' +
        'limited to one request per second. Use this when you have a creator who worked well and ' +
        'want more like them; use modash_ai_search_creators when you only have a description.',
      inputSchema: z.object({
        platform: platformSchema.describe('Platform the source creators are on'),
        userIds: z
          .array(z.string().min(1))
          .min(1)
          .max(5)
          .describe('User ids or handles, from modash_find_creator'),
        targetPlatform: platformSchema
          .optional()
          .describe('Platform to find lookalikes on. Defaults to the source platform.'),
        filters: aiSearchFilterSchema.optional(),
        page: z.number().int().min(0).default(0),
        pageSize: z.number().int().min(1).max(50).default(6),
      }),
      outputSchema: withCost({
        totalMatches: z.number().optional(),
        creators: z.array(creatorSchema.extend({ accountCategory: z.string().optional() })),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, userIds, targetPlatform, filters, page, pageSize }) => {
      const problems = findAiPlatformMismatches(targetPlatform ?? platform, filters);
      if (problems.length > 0) return problem(problems.join('\n'));

      const { data, cost } = await priced(ctx.ledger, () =>
        aiLookalikes(ctx.client, { platform, userIds, targetPlatform, filters, page, pageSize }),
      );

      return respond({
        totalMatches: data.total,
        creators: (data.lookalikes ?? []).map((profile) => ({
          userId: profile.userId,
          username: profile.username,
          fullname: profile.fullName,
          url: profile.url,
          followers: profile.followersCount,
          engagementRate: profile.engagementRate,
          accountCategory: profile.accountCategory,
        })),
        cost,
      });
    }),
  );
}
