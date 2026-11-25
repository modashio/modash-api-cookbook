import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCsv } from '../src/csv.js';
import { emailList, sampleOf } from '../src/emails.js';
import { emailsWithin, estimate, projection } from '../src/estimate.js';

const cells = (...values: string[]) => values.map((value, i) => ({ line: i + 2, value }));

describe('reading the list', () => {
  it('trims, lower-cases and sends each email once', () => {
    const list = emailList(cells(' Amy@Example.com ', 'amy@example.com', 'bea@example.org'));
    assert.deepEqual(list.emails, ['amy@example.com', 'bea@example.org']);
    assert.equal(list.duplicateCount, 1);
  });

  it('counts blank cells and keeps values that are not an email out of the list, with their line', () => {
    const list = emailList(cells('amy@example.com', '', 'not an email', 'no-domain@', 'two@@example.com'));
    assert.deepEqual(list.emails, ['amy@example.com']);
    assert.equal(list.rowCount, 5);
    assert.equal(list.blankCount, 1);
    assert.deepEqual(
      list.notEmails.map((cell) => cell.line),
      [4, 5, 6],
    );
  });

  it('cleans what a spreadsheet leaves around an email', () => {
    const list = emailList(cells('mailto:Amy@Example.com', 'bea@example.org\u200B', '\uFEFFcy@example.net'));
    assert.deepEqual(list.emails, ['amy@example.com', 'bea@example.org', 'cy@example.net']);
  });

  it('does not send a value with a stray dot, quotes, a bad domain or two addresses', () => {
    const bad = ['amy@example.com.', '.amy@example.com', 'amy@example..com', 'amy@-example-.com', '"bea@example.org"', 'cy@example.net;di@example.net', 'Amy <amy@example.com>'];
    const list = emailList(cells(...bad));
    assert.deepEqual(list.emails, []);
    assert.equal(list.notEmails.length, bad.length);
  });

  it('keeps the valid forms a stricter check would lose', () => {
    const good = ["o'brien@example.com", 'amy+news@mail.example.co.uk', 'amy@example.xn--p1ai', 'zoë@example.com'];
    assert.deepEqual(emailList(cells(...good)).emails, good);
  });

  it('reads quoted fields, and reports the line a row starts on', () => {
    const records = parseCsv('id,email\n"1, a","amy@example.com"\n"two\nlines",bea@example.org\n');
    assert.deepEqual(records, [
      { line: 1, cells: ['id', 'email'] },
      { line: 2, cells: ['1, a', 'amy@example.com'] },
      { line: 3, cells: ['two\nlines', 'bea@example.org'] },
    ]);
    assert.throws(() => parseCsv('id,email\n1,"never closes'), /a quoted field never closes/);
  });
});

describe('sampling', () => {
  const emails = Array.from({ length: 1000 }, (_, i) => `user${i}@example.com`);

  it('spreads the sample across the whole list', () => {
    assert.deepEqual(sampleOf(emails, 4), ['user0@example.com', 'user250@example.com', 'user500@example.com', 'user750@example.com']);
  });

  it('gives the same sample every time, so a rerun resumes it', () => {
    assert.deepEqual(sampleOf(emails, 37), sampleOf(emails, 37));
    assert.equal(new Set(sampleOf(emails, 37)).size, 37);
  });

  it('is the whole list when the list is no larger than the sample', () => {
    assert.equal(sampleOf(emails, 5000), emails);
  });
});

describe('costs', () => {
  it('prices 100,000 emails: 100 calls, 2,000 credits at most, 20 credits of balance per call', () => {
    assert.deepEqual(estimate(100_000, 1000), { calls: 100, mostCredits: 2000, balancePerCall: 20 });
  });

  it('needs balance only for the emails in the call when the list is shorter than one call', () => {
    assert.deepEqual(estimate(5, 1000), { calls: 1, mostCredits: 0.1, balancePerCall: 0.1 });
  });

  it('projects the rest of the file from the sample', () => {
    assert.deepEqual(projection(4, 2000, 98_000), { matches: 196, credits: 3.92 });
  });

  it('counts the emails a budget can hold in one call without float error', () => {
    assert.equal(emailsWithin(0.58), 29);
    assert.equal(emailsWithin(5), 250);
    assert.equal(emailsWithin(0.01), 0);
    assert.equal(emailsWithin(0.019), 0);
    assert.equal(emailsWithin(0.039), 1);
  });
});
