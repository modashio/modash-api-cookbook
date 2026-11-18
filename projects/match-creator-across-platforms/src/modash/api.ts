import type { Platform } from '../contacts.js';
import type { ModashClient } from './client.js';
import { emailSearchResponseSchema, reportResponseSchema, usersResponseSchema } from './responses.js';

export const REPORT_COST = 1;
export const EMAIL_MATCH_COST = 0.02;

/** Free. Searches the list of influencers for the query string. */
export const lookupUsers = (client: ModashClient, platform: Platform, query: string) =>
  client.call({ method: 'GET', path: `${platform}/users`, query: { query, limit: '10' } }, usersResponseSchema);

/** 1 credit. */
export const getReport = (client: ModashClient, platform: Platform, userId: string) =>
  client.call(
    { method: 'GET', path: `${platform}/profile/${encodeURIComponent(userId)}/report` },
    reportResponseSchema,
    { max: REPORT_COST },
  );

/** 0.02 credits per matched email; the balance must cover 0.02 per email sent. */
export const searchEmails = (client: ModashClient, emails: string[]) =>
  client.call({ method: 'POST', path: 'email-search', body: { emails } }, emailSearchResponseSchema, {
    max: EMAIL_MATCH_COST * emails.length,
    actual: (data) => EMAIL_MATCH_COST * Math.min((data.matchedEmails ?? []).length, emails.length),
  });
