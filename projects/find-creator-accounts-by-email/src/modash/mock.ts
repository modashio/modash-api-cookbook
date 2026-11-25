import { readFileSync } from 'node:fs';

import { omit, partition } from 'lodash-es';
import * as z from 'zod';

import type { Transport } from './client.js';
import { MockDataMissingError } from './errors.js';

const FIXTURES = new URL('../../fixtures/demo-accounts.json', import.meta.url);

/** The invented accounts, keyed by the email they list. */
const fixturesSchema = z.record(z.string(), z.array(z.unknown()));
export type Fixtures = z.infer<typeof fixturesSchema>;

const emailSearchBodySchema = z.object({ emails: z.array(z.string()) });

/** Answers email search from the invented accounts, in the shape the API returns. Any other email is not matched. */
export function mockTransport(fixtures: Fixtures): Transport {
  return async ({ path, body }) => {
    if (path !== 'email-search') {
      throw new MockDataMissingError(path);
    }
    const { emails } = emailSearchBodySchema.parse(body);
    const [matched, notMatched] = partition(emails, (email) => Object.hasOwn(fixtures, email));
    return {
      status: 200,
      body: {
        error: false,
        matchedEmails: matched.map((email) => ({ email, users: fixtures[email] })),
        notMatchedEmails: notMatched,
        totalMatches: matched.length,
      },
    };
  };
}

export function loadFixtures(): Fixtures {
  return fixturesSchema.parse(omit(JSON.parse(readFileSync(FIXTURES, 'utf8')), '_note'));
}
