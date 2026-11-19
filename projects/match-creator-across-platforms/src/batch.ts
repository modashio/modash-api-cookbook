import { handleFrom, isPlatform, PLATFORMS, type Platform } from './contacts.js';
import type { MatchResult } from './creator-match.js';
import type { Matcher } from './match.js';
import { type CreditBudgetExceededError, type ModashApiError, stopsTheRun } from './modash/errors.js';
import { creatorKey, openResults, type ResultsMode } from './results.js';

export type BatchKind = 'mock' | 'csv' | 'single';

export interface BatchOptions {
  rows: [string, string][];
  matcher: Matcher;
  resultsPath: string;
  kind: BatchKind;
  onResult?: (result: MatchResult) => void;
  onSkip?: (rowNumber: number, reason: string) => void;
}

export interface BatchOutcome {
  ran: number;
  stoppedAt?: { handle: string; error: CreditBudgetExceededError | ModashApiError };
}

export async function runBatch({ rows, matcher, resultsPath, kind, onResult, onSkip }: BatchOptions): Promise<BatchOutcome> {
  const results = openResults(resultsPath, resultsMode(kind, rows));
  const done = new Set(results.finished);

  let ran = 0;
  for (const [index, [rawPlatform, rawHandle]] of rows.entries()) {
    let platform: Platform;
    let handle: string;
    try {
      [platform, handle] = cleanInput(rawPlatform, rawHandle);
    } catch (error) {
      onSkip?.(index + 1, (error as Error).message);
      continue;
    }
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

function resultsMode(kind: BatchKind, rows: [string, string][]): ResultsMode {
  if (kind === 'mock') return { kind: 'fresh' };
  if (kind === 'csv') return { kind: 'resume', toRun: new Set(rows.flatMap(([p, h]) => creatorKeyOf(p, h) ?? [])) };
  return { kind: 'replace' };
}

function creatorKeyOf(platform: string | undefined, handle: string | undefined): string | undefined {
  try {
    return creatorKey(...cleanInput(platform, handle));
  } catch {
    return undefined;
  }
}

export function cleanInput(platform: string | undefined, handle: string | undefined): [Platform, string] {
  const p = (platform ?? '').trim().toLowerCase();
  if (!isPlatform(p)) throw new Error(`platform must be one of ${PLATFORMS.join(', ')}, got "${platform ?? ''}"`);
  const h = handleFrom(p, (handle ?? '').trim());
  if (!h) throw new Error(`could not read a ${p} handle from "${handle ?? ''}"`);
  return [p, h];
}
