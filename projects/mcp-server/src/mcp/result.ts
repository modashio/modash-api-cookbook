import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';

import type { CreditLedger } from '../server/modash/budget.js';
import { CreditBudgetExceededError, ModashApiError } from '../server/modash/errors.js';

/**
 * Every tool result carries what the call cost and what is left in the session budget.
 *
 * This is the cheapest possible form of cost control: the model that decided to spend the credits
 * finds out immediately, in the same message, so a plan that involves twenty reports gets a chance
 * to become a plan that involves three. It also means a human reading the transcript can see the
 * running total without instrumenting anything.
 */
export const costSchema = z.object({
  creditsThisCall: z.number(),
  creditsSpentThisSession: z.number(),
  creditsRemainingInBudget: z.number(),
});

export type Cost = z.infer<typeof costSchema>;

/** Adds the cost envelope to a tool's own output shape. */
export const withCost = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ ...shape, cost: costSchema });

/** Runs a paid call and reports what it actually cost, read from the ledger rather than guessed. */
export async function priced<T>(
  ledger: CreditLedger,
  run: () => Promise<T>,
): Promise<{ data: T; cost: Cost }> {
  const before = ledger.spent;
  const data = await run();
  return {
    data,
    cost: {
      creditsThisCall: Math.round((ledger.spent - before) * 1e6) / 1e6,
      creditsSpentThisSession: ledger.spent,
      creditsRemainingInBudget: ledger.remaining,
    },
  };
}

/**
 * Structured output is what the caller should read; the text block is the same payload serialised,
 * because clients that predate structured content only render text.
 *
 * The SDK validates `structuredContent` against the tool's `outputSchema` before the result leaves
 * the process, so a tool that drifts from its declared output fails here rather than silently
 * handing a model the wrong shape.
 */
export const respond = (payload: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload,
});

/** A failure the model should read and react to, as opposed to a protocol-level error. */
export const problem = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/**
 * Turns a failure into a result the model can act on rather than a protocol error it cannot see.
 *
 * The Modash error `code` is included verbatim because it is stable, while the message is not —
 * a model that reads `not_enough_credits` can stop, where one that reads a sentence has to guess.
 */
export function failure(error: unknown): CallToolResult {
  if (error instanceof ModashApiError) return problem(error.toToolMessage());
  if (error instanceof CreditBudgetExceededError) return problem(`Budget stop: ${error.message}`);
  return problem(error instanceof Error ? error.message : String(error));
}

/** Wraps a tool handler so every thrown failure comes back as a readable, actionable result. */
export const guard =
  <Args>(run: (args: Args) => Promise<CallToolResult>) =>
  async (args: Args): Promise<CallToolResult> => {
    try {
      return await run(args);
    } catch (error) {
      return failure(error);
    }
  };
