import { partition } from 'lodash-es';

import { type Account, CreatorMatch, type MatchResult } from './creator-match.js';
import { emailsIn, handleFrom, idFrom, nameOf, namesOf, PLATFORMS, type Platform } from './contacts.js';
import { CreatorReads } from './creator-reads.js';
import { type EmailEvidence, searchEmailEvidence } from './email-evidence.js';
import type { ModashReads } from './modash/reads.js';
import type { ReportProfile } from './modash/responses.js';

/** The account the run started from, and what its report says about it. */
interface Start {
  platform: Platform;
  userId: string;
  /** Every name the account answers to, lower case, the input handle first. */
  names: Set<string>;
  report: ReportProfile;
}

export class Matcher {
  constructor(private readonly reads: ModashReads) {}

  static pointsBack(report: ReportProfile, platform: Platform, startNames: Set<string>, startId: string): boolean {
    return report.contacts.some(
      (c) =>
        c.type === platform &&
        (startNames.has(handleFrom(platform, c.value) ?? '') || idFrom(platform, c.value) === startId),
    );
  }

  async match(platform: Platform, handle: string): Promise<MatchResult> {
    const reads = new CreatorReads(this.reads);
    const creator = new CreatorMatch(platform, handle, reads);
    try {
      const start = await this.#readStart(platform, handle, creator, reads);
      if (start) {
        const confirmed = await this.#followProfileLinks(start, creator, reads);
        const evidence = await this.#matchByEmail(creator, reads, [start.report, ...confirmed]);
        await this.#trySameHandle(start, creator, reads, evidence);
      }
    } catch (error) {
      reads.fail(error);
    }
    return creator.result();
  }

  /** Step 1: turn the handle into an id, then pull that account's report. */
  async #readStart(platform: Platform, handle: string, creator: CreatorMatch, reads: CreatorReads): Promise<Start | undefined> {
    const me = await reads.account(platform, handle);
    if (!me) return undefined;
    const report = await reads.report(platform, me.userId);
    const followers = report?.profile?.followers ?? me.followers ?? null;
    creator.accept({ platform, userId: me.userId, username: nameOf(me), followers, how: 'input' });
    if (!report) return undefined;
    return {
      platform,
      userId: me.userId,
      names: new Set([handle, ...namesOf(me), ...namesOf(report.profile)]),
      report,
    };
  }

  /** Steps 2 and 3: a linked account is a match only when its own report links back to the start. */
  async #followProfileLinks(start: Start, creator: CreatorMatch, reads: CreatorReads): Promise<ReportProfile[]> {
    const confirmed: ReportProfile[] = [];
    for (const other of PLATFORMS) {
      if (other === start.platform) continue;
      const linked: { account: Account; report: ReportProfile }[] = [];
      for (const userId of await this.#linkedIds(start, other, reads)) {
        const report = await reads.report(other, userId);
        if (!report) continue;
        linked.push({
          report,
          account: { userId, username: nameOf(report.profile), followers: report.profile?.followers ?? null, how: '' },
        });
      }
      const [[match, ...alsoConfirmed], oneWay] = partition(linked, ({ report }) =>
        Matcher.pointsBack(report, start.platform, start.names, start.userId),
      );
      if (match) {
        creator.accept({ platform: other, ...match.account, how: 'confirmed both ways' });
        confirmed.push(match.report);
      }
      for (const { account } of alsoConfirmed) {
        creator.suggest({ platform: other, ...account, how: 'confirmed both ways, second link' });
      }
      for (const { account } of oneWay) {
        creator.suggest({ platform: other, ...account, how: 'profile link, one way' });
      }
    }
    return confirmed;
  }

  async #linkedIds(start: Start, other: Platform, reads: CreatorReads): Promise<string[]> {
    const ids = new Set<string>();
    for (const contact of start.report.contacts) {
      if (contact.type !== other) continue;
      const id = idFrom(other, contact.value);
      if (id) {
        ids.add(id);
        continue;
      }
      const handle = handleFrom(other, contact.value);
      const row = handle ? await reads.account(other, handle) : undefined;
      if (row) ids.add(row.userId);
    }
    return [...ids];
  }

  /** Step 4: one account per platform across the emails is a match; a shared address or a conflict gives candidates. */
  async #matchByEmail(creator: CreatorMatch, reads: CreatorReads, claimedOn: ReportProfile[]): Promise<EmailEvidence> {
    const claimed = claimedOn.flatMap((report) => [...emailsIn(report)]);
    const evidence = await searchEmailEvidence(creator, claimed, (emails) => reads.searchEmails(emails));
    creator.useEmailEvidence(evidence);
    for (const { accept, candidate } of evidence.verdicts) {
      if (accept) creator.accept(candidate);
      else creator.suggest(candidate);
    }
    return evidence;
  }

  /** Step 5: an account with one of the start's names is a guess until its own report confirms it. */
  async #trySameHandle(start: Start, creator: CreatorMatch, reads: CreatorReads, evidence: EmailEvidence): Promise<void> {
    for (const other of creator.missing()) {
      for (const name of start.names) {
        if (creator.account(other)) break;
        const row = await reads.account(other, name);
        if (!row) continue;
        const back = await reads.report(other, row.userId);
        const followers = back?.profile?.followers ?? row.followers ?? null;
        const base = { platform: other, userId: row.userId, username: nameOf(row), followers };
        const shared = back ? evidence.confirming(other, row.userId, emailsIn(back)) : [];
        if (back && Matcher.pointsBack(back, start.platform, start.names, start.userId)) {
          creator.accept({ ...base, how: 'same handle, confirmed by its profile link back' });
        } else if (shared.length > 0) {
          creator.accept({ ...base, how: `same handle, confirmed by shared email (${shared[0]})` });
        } else {
          creator.suggest({ ...base, how: back ? 'same handle, unconfirmed' : 'same handle, report failed' });
        }
      }
    }
  }
}
