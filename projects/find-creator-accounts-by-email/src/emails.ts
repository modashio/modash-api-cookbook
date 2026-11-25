import { partition, times, uniq } from 'lodash-es';

import type { Cell } from './csv.js';

export interface EmailList {
  /** The emails to check: trimmed, lower case, each one once, in file order. */
  emails: string[];
  rowCount: number;
  blankCount: number;
  duplicateCount: number;
  /** Cells that hold something other than an email address. They are never sent. */
  notEmails: Cell[];
}

// Words joined by single dots, an @, then a domain of two or more labels. A label starts and ends with a letter or digit.
const WORD = "[\\p{L}\\p{N}!#$%&'*+/=?^_`{|}~-]+";
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?';
const EMAIL = new RegExp(`^${WORD}(?:\\.${WORD})*@${LABEL}(?:\\.${LABEL})+$`, 'u');
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/** A cell as it is sent: no spaces around it, no zero-width characters, no `mailto:`, lower case. */
const clean = (value: string) => value.replace(ZERO_WIDTH, '').trim().toLowerCase().replace(/^mailto:/, '');

export function emailList(cells: Cell[]): EmailList {
  const cleaned = cells.map(({ line, value }) => ({ line, value: clean(value) }));
  const [blank, filled] = partition(cleaned, (cell) => cell.value === '');
  const [valid, notEmails] = partition(filled, (cell) => EMAIL.test(cell.value));
  const emails = uniq(valid.map((cell) => cell.value));
  return {
    emails,
    rowCount: cells.length,
    blankCount: blank.length,
    duplicateCount: valid.length - emails.length,
    notEmails,
  };
}

/** `size` emails spread evenly across the list, so a sample is not just the first rows of the file. */
export function sampleOf(emails: string[], size: number): string[] {
  if (size >= emails.length) return emails;
  const step = emails.length / size;
  return times(size, (i) => emails[Math.floor(i * step)]!);
}
