import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

import { getUserInfo } from '../../server/modash/endpoints.js';
import type { ToolContext } from '../context.js';
import { guard, respond } from '../result.js';

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'modash_get_account',
    {
      title: 'Modash account and budget',
      description:
        'Returns the Modash account credit balance, the account rate limits, and this session\'s ' +
        'credit budget with a line-by-line record of what has been spent so far. Free: costs no ' +
        'credits. Call this first to confirm the token works and to see how much room is left ' +
        'before starting anything that pages through paid results.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        mode: z.enum(['live', 'mock']),
        account: z.object({
          credits: z.number().optional(),
          discoveryRequestsPerSecond: z.number().optional(),
        }),
        session: z.object({
          budget: z.number(),
          spent: z.number(),
          remaining: z.number(),
          paidCalls: z.number(),
          freeCalls: z.number(),
        }),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async () => {
      const info = await getUserInfo(ctx.client);
      const summary = ctx.ledger.summary();

      return respond({
        mode: ctx.mock ? 'mock' : 'live',
        account: {
          // Credits are fractional floats, not integers, and can be absent on some plans.
          credits: info.billing?.credits,
          discoveryRequestsPerSecond: info.rateLimits?.discoveryRatelimit,
        },
        session: {
          budget: summary.budget,
          spent: summary.spent,
          remaining: summary.remaining,
          paidCalls: summary.paidCalls,
          freeCalls: summary.freeCalls,
        },
      });
    }),
  );
}
