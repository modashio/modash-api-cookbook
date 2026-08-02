import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { parse } from 'dotenv';

import { loadConfig } from '../src/config.js';

/**
 * Mock mode has to be the default with no environment at all, or `npm install && npm run dev`
 * fails for a reader who does not have a token yet — which is most readers.
 */
describe('configuration', () => {
  it('runs in mock mode when nothing is set', () => {
    const config = loadConfig({});
    assert.equal(config.mock, true);
    assert.equal(config.creditBudget, 5);
  });

  it('goes live as soon as a token is present', () => {
    assert.equal(loadConfig({ MODASH_API_TOKEN: 'placeholder' }).mock, false);
  });

  it('lets MODASH_MOCK override a token that is present', () => {
    assert.equal(loadConfig({ MODASH_API_TOKEN: 'placeholder', MODASH_MOCK: 'true' }).mock, true);
  });

  it('refuses to pretend it is live without a token', () => {
    assert.throws(() => loadConfig({ MODASH_MOCK: 'false' }), /marketer\.modash\.io\/developer/);
  });

  it('rejects a budget that is not a positive number', () => {
    assert.throws(() => loadConfig({ MODASH_CREDIT_BUDGET: 'lots' }), /MODASH_CREDIT_BUDGET/);
  });

  it('binds loopback unless told otherwise', () => {
    assert.equal(loadConfig({}).httpHost, '127.0.0.1');
    assert.equal(loadConfig({ MODASH_HTTP_HOST: '0.0.0.0' }).httpHost, '0.0.0.0');
  });

  /**
   * Both plugin packagings can hand this process a variable that is set but says nothing. Reading
   * either as a token would mean sending `Authorization: Bearer ` and getting a 401 instead of
   * quietly running on fixtures, which is what the user asked for by not supplying a token.
   */
  it('treats an empty token as no token, not as a token', () => {
    assert.equal(loadConfig({ MODASH_API_TOKEN: '' }).mock, true);
    assert.equal(loadConfig({ MODASH_API_TOKEN: '   ' }).mock, true);
  });

  it('treats an unexpanded ${VAR} placeholder as no token', () => {
    const config = loadConfig({ MODASH_API_TOKEN: '${MODASH_API_TOKEN}' });
    assert.equal(config.mock, true);
    assert.equal(config.apiToken, undefined);
  });

  it('falls back to the default when a numeric variable arrives empty', () => {
    assert.equal(loadConfig({ MODASH_CREDIT_BUDGET: '' }).creditBudget, 5);
  });

  /**
   * `cp .env.example .env` is the first thing the README tells you to do, and the reader who does
   * it before pasting a token should land on fixtures rather than on a wall of 401s from a
   * placeholder token. That only holds while the token line stays commented out.
   */
  it('leaves you in mock mode after a straight copy of .env.example', () => {
    const example = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.example');
    const config = loadConfig(parse(readFileSync(example)));

    assert.equal(config.mock, true);
    assert.equal(config.apiToken, undefined);
    assert.equal(config.creditBudget, 5);
  });
});
