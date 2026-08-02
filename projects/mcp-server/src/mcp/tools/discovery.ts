import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

import {
  DICTIONARY_KINDS,
  getAiBrands,
  getAiTags,
  getDictionary,
  listUsers,
  searchByEmail,
} from '../../server/modash/endpoints.js';
import { platformSchema } from '../../server/modash/filters.js';
import type { ToolContext } from '../context.js';
import { guard, priced, problem, respond, withCost } from '../result.js';

/**
 * The free half of the API: resolving handles, and the dictionaries that turn human words into the
 * ids every paid filter actually wants.
 *
 * Modash publishes seventeen dictionary endpoints. Exposing seventeen tools would be a
 * straightforward mapping and a bad one — a model picks worse from a longer list, and every tool
 * definition is re-sent on every turn. Two tools with a `kind` parameter cover all of them.
 */
export function registerDiscoveryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'modash_find_creator',
    {
      title: 'Find a creator by name or handle',
      description:
        'Looks up creators on one platform by handle or name and returns their Modash userId, ' +
        'follower count and verified status. Free: costs no credits. Always use this to turn a ' +
        'name into a userId before calling modash_get_creator_report, which costs a credit per ' +
        'call — paying for a report on the wrong account is the most common way to waste one. ' +
        'This returns identity only; for audience demographics or engagement use the report tool.',
      inputSchema: z.object({
        platform: platformSchema,
        query: z.string().min(1).describe('Handle or display name, with or without a leading @'),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      outputSchema: z.object({
        creators: z.array(
          z.object({
            userId: z.string().optional(),
            username: z.string().optional(),
            fullname: z.string().optional(),
            followers: z.number().optional(),
            isVerified: z.boolean().optional(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, query, limit }) => {
      const response = await listUsers(ctx.client, {
        platform,
        query: query.replace(/^@/, ''),
        limit,
      });
      return respond({
        creators: (response.users ?? []).slice(0, limit).map((user) => ({
          userId: user.userId,
          username: user.username,
          fullname: user.fullname,
          followers: user.followers,
          isVerified: user.isVerified,
        })),
      });
    }),
  );

  server.registerTool(
    'modash_lookup_dictionary',
    {
      title: 'Look up filter ids',
      description:
        'Searches the Modash dictionaries and returns the ids that search filters require. Free: ' +
        'costs no credits. Locations and interests must be passed to modash_search_creators as ' +
        'numeric ids and languages as codes, never as names, so resolve them here first — a name ' +
        'in a filter is silently ignored and you still pay for the search. Kinds: interests and ' +
        'brands (Instagram only), locations, languages, topics, hashtags.',
      inputSchema: z.object({
        platform: platformSchema,
        kind: z.enum(DICTIONARY_KINDS),
        query: z
          .string()
          .optional()
          .describe('Substring to match, e.g. "London" or "coffee". Required for topics and hashtags.'),
        limit: z.number().int().min(1).max(200).default(20),
      }),
      outputSchema: z.object({
        kind: z.enum(DICTIONARY_KINDS),
        items: z.array(
          z.object({
            id: z.union([z.number(), z.string()]).optional(),
            name: z.string(),
            /** Locations only: the disambiguated form, e.g. "London, Ontario, Canada". */
            title: z.string().optional(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ platform, kind, query, limit }) => {
      if ((kind === 'interests' || kind === 'brands') && platform !== 'instagram') {
        return problem(
          `Modash only publishes the ${kind} dictionary for Instagram. Use platform="instagram", ` +
            `or filter ${platform} by topics or hashtags instead.`,
        );
      }

      // The topics and hashtags dictionaries have no browsable full list — they only answer a
      // query. Asking for one without a query is a 400.
      if ((kind === 'topics' || kind === 'hashtags') && (query === undefined || query === '')) {
        return problem(`The ${kind} dictionary needs a query to match against, e.g. "coffee".`);
      }

      const response = await getDictionary(ctx.client, { platform, kind, query, limit });

      const items =
        response.interests?.map((item) => ({ id: item.id, name: item.name ?? '' })) ??
        response.brands?.map((item) => ({ id: item.id, name: item.name ?? '' })) ??
        response.locations?.map((item) => ({ id: item.id, name: item.name ?? '', title: item.title })) ??
        response.languages?.map((item) => ({ id: item.code, name: item.name ?? '' })) ??
        // topics and hashtags return bare strings under `tags`, with no ids and no total.
        response.tags?.map((tag) => ({ name: tag })) ??
        [];

      return respond({ kind, items: items.slice(0, limit) });
    }),
  );

  server.registerTool(
    'modash_lookup_ai_dictionary',
    {
      title: 'Look up AI Search filter values',
      description:
        'Searches the dictionaries used by modash_ai_search_creators and modash_find_lookalikes. ' +
        'Free: costs no credits. These values are not interchangeable with the ones from ' +
        'modash_lookup_dictionary — AI Search filters brands by name, not by numeric id. Kinds: ' +
        'brands, hashtags, mentions (mentions is not available for YouTube).',
      inputSchema: z.object({
        kind: z.enum(['brands', 'hashtags', 'mentions']),
        platform: platformSchema,
        query: z.string().optional().describe('For hashtags and mentions this matches a prefix'),
      }),
      outputSchema: z.object({
        items: z.array(
          z.object({
            name: z.string(),
            posts: z.number().optional().describe('Hashtags and mentions only: how popular it is'),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ kind, platform, query }) => {
      if (kind === 'brands') {
        const response = await getAiBrands(ctx.client, { query, platform });
        return respond({
          items: (response.result ?? []).map((brand) => ({ name: brand.name ?? '' })),
        });
      }

      const response = await getAiTags(ctx.client, { kind, platform, query });
      return respond({
        items: (response.result ?? []).map((tag) => ({ name: tag.value ?? '', posts: tag.count })),
      });
    }),
  );

  server.registerTool(
    'modash_find_creators_by_email',
    {
      title: 'Find creators by email address',
      description:
        'Reverse lookup: given email addresses, finds the Instagram, TikTok and YouTube accounts ' +
        'that list them as contact details. Costs 0.02 credits per matched email, and your ' +
        'balance must cover every address you submit. Use this to match a list you already have ' +
        'against Modash; use modash_search_creators to discover creators you do not know yet.',
      inputSchema: z.object({
        emails: z.array(z.email()).min(1).max(1000),
      }),
      outputSchema: withCost({
        totalMatches: z.number().optional(),
        matched: z.array(
          z.object({
            email: z.string().optional(),
            accounts: z.array(
              z.object({
                platform: z.string().optional(),
                userId: z.string().optional(),
                username: z.string().optional(),
                followers: z.number().optional(),
              }),
            ),
          }),
        ),
        unmatched: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ emails }) => {
      const { data, cost } = await priced(ctx.ledger, () => searchByEmail(ctx.client, { emails }));

      return respond({
        totalMatches: data.totalMatches,
        matched: (data.matchedEmails ?? []).map((match) => ({
          email: match.email,
          accounts: (match.users ?? []).map((user) => ({
            platform: user.platform,
            userId: user.userId,
            username: user.username,
            followers: user.followers,
          })),
        })),
        unmatched: data.notMatchedEmails ?? [],
        cost,
      });
    }),
  );
}
