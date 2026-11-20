import { handleFrom, isPlatform, PLATFORMS, type Platform } from './contacts.js';
import type { MatchResult } from './creator-match.js';
import type { Matcher } from './match.js';
import { type CreditBudgetExceededError, type ModashApiError, stopsTheRun } from './modash/errors.js';
import { creatorKey, openResults, type ResultsMode } from './results.js';

/** One creator to match. The handle is in lower case. */
export interface Creator {
  platform: Platform;
  handle: string;
}

export interface BatchOptions {
  creators: Creator[];
  matcher: Matcher;
  resultsPath: string;
  mode: ResultsMode;
  onResult?: (result: MatchResult) => void;
}

export interface BatchOutcome {
  ranCount: number;
  stoppedAt?: { handle: string; error: CreditBudgetExceededError | ModashApiError };
}

/** Matches the creators in list order. */
export async function runBatch({ creators, matcher, resultsPath, mode, onResult }: BatchOptions): Promise<BatchOutcome> {
  const results = openResults(resultsPath, mode);
  const done = new Set(results.finished);

  let ranCount = 0;
  for (const { platform, handle } of creators) {
    const key = creatorKey(platform, handle);
    if (done.has(key)) continue;
    done.add(key);

    let result: MatchResult;
    try {
      result = await matcher.match(platform, handle);
    } catch (error) {
      if (stopsTheRun(error)) return { ranCount, stoppedAt: { handle, error } };
      throw error;
    }
    results.record(result);
    onResult?.(result);
    ranCount += 1;
  }
  return { ranCount };
}

/** Reads a platform and a handle or profile link as the user typed them, or throws the reason it cannot. */
export function parseCreator(platform: string, handle: string): Creator {
  const p = platform.trim().toLowerCase();
  if (!isPlatform(p)) throw new Error(`${JSON.stringify(platform)} is not a platform. Use ${PLATFORMS.join(', ')}.`);
  const h = handleFrom(p, handle);
  if (!h) throw new Error(`${JSON.stringify(handle)} is not ${p === 'instagram' ? 'an' : 'a'} ${p} handle or profile link.`);
  return { platform: p, handle: h };
}
