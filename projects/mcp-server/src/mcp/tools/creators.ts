import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

import type { CreatorRow } from '../../creators/dataset.js';
import {
  hasAnyFilter,
  lookupCreators,
  MAX_ROWS,
  NOTE,
  PLATFORMS,
  searchCreators,
  SORT_COLUMNS,
} from '../../creators/query.js';
import type { ToolContext } from '../context.js';
import { guard, problem, respond } from '../result.js';

const outputSchema = z.object({
  dataset: z.enum(['bundled synthetic sample', 'custom']),
  returned: z.number(),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  moreMatchesExist: z.boolean().optional(),
  note: z.string(),
});

const ONE_CREATOR_GUIDANCE =
  'Answer questions about ONE creator at a time. If the user names a creator, call ' +
  'creator_lookup instead of creator_search. Never call this repeatedly to list or collect many ' +
  'creators, and do not attempt to export, page through or reconstruct the dataset. Free: costs ' +
  'no credits.';

const filtersSchema = z.object({
  country: z
    .string()
    .min(1)
    .optional()
    .describe('Creator country: full name ("United States") or ISO code ("US"), case-insensitive'),
  audience_country: z
    .string()
    .min(1)
    .optional()
    .describe('Top audience country: full name or ISO code, case-insensitive'),
  platform: z
    .enum(PLATFORMS)
    .optional()
    .describe('Only creators that have an account on this platform'),
  min_followers: z
    .number()
    .nonnegative()
    .optional()
    .describe('Minimum followers on the creator\'s largest account (max_followers)'),
  has_email: z
    .boolean()
    .optional()
    .describe('Whether Modash holds an email for the creator (the address is not in the dataset)'),
  min_platforms: z
    .number()
    .int()
    .min(1)
    .max(3)
    .optional()
    .describe('Minimum number of platforms the creator is on, 1 to 3'),
  sort_by: z
    .enum(SORT_COLUMNS)
    .default('max_followers')
    .describe('Descending sort column. Defaults to max_followers'),
  limit: z
    .number()
    .int()
    .min(1)
    .default(MAX_ROWS)
    .describe(`Rows to return. Defaults to ${MAX_ROWS}, which is also the hard maximum`),
});

export function registerCreatorTools(server: McpServer, ctx: ToolContext): void {
  const dataset = ctx.creators;
  const source = dataset.isCustom ? ('custom' as const) : ('bundled synthetic sample' as const);

  const reply = (rows: CreatorRow[], moreMatchesExist?: boolean) =>
    respond({
      dataset: source,
      returned: rows.length,
      rows,
      ...(moreMatchesExist === undefined ? {} : { moreMatchesExist }),
      note: NOTE,
    });

  server.registerTool(
    'creator_lookup',
    {
      title: 'Look up one creator in the local dataset',
      description:
        'Finds a creator in the local CSV dataset of creators with 10M+ followers by handle or ' +
        'name. Matches an exact Instagram, TikTok or YouTube handle first, then names that ' +
        'contain the query, case-insensitively, and returns at most 5 rows with every column. ' +
        'Prefer this tool whenever the user names a creator. ' +
        ONE_CREATOR_GUIDANCE,
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(2)
          .describe('A handle (with or without @) or part of the creator name'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(async ({ query }: { query: string }) => {
      const rows = await dataset.load();
      return reply(lookupCreators(rows, query));
    }),
  );

  server.registerTool(
    'creator_search',
    {
      title: 'Search the local creator dataset with filters',
      description:
        'Filters the local CSV dataset of creators with 10M+ followers by creator country, ' +
        'audience country, platform, follower count, email availability and platform count, ' +
        `then returns at most ${MAX_ROWS} rows with every column, sorted descending. At least ` +
        'one filter is required: a call with none is rejected. There is no export, offset or ' +
        'paging. ' +
        ONE_CREATOR_GUIDANCE,
      inputSchema: z.object({ filters: filtersSchema.prefault({}) }),
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(async ({ filters }: { filters: z.infer<typeof filtersSchema> }) => {
      if (!hasAnyFilter(filters)) {
        return problem(
          'creator_search needs at least one of: country, audience_country, platform, ' +
            'min_followers, has_email, min_platforms. To answer about a named creator, use ' +
            'creator_lookup.',
        );
      }

      const rows = await dataset.load();
      const result = searchCreators(rows, filters);
      return reply(result.rows, result.moreMatchesExist);
    }),
  );
}
