/**
 * The agent loop.
 *
 * `streamText` + `stopWhen` is the whole thing: the model picks tools, the SDK
 * runs them, feeds results back, and repeats until it produces a final answer or
 * hits the step cap. What makes it feel agentic to the user is that every step is
 * streamed — tool calls, result cards, credit spend — instead of appearing at the
 * end as a wall of text.
 *
 * Docs: https://ai-sdk.dev/docs/agents/loop-control
 */

import {
  convertToModelMessages,
  createUIMessageStream,
  isStepCount,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type UIMessageChunk,
} from 'ai';
import type { AudienceReport, Creator } from '../../shared/creators';
import { creatorKey, type CreatorVerdict } from '../../shared/feedback';
import type { ChatMessage, ShortlistEntry } from '../../shared/messages';
import type { ModashApi } from '../modash/api';
import { CreditLedger } from '../modash/credits';
import { resolveModel } from './model';
import { buildInstructions } from './prompt';
import { createAgentTools } from './tools';

/** Enough room to resolve dictionaries, search 2–3 times, shortlist, and summarise. */
const MAX_STEPS = 14;

export interface RunAgentOptions {
  messages: ChatMessage[];
  api: ModashApi;
  creditBudget: number;
  maxPageSize: number;
  abortSignal?: AbortSignal;
  /** The user's thumbs up / thumbs down on individual creators. */
  verdicts?: CreatorVerdict[];
  /** Injectable so tests can drive the loop with a mock model and no provider key. */
  model?: LanguageModel;
}

export function runAgent({
  messages,
  api,
  creditBudget,
  maxPageSize,
  abortSignal,
  verdicts = [],
  model: modelOverride,
}: RunAgentOptions): ReadableStream<UIMessageChunk> {
  const { model, provider, modelId } = modelOverride
    ? { model: modelOverride, provider: 'override' as const, modelId: 'override' }
    : resolveModel();

  return createUIMessageStream<ChatMessage>({
    originalMessages: messages,
    execute: async ({ writer }) => {
      const ledger = new CreditLedger(creditBudget);
      const seen = new Map<string, Creator>();
      const shortlist = new Map<string, ShortlistEntry>();
      const reports = new Map<string, AudienceReport>();
      const disliked = new Set(
        verdicts
          .filter((entry) => entry.verdict === 'dislike')
          .map((entry) => creatorKey(entry.platform, entry.username)),
      );

      // Rehydrate what earlier turns found, so the user can say "shortlist the
      // first three" without the agent paying to search again.
      for (const message of messages) {
        for (const part of message.parts) {
          if (part.type === 'data-search' && part.data.creators) {
            for (const creator of part.data.creators) {
              seen.set(creatorKey(creator.platform, creator.username), creator);
            }
          }
          if (part.type === 'data-shortlist') {
            // Every write is a full snapshot, so the latest one wins outright.
            // Unioning them would resurrect anything `removeFromShortlist` cut.
            shortlist.clear();
            for (const entry of part.data.entries) {
              shortlist.set(creatorKey(entry.creator.platform, entry.creator.username), entry);
              // `seen` still accumulates: a creator can be cut from the shortlist
              // and later added back without paying to search for them again.
              seen.set(creatorKey(entry.creator.platform, entry.creator.username), entry.creator);
            }
          }
          // Reports cost a full credit each, so never buy one twice in a conversation.
          if (part.type === 'data-reports' && part.data.reports) {
            for (const report of part.data.reports) {
              reports.set(creatorKey(report.platform, report.username), report);
            }
          }
        }
      }

      writer.write({
        type: 'data-usage',
        id: 'usage',
        data: { creditsSpent: 0, creditsBudget: creditBudget, paidCalls: 0, mock: api.isMock },
      });

      const result = streamText({
        model,
        instructions: buildInstructions({ creditBudget, maxPageSize, mock: api.isMock, verdicts }),
        messages: await convertToModelMessages(messages),
        tools: createAgentTools({ api, ledger, writer, maxPageSize, seen, shortlist, reports, disliked }),
        stopWhen: isStepCount(MAX_STEPS),
        ...(abortSignal ? { abortSignal } : {}),
        onError: ({ error }) => {
          console.error('[agent] stream error', error);
          writer.write({
            type: 'data-notice',
            data: {
              level: 'error',
              message: `The ${provider} model (${modelId}) returned an error. Check the server logs.`,
            },
            transient: true,
          });
        },
      });

      writer.merge(toUIMessageStream({ stream: result.stream }));
    },
    onError: (error) => {
      console.error('[agent] fatal', error);
      return error instanceof Error ? error.message : 'Unexpected server error.';
    },
  });
}
