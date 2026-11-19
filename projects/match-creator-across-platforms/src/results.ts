import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { sortBy, uniqBy } from 'lodash-es';

import type { Platform } from './contacts.js';
import type { MatchResult } from './creator-match.js';

export const creatorKey = (platform: Platform, handle: string) => `${platform}:${handle.toLowerCase()}`;

/**
 * How a run writes its results file:
 * - `fresh` starts the file over (mock mode);
 * - `resume` keeps one line per creator, drops the failed lines of the creators in `toRun`, and appends (a CSV);
 * - `replace` swaps the line of the one creator it runs (a single handle).
 */
export type ResultsMode = { kind: 'fresh' } | { kind: 'resume'; toRun: Set<string> } | { kind: 'replace' };

export interface ResultsFile {
  /** The creators with a finished result already in the file; a run skips them. */
  finished: Set<string>;
  record(result: MatchResult): void;
}

/** A result with an error in it is not finished: a rerun asks again. */
const isFinished = (result: MatchResult) => result.errors.length === 0;

export function openResults(path: string, mode: ResultsMode): ResultsFile {
  if (mode.kind === 'fresh' && existsSync(path)) unlinkSync(path);
  const finished = mode.kind === 'resume' && existsSync(path) ? compact(path, mode.toRun) : new Set<string>();
  return {
    finished,
    record(result) {
      const line = JSON.stringify(result);
      if (mode.kind !== 'replace') {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${line}\n`);
        return;
      }
      const key = creatorKey(result.input.platform, result.input.handle);
      const others = existsSync(path) ? readLines(path).filter((r) => r.key !== key) : [];
      writeLines(path, [...others.map((r) => r.line), line]);
    },
  };
}

/** Rewrites the file to one line per creator, the first finished one when there is one, and returns the finished creators. */
function compact(path: string, toRun: Set<string>): Set<string> {
  const rows = readLines(path).filter((r) => r.finished || !toRun.has(r.key));
  const kept = uniqBy(
    sortBy(rows, (r) => !r.finished),
    'key',
  );
  writeLines(
    path,
    kept.map((r) => r.line),
  );
  return new Set(kept.filter((r) => r.finished).map((r) => r.key));
}

function readLines(path: string): { key: string; line: string; finished: boolean }[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const result = JSON.parse(line) as MatchResult;
        return [{ key: creatorKey(result.input.platform, result.input.handle), line, finished: isFinished(result) }];
      } catch {
        return []; // a line cut off by a crash
      }
    });
}

export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function writeLines(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, lines.map((l) => `${l}\n`).join(''));
}
