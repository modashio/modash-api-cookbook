import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { partition, uniqBy } from 'lodash-es';

import { type EmailResult, isMatch } from './lookup.js';

export interface ResultsFile {
  /** The emails with a result in the file; a run does not send them again. */
  checked: ReadonlySet<string>;
  /** The checked emails the API matched. */
  matched: ReadonlySet<string>;
  record(results: EmailResult[]): void;
}

/** `fresh` starts the file over (mock mode); `resume` keeps what is there and appends. */
export function openResults(path: string, mode: 'fresh' | 'resume'): ResultsFile {
  if (mode === 'fresh' && existsSync(path)) {
    unlinkSync(path);
  }
  const kept = existsSync(path) ? oneLinePerEmail(path) : [];
  const checked = new Set(kept.map((result) => result.email));
  const matched = new Set(kept.filter(isMatch).map((result) => result.email));
  return {
    checked,
    matched,
    record(results) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, results.map((result) => `${JSON.stringify(result)}\n`).join(''));
      for (const result of results) {
        checked.add(result.email);
        if (isMatch(result)) {
          matched.add(result.email);
        }
      }
    },
  };
}

/**
 * Rewrites the file to whole lines, one per email, and returns the results in it. A line it cannot read stays,
 * so nothing the user wrote is lost, and it ends in a line break, so the next result does not run into it.
 */
function oneLinePerEmail(path: string): EmailResult[] {
  const text = readFileSync(path, 'utf8');
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => ({ line, result: resultIn(line) }));
  const [readable, unreadable] = partition(lines, (l) => l.result !== undefined);
  const kept = uniqBy(readable, (l) => l.result?.email);
  const rewritten = [...unreadable, ...kept].map((l) => `${l.line}\n`).join('');
  if (rewritten !== text) {
    writeAtomic(path, rewritten);
  }
  return kept.flatMap((l) => l.result ?? []);
}

/** The result on one line, or undefined when it is not one: a line cut off by a crash, or one a person edited. */
function resultIn(line: string): EmailResult | undefined {
  try {
    const { email, accounts, review } = JSON.parse(line) as Partial<EmailResult>;
    return typeof email === 'string' && Array.isArray(accounts) ? { email, accounts, review: review ?? null } : undefined;
  } catch {
    return undefined;
  }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
