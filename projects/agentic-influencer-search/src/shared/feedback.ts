/**
 * Per-creator thumbs up / thumbs down.
 *
 * Verdicts are not stored in the message history like everything else the agent
 * produces, because they are the *user's* running opinion rather than a record of
 * something that happened. Keeping them as a single current set means clicking
 * like four times doesn't leave four contradictory entries in the transcript for
 * the model to reconcile. They ride along with each request instead, and land in
 * the instructions.
 */

import type { Platform } from './creators';

export type Verdict = 'like' | 'dislike';

/** Keyed by platform and handle, since the same handle can exist on two networks. */
export type VerdictMap = Record<string, Verdict>;

export interface CreatorVerdict {
  platform: Platform;
  username: string;
  verdict: Verdict;
}

export function creatorKey(platform: Platform, username: string): string {
  return `${platform}:${username.replace(/^@/, '').toLowerCase()}`;
}

export function toVerdictList(map: VerdictMap): CreatorVerdict[] {
  return Object.entries(map).flatMap(([key, verdict]) => {
    const [platform, username] = key.split(':');
    if (!platform || !username) return [];
    return [{ platform: platform as Platform, username, verdict }];
  });
}

export function countVerdicts(map: VerdictMap): { liked: number; disliked: number } {
  const values = Object.values(map);
  return {
    liked: values.filter((verdict) => verdict === 'like').length,
    disliked: values.filter((verdict) => verdict === 'dislike').length,
  };
}
