import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

import { getCollaborationPosts, getCollaborationSummary } from '../../server/modash/endpoints.js';
import { platformSchema } from '../../server/modash/filters.js';
import type { ToolContext } from '../context.js';
import { guard, priced, respond, withCost } from '../result.js';

/**
 * Brand partnership history: who a creator has worked with, and how those posts performed.
 *
 * Useful for vetting (has this creator already promoted a competitor?) and for competitor
 * tracking (who has this brand been paying?). Both directions come from the same endpoints — pass
 * a creator id or a brand id and Modash populates whichever side matches.
 */
export function registerCollaborationTools(server: McpServer, ctx: ToolContext): void {
  /**
   * The two endpoints take different identifiers: `/collaborations/posts` accepts a brand id and
   * `/collaborations/summary` does not. Sharing one `id` description would advertise brand ids on
   * both, and a model that took the offer would burn 0.2 credits to find out otherwise.
   */
  const target = (idDescription: string) => ({
    id: z.string().min(1).describe(idDescription),
    platform: platformSchema,
    collaboratorId: z
      .string()
      .optional()
      .describe('Restrict to collaborations between this creator and this specific brand'),
  });

  server.registerTool(
    'modash_list_collaborations',
    {
      title: 'List brand collaboration posts',
      description:
        'Returns individual sponsored posts for a creator, or for a brand across its creators, ' +
        'each with its engagement stats, the sponsoring brand, the partnership type (Paid, ' +
        'Gifted, Ambassador, Affiliate) and how the sponsorship was disclosed. Costs 0.2 credits ' +
        'per call, up to 30 posts. Use this to see the actual posts; use ' +
        'modash_summarise_collaborations for totals across a creator\'s whole partnership history.',
      inputSchema: z.object({
        ...target('Creator userId, handle, profile URL, or a brand id from the brand dictionary'),
        limit: z.number().int().min(1).max(30).default(10),
        cursor: z.string().optional().describe('From a previous call. Valid for two days.'),
        since: z.number().int().optional().describe('Only posts after this epoch-millisecond time'),
        groupBrandCollaborations: z
          .boolean()
          .default(true)
          .describe('Group a brand\'s regional and variant accounts together'),
      }),
      outputSchema: withCost({
        subject: z.enum(['creator', 'brand', 'none']),
        hasMore: z.boolean(),
        cursor: z.string().optional(),
        posts: z.array(
          z.object({
            postId: z.string().optional(),
            postedAt: z.string().optional(),
            title: z.string().optional(),
            disclosure: z.string().optional(),
            collaborationType: z.string().optional(),
            likes: z.number().optional(),
            comments: z.number().optional(),
            views: z.number().optional(),
            brands: z.array(z.string()),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ id, platform, collaboratorId, limit, cursor, since, groupBrandCollaborations }) => {
      const { data, cost } = await priced(ctx.ledger, () =>
        getCollaborationPosts(ctx.client, {
          id,
          platform,
          collaboratorId,
          limit,
          cursor,
          groupBrandCollaborations,
          ...(since === undefined ? {} : { postCreationTimestampMs: { gte: since } }),
        }),
      );

      const side = data.influencer ?? data.brand;

      return respond({
        subject: data.influencer ? 'creator' : data.brand ? 'brand' : 'none',
        hasMore: side?.is_more_available ?? false,
        cursor: data.cursor,
        posts: (side?.posts ?? []).map((post) => ({
          postId: post.post_id,
          postedAt: post.post_timestamp === undefined ? undefined : new Date(post.post_timestamp).toISOString(),
          title: post.title,
          disclosure: post.label,
          collaborationType: post.collaboration_type,
          likes: post.stats?.likes,
          comments: post.stats?.comments,
          views: post.stats?.views ?? post.stats?.plays,
          brands: (post.sponsors ?? []).map((sponsor) => sponsor.name ?? sponsor.domain ?? ''),
        })),
        cost,
      });
    }),
  );

  server.registerTool(
    'modash_summarise_collaborations',
    {
      title: 'Summarise brand collaboration history',
      description:
        'Returns aggregate partnership figures for one creator: how many collaborations, how many ' +
        'distinct brands, when the first and most recent ones happened, and totals per brand. ' +
        'Costs 0.2 credits per call. Use this to judge whether a creator does sponsored work ' +
        'regularly and who with; use modash_list_collaborations to read the posts. That tool also ' +
        'accepts a brand id to look at a brand\'s side; this one does not, creators only.',
      inputSchema: z.object({
        ...target('Creator userId, handle or profile URL. Brand ids are not accepted here.'),
        limit: z.number().int().min(1).max(10).default(10),
        cursor: z.string().optional(),
      }),
      outputSchema: withCost({
        subject: z.enum(['creator', 'none']),
        /**
         * Modash returns one of three platform-shaped summary objects with no field to tell them
         * apart, so this is passed through as-is rather than flattened into a wrong shape. You
         * already know which platform you asked about.
         */
        summary: z.unknown(),
        perBrand: z.unknown(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ id, platform, collaboratorId, limit, cursor }) => {
      const { data, cost } = await priced(ctx.ledger, () =>
        getCollaborationSummary(ctx.client, { id, platform, collaboratorId, limit, cursor }),
      );

      return respond({
        subject: data.influencer ? 'creator' : 'none',
        summary: data.influencer?.summary ?? null,
        perBrand: data.influencer?.per_brand_summary ?? null,
        cost,
      });
    }),
  );
}
