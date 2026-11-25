import type * as z from 'zod';

import type { ModashClient } from './client.js';
import { emailSearchResponseSchema } from './responses.js';

export type MatchedEmail = z.infer<typeof emailSearchResponseSchema>['matchedEmails'][number];

export interface ModashReads {
  searchEmails(emails: string[]): Promise<MatchedEmail[]>;
}

export const EMAIL_MATCH_COST = 0.02;
export const MAX_EMAILS_PER_CALL = 1000;

/** 0.02 credits per matched email; the balance must cover 0.02 per email sent. At most 1,000 emails a call. */
const searchEmails = (client: ModashClient, emails: string[]) =>
  client.call({ path: 'email-search', body: { emails } }, emailSearchResponseSchema, {
    max: EMAIL_MATCH_COST * emails.length,
    // The higher of the two counts, so the run never reports less than it may have been charged.
    actual: (data) => EMAIL_MATCH_COST * Math.max(data.totalMatches ?? 0, data.matchedEmails.length),
  });

export function modashReads(client: ModashClient): ModashReads {
  return {
    async searchEmails(emails) {
      const data = await searchEmails(client, emails);
      return data.matchedEmails;
    },
  };
}
