import { readFileSync } from 'node:fs';

import type { ModashRequest, Transport } from './client.js';

const FIXTURES = new URL('../../fixtures/demo-responses.json', import.meta.url);

export const MOCK_HANDLES = ['example_baker', 'example_techreviews'] as const;

export function fixtureKey({ method, path, query, body }: ModashRequest): string {
  let key = `${method} ${path}`;
  if (query?.query) key += `?query=${query.query.toLowerCase()}`;
  if (body !== undefined) key += ` ${JSON.stringify(body)}`;
  return key;
}

export function mockTransport(fixtures: Record<string, unknown> = loadFixtures()): Transport {
  return async (request) => {
    const body = fixtures[fixtureKey(request)];
    if (body === undefined) {
      return {
        status: 404,
        body: {
          error: true,
          code: 'account_not_found',
          message: `not in the mock data, which has ${MOCK_HANDLES.join(' and ')}`,
        },
      };
    }
    return { status: 200, body };
  };
}

function loadFixtures(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURES, 'utf8')) as Record<string, unknown>;
}
