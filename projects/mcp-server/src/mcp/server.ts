import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

import { platformSchema } from '../server/modash/filters.js';
import { CREDITS, SEARCH_RESULTS_PER_PAGE } from '../server/modash/pricing.js';
import type { ToolContext } from './context.js';
import { registerAccountTools } from './tools/account.js';
import { registerCollaborationTools } from './tools/collaborations.js';
import { registerCrossoverTools } from './tools/crossover.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerRawTools } from './tools/raw.js';
import { registerReportTools } from './tools/reports.js';
import { registerSearchTools } from './tools/search.js';

export const SERVER_INFO = { name: 'modash', version: '1.0.1' } as const;

/**
 * Twelve tools over an API with forty-four endpoints, plus two that run one analysis end to end.
 *
 * The mapping is deliberately lossy. A tool list is not documentation — it is re-sent to the model
 * on every single turn, and selection accuracy falls off well before forty options. So the
 * seventeen dictionary endpoints became one tool with a `kind` parameter, the deprecated AI Search
 * aliases are not exposed at all, and each remaining tool is named for the job it does rather than
 * the route it calls.
 *
 * Every tool is built fresh per connection by the caller. The `ToolContext` it closes over is not:
 * the credit ledger has to be shared across connections or the budget would reset under the HTTP
 * transport, which constructs a server per request.
 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO);

  registerAccountTools(server, ctx);
  registerDiscoveryTools(server, ctx);
  registerSearchTools(server, ctx);
  registerReportTools(server, ctx);
  registerCollaborationTools(server, ctx);
  registerCrossoverTools(server, ctx);

  // The RAW API is sold separately from Discovery, so its tools stay out of the list unless the
  // reader says they have it. Six more tools help nobody whose plan answers every one of them
  // with `feature_not_available`, and they crowd out the twelve that do work.
  if (ctx.raw) registerRawTools(server, ctx);

  registerResources(server, ctx);
  registerPrompts(server);

  return server;
}

function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'pricing',
    'modash://pricing',
    {
      title: 'Modash credit costs',
      description: 'What each tool in this server costs, and which ones are free.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              free: [
                'modash_get_account',
                'modash_find_creator',
                'modash_lookup_dictionary',
                'modash_lookup_ai_dictionary',
                'modash_plan_brand_crossover',
              ],
              paid: {
                modash_search_creators: `${CREDITS.searchPerResult} per result, ${SEARCH_RESULTS_PER_PAGE} results per page (page size is fixed)`,
                modash_ai_search_creators: `${CREDITS.aiSearchPerProfile} per result, so pageSize sets the cost`,
                modash_find_lookalikes: `${CREDITS.aiSearchPerProfile} per result`,
                modash_get_creator_report: `${CREDITS.report} per call`,
                modash_compare_audience_overlap: `${CREDITS.audienceOverlap} per call, any number of creators`,
                modash_list_collaborations: `${CREDITS.collaborations} per call`,
                modash_summarise_collaborations: `${CREDITS.collaborations} per call`,
                modash_find_creators_by_email: `${CREDITS.emailSearchPerEmail} per matched email`,
                modash_brand_crossover: `${CREDITS.collaborations} per page of 30 posts per brand-week, plus ${CREDITS.aiSearchPerProfile} per creator returned by the optional location/follower lookup. Refuses up front if its worst case exceeds the remaining budget; modash_plan_brand_crossover prices it for free`,
              },
              rawApi: ctx.raw
                ? {
                    unit: 'requests, from a separate allowance to credits',
                    perCall: 1,
                    billedOnFailure: true,
                    note: 'Every page of a paginated list is another request.',
                  }
                : 'not enabled (set MODASH_RAW=true; the RAW API is sold separately)',
              notes: [
                'Failed Discovery requests are not billed, so retrying a 5xx or a 429 is free.',
                'Failed RAW requests ARE billed. A malformed URL costs a request.',
                'Reports are the expensive call. Search broadly, then report on the shortlist only.',
                'AI Search is limited to one request per second; this server serialises it for you.',
              ],
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    'budget',
    'modash://budget',
    {
      title: 'Session credit ledger',
      description: 'Credits spent so far this session, per call, and how much budget is left.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              mode: ctx.mock ? 'mock' : 'live',
              credits: ctx.ledger.summary(),
              rawRequests: ctx.raw ? ctx.rawLedger.summary() : 'RAW API tools are not enabled',
            },
            null,
            2,
          ),
        },
      ],
    }),
  );
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'shortlist-creators',
    {
      title: 'Shortlist creators for a campaign',
      description:
        'A cost-aware workflow for going from a campaign brief to a vetted shortlist, using the ' +
        'free tools first and spending credits only on the finalists.',
      argsSchema: z.object({
        brief: z.string().describe('Who you want to reach and what the campaign is'),
        platform: platformSchema,
        shortlistSize: z.string().optional().describe('How many creators to end up with, e.g. "5"'),
      }),
    },
    ({ brief, platform, shortlistSize }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Build a shortlist of ${shortlistSize ?? '5'} ${platform} creators for this brief:`,
              '',
              brief,
              '',
              'Work in this order, and say what each step cost before moving on:',
              '',
              '1. Read modash://pricing and call modash_get_account. Both are free. Note the budget.',
              '2. Resolve every location, interest or brand in the brief to an id with',
              '   modash_lookup_dictionary. This is free, and a filter containing a name rather',
              '   than an id is ignored silently while still being billed.',
              '3. Search once with modash_search_creators. If the brief is about what appears in',
              '   the content rather than about creator attributes, use modash_ai_search_creators',
              '   with the smallest pageSize that could work. Check isExactMatch: if it is false,',
              '   Modash dropped filters to find anything, so the results are approximate.',
              '4. Narrow to the shortlist from the search results alone. Do not pull reports yet.',
              '5. Only now, call modash_get_creator_report on each shortlisted creator, one credit',
              '   each. Judge them on audience credibility, audience geography against the brief,',
              '   and paidPostPerformance.',
              '6. If two creators look interchangeable, call modash_compare_audience_overlap once',
              '   for the whole shortlist rather than reports for more candidates.',
              '',
              'Finish with the shortlist, the reason for each choice, and the total credits spent.',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
