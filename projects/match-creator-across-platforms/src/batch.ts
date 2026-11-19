import { handleFrom, isPlatform, PLATFORMS, type Platform } from './contacts.js';
import type { MatchResult } from './creator-match.js';
import type { Matcher } from './match.js';
import { type CreditBudgetExceededError, type ModashApiError, stopsTheRun } from './modash/errors.js';
import { creatorKey, openResults, type ResultsMode } from './results.js';

/** One row of the creator list, read once: a creator to match, or a row that could not be read and why. */
export type CreatorRow =
  | { kind: 'creator'; platform: Platform; handle: string }
  | { kind: 'skipped'; rowNumber: number; reason: string };

export interface BatchOptions {
  rows: CreatorRow[];
  matcher: Matcher;
  resultsPath: string;
  mode: ResultsMode;
  onResult?: (result: MatchResult) => void;
  onSkip?: (rowNumber: number, reason: string) => void;
}

export interface BatchOutcome {
  ran: number;
  stoppedAt?: { handle: string; error: CreditBudgetExceededError | ModashApiError };
}

/** Matches the creators in list order. A skipped row is reported where the run reaches it, between the results. */
export async function runBatch({ rows, matcher, resultsPath, mode, onResult, onSkip }: BatchOptions): Promise<BatchOutcome> {
  const results = openResults(resultsPath, mode);
  const done = new Set(results.finished);

  let ran = 0;
  for (const row of rows) {
    if (row.kind === 'skipped') {
      onSkip?.(row.rowNumber, row.reason);
      continue;
    }
    const { platform, handle } = row;
    const key = creatorKey(platform, handle);
    if (done.has(key)) continue;
    done.add(key);

    let result: MatchResult;
    try {
      result = await matcher.match(platform, handle);
    } catch (error) {
      if (stopsTheRun(error)) return { ran, stoppedAt: { handle, error } };
      throw error;
    }
    results.record(result);
    onResult?.(result);
    ran += 1;
  }
  return { ran };
}

/** Reads each raw platform and handle pair once. Row numbers count from 1. */
export function parseRows(rows: [string, string][]): CreatorRow[] {
  return rows.map(([platform, handle], index): CreatorRow => {
    try {
      const [p, h] = cleanInput(platform, handle);
      return { kind: 'creator', platform: p, handle: h };
    } catch (error) {
      return { kind: 'skipped', rowNumber: index + 1, reason: (error as Error).message };
    }
  });
}

function cleanInput(platform: string | undefined, handle: string | undefined): [Platform, string] {
  const p = (platform ?? '').trim().toLowerCase();
  if (!isPlatform(p)) throw new Error(`platform must be one of ${PLATFORMS.join(', ')}, got "${platform ?? ''}"`);
  const h = handleFrom(p, (handle ?? '').trim());
  if (!h) throw new Error(`could not read a ${p} handle from "${handle ?? ''}"`);
  return [p, h];
}
