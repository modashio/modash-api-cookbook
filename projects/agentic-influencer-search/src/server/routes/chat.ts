/**
 * POST /api/chat — the only endpoint the browser needs.
 *
 * Takes the `useChat` message history, runs the agent, and pipes the UI message
 * stream straight to the Express response. The Modash token never leaves this
 * process.
 */

import { pipeUIMessageStreamToResponse, validateUIMessages, type LanguageModel } from 'ai';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage } from '../../shared/messages';
import { runAgent } from '../agent/agent';
import { config } from '../env';
import type { ModashApi } from '../modash/api';

const requestSchema = z.object({
  messages: z.array(z.unknown()),
  // The user's current thumbs up / thumbs down, resent with every turn rather
  // than accumulated in the transcript. See src/shared/feedback.ts.
  verdicts: z
    .array(
      z.object({
        platform: z.enum(['instagram', 'tiktok', 'youtube']),
        username: z.string(),
        verdict: z.enum(['like', 'dislike']),
      }),
    )
    .optional(),
});

export interface ChatRouteOptions {
  /** Overrides provider auto-detection. Used by the tests to run without any API keys. */
  model?: LanguageModel;
}

export function registerChatRoute(app: Express, api: ModashApi, options: ChatRouteOptions = {}): void {
  app.post('/api/chat', async (req: Request, res: Response) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Expected a body of the shape { messages: UIMessage[] }.' });
      return;
    }

    let messages: ChatMessage[];
    try {
      messages = (await validateUIMessages({ messages: parsed.data.messages })) as ChatMessage[];
    } catch {
      res.status(400).json({ error: 'Message history could not be parsed.' });
      return;
    }

    // Stop paying for model tokens and API calls the moment the user navigates away.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    try {
      const stream = runAgent({
        messages,
        api,
        creditBudget: config.creditBudget,
        maxPageSize: config.maxPageSize,
        abortSignal: abort.signal,
        verdicts: parsed.data.verdicts ?? [],
        ...(options.model ? { model: options.model } : {}),
      });

      await pipeUIMessageStreamToResponse({ stream, response: res });
    } catch (error) {
      console.error('[chat] failed to start stream', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Failed to start the agent.',
        });
      }
    }
  });
}
