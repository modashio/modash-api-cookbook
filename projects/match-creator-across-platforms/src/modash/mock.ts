import { readFileSync } from 'node:fs';

import type { ModashRequest, Transport } from './client.js';
import { MockDataMissingError } from './errors.js';

const FIXTURES = new URL('../../fixtures/demo-responses.json', import.meta.url);

export const MOCK_HANDLES = ['example_baker', 'example_techreviews'] as const;

export function fixtureKey({ method, path, query, body }: ModashRequest): string {
  let key = `${method} ${path}`;
  if (query?.query) key += `?query=${query.query}`;
  if (body !== undefined) key += ` ${JSON.stringify(body)}`;
  return key;
}

export type Fixtures = Record<string, unknown>;

/** Every request in mock mode must have a saved answer. A missing one is a bug in the fixtures, so the run stops. */
export function mockTransport(fixtures: Fixtures): Transport {
  return async (request) => {
    const key = fixtureKey(request);
    if (!(key in fixtures)) throw new MockDataMissingError(key);
    return { status: 200, body: fixtures[key] };
  };
}

export function loadFixtures(): Fixtures {
  return JSON.parse(readFileSync(FIXTURES, 'utf8')) as Fixtures;
}
