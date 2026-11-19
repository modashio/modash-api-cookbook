import { namesOf, type Platform } from '../src/contacts.js';
import type { EmailSearchHit, FoundAccount, ModashReads } from '../src/modash/reads.js';
import type { ReportProfile } from '../src/modash/responses.js';

type Listed = Pick<EmailSearchHit, 'email' | 'platform' | 'userId'> & Partial<EmailSearchHit>;

export interface MemoryData {
  accounts?: (FoundAccount & { platform: Platform })[];
  reports?: (ReportProfile & { platform: Platform; userId: string })[];
  /** What email search answers; leave it out to make the search fail. */
  listings?: Listed[];
}

export function memoryReads({ accounts = [], reports = [], listings }: MemoryData): ModashReads {
  return {
    spent: 0,
    async findAccount(platform, handle) {
      return accounts.find((a) => a.platform === platform && namesOf(a).has(handle.toLowerCase()));
    },
    async report(platform, userId) {
      const report = reports.find((r) => r.platform === platform && r.userId === userId);
      if (!report) throw new Error(`no report for ${platform} ${userId}`);
      return report;
    },
    async searchEmails(emails) {
      if (!listings) throw new Error('email search failed');
      return listings
        .filter((l) => emails.includes(l.email))
        .map((l) => ({ username: null, followers: null, ...l }));
    },
  };
}
