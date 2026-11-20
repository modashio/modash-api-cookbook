import { groupBy, map } from 'lodash-es';

import { type FoundAccount, namesOf, type Platform } from '../src/contacts.js';
import type { EmailSearchHit } from '../src/email-evidence.js';
import type { ModashReads } from '../src/modash/reads.js';
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
    async lookupAccounts(platform, query) {
      return accounts.filter((a) => a.platform === platform && namesOf(a).has(query.toLowerCase()));
    },
    async report(platform, userId) {
      const report = reports.find((r) => r.platform === platform && r.userId === userId);
      if (!report) throw new Error(`no report for ${platform} ${userId}`);
      return report;
    },
    async searchEmails(emails) {
      if (!listings) throw new Error('email search failed');
      const listed = listings.filter((l) => emails.includes(l.email.toLowerCase()));
      return map(groupBy(listed, 'email'), (users, email) => ({ email, users }));
    },
  };
}
