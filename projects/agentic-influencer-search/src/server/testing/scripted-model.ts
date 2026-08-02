/**
 * A canned language model for tests: it calls `searchCreators` once, then writes
 * a short summary. Lets the whole pipeline be exercised with no provider key.
 */

import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';

const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

export const SCRIPTED_SUMMARY = 'Found some candidates.';

export function scriptedSearchModel(): MockLanguageModelV4 {
  let call = 0;

  return new MockLanguageModelV4({
    doStream: async () => {
      call++;

      if (call === 1) {
        return {
          stream: streamOf([
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'searchCreators',
              input: JSON.stringify({
                platform: 'instagram',
                query: 'creators sharing evening wind-down routines and sleep quality tips',
                filters: { followersCount: { min: 20_000, max: 200_000 } },
                pageSize: 5,
                rationale: 'Testing whether sleep-routine content surfaces wellness creators.',
              }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: USAGE },
          ]),
        };
      }

      return {
        stream: streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: SCRIPTED_SUMMARY },
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
        ]),
      };
    },
  });
}

function streamOf(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/** Calls one named tool with the given input, then stops. */
export function scriptedToolModel(toolName: string, input: unknown): MockLanguageModelV4 {
  let call = 0;

  return new MockLanguageModelV4({
    doStream: async () => {
      call++;

      if (call === 1) {
        return {
          stream: streamOf([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: USAGE },
          ]),
        };
      }

      return {
        stream: streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'Done.' },
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
        ]),
      };
    },
  });
}
