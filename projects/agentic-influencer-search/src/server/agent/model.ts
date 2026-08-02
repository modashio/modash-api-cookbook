/**
 * Model selection.
 *
 * The AI SDK abstracts providers away, so this project works with whatever key
 * you have. It picks the first provider it finds a key for; `AGENT_MODEL`
 * overrides the model id.
 */

import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export interface ModelChoice {
  model: LanguageModel;
  provider: 'openai' | 'anthropic';
  modelId: string;
}

const DEFAULTS = {
  openai: 'gpt-4.1',
  anthropic: 'claude-sonnet-4-5',
} as const;

export function resolveModel(env: NodeJS.ProcessEnv = process.env): ModelChoice {
  const override = env.AGENT_MODEL?.trim();

  if (env.OPENAI_API_KEY) {
    const modelId = override ?? DEFAULTS.openai;
    return { model: openai(modelId), provider: 'openai', modelId };
  }

  if (env.ANTHROPIC_API_KEY) {
    const modelId = override ?? DEFAULTS.anthropic;
    return { model: anthropic(modelId), provider: 'anthropic', modelId };
  }

  throw new Error(
    'No model provider key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env — see .env.example.',
  );
}
