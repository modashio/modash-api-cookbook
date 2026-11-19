import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { uniqBy } from 'lodash-es';

import { isPlatform, nameOf, namesOf, type Platform } from '../contacts.js';
import { writeAtomic } from '../results.js';
import type { ModashClient } from './client.js';
import {
  emailSearchResponseSchema,
  reportProfileSchema,
  reportResponseSchema,
  type ReportProfile,
  type UserRow,
  usersResponseSchema,
} from './responses.js';

export type FoundAccount = UserRow & { userId: string };

export interface EmailSearchHit {
  email: string;
  platform: Platform;
  userId: string;
  username: string | null;
  followers: number | null;
}

export interface ModashReads {
  readonly spent: number;
  /** The lookup can return more than one account; keep the exact handle, and a current handle over an older name. */
  findAccount(platform: Platform, handle: string): Promise<FoundAccount | undefined>;
  report(platform: Platform, userId: string): Promise<ReportProfile>;
  searchEmails(emails: string[]): Promise<EmailSearchHit[]>;
}

interface ReportCache {
  get(platform: Platform, userId: string): ReportProfile | undefined;
  set(platform: Platform, userId: string, report: ReportProfile): void;
}

const REPORT_COST = 1;
const EMAIL_MATCH_COST = 0.02;

/** Free. Searches the list of influencers for the query string. */
const lookupUsers = (client: ModashClient, platform: Platform, query: string) =>
  client.call({ method: 'GET', path: `${platform}/users`, query: { query, limit: '10' } }, usersResponseSchema);

/** 1 credit. */
const getReport = (client: ModashClient, platform: Platform, userId: string) =>
  client.call(
    { method: 'GET', path: `${platform}/profile/${encodeURIComponent(userId)}/report` },
    reportResponseSchema,
    { max: REPORT_COST },
  );

/** 0.02 credits per matched email; the balance must cover 0.02 per email sent. */
const searchEmails = (client: ModashClient, emails: string[]) =>
  client.call({ method: 'POST', path: 'email-search', body: { emails } }, emailSearchResponseSchema, {
    max: EMAIL_MATCH_COST * emails.length,
    actual: (data) => EMAIL_MATCH_COST * Math.min((data.matchedEmails ?? []).length, emails.length),
  });

export function modashReads(client: ModashClient, reportsDir?: string): ModashReads {
  const cache = reportsDir === undefined ? undefined : fileCache(reportsDir);
  return {
    get spent() {
      return client.spent;
    },

    async findAccount(platform, handle) {
      const data = await lookupUsers(client, platform, handle);
      const wanted = handle.toLowerCase();
      const rows = (data.users ?? []).filter((row): row is FoundAccount => !!row.userId);
      return (
        rows.find((row) => (nameOf(row) ?? '').toLowerCase() === wanted) ?? rows.find((row) => namesOf(row).has(wanted))
      );
    },

    async report(platform, userId) {
      const cached = cache?.get(platform, userId);
      if (cached) return cached;
      const data = await getReport(client, platform, userId);
      cache?.set(platform, userId, data.profile);
      return data.profile;
    },

    async searchEmails(emails) {
      const data = await searchEmails(client, emails);
      return uniqBy(
        (data.matchedEmails ?? []).flatMap(({ email, users }) =>
          (users ?? []).flatMap(({ platform, userId, followers, ...row }) =>
            userId && platform && isPlatform(platform)
              ? [{ email: (email ?? '').toLowerCase(), platform, userId, username: nameOf(row), followers: followers ?? null }]
              : [],
          ),
        ),
        (row) => `${row.email}:${row.platform}:${row.userId}`,
      );
    },
  };
}

function fileCache(dir: string): ReportCache {
  const file = (platform: Platform, userId: string) => join(dir, `${platform}_${userId.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
  return {
    get(platform, userId) {
      const path = file(platform, userId);
      if (!existsSync(path)) return undefined;
      const parsed = reportProfileSchema.safeParse((() => {
        try {
          return JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          return undefined;
        }
      })());
      if (parsed.success) return parsed.data;
      unlinkSync(path); // a broken saved file: pull it again
      return undefined;
    },
    set(platform, userId, report: ReportProfile) {
      mkdirSync(dir, { recursive: true });
      writeAtomic(file(platform, userId), JSON.stringify(report));
    },
  };
}
