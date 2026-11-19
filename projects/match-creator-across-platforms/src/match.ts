import { partition } from 'lodash-es';

import { type Account, CreatorMatch, type MatchResult } from './creator-match.js';
import { emailsIn, type FoundAccount, handleFrom, idFrom, nameOf, namesOf, pickAccount, PLATFORMS, type Platform } from './contacts.js';
import { type EmailEvidence, emailSearchHits, searchEmailEvidence } from './email-evidence.js';
import { stopsTheRun } from './modash/errors.js';
import type { ModashReads } from './modash/reads.js';
import type { ReportProfile } from './modash/responses.js';
import { round2 } from './numbers.js';

/** The account the run started from, and what its report says about it. */
interface Start {
  platform: Platform;
  userId: string;
  /** Every name the account answers to, lower case, the input handle first. */
  names: Set<string>;
  report: ReportProfile;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${error.message} (${code})` : error.message;
}

export class Matcher {
  constructor(private readonly reads: ModashReads) {}

  async #safe<T>(creator: CreatorMatch, what: string, step: () => Promise<T>): Promise<T | undefined> {
    try {
      return await step();
    } catch (error) {
      if (stopsTheRun(error)) throw error;
      creator.fail(`${what}: ${describe(error)}`);
      return undefined;
    }
  }

  static pointsBack(report: ReportProfile, platform: Platform, startNames: Set<string>, startId: string): boolean {
    return (report.contacts ?? []).some(
      (c) =>
        c.type === platform &&
        (startNames.has((handleFrom(platform, c.value) ?? '').toLowerCase()) || idFrom(platform, c.value) === startId),
    );
  }

  async match(platform: Platform, handle: string): Promise<MatchResult> {
    const spentBefore = this.reads.spent;
    const creator = new CreatorMatch(platform, handle);
    let emailAgrees: Platform[] = [];
    try {
      const start = await this.#readStart(platform, handle, creator);
      if (start) {
        const confirmed = await this.#followProfileLinks(start, creator);
        const evidence = await this.#matchByEmail(creator, [start.report, ...confirmed]);
        await this.#trySameHandle(start, creator, evidence);
        emailAgrees = evidence.agreeing(creator.matched, (p, userId) => creator.heldReport(p, userId));
      }
    } catch (error) {
      if (stopsTheRun(error)) throw error;
      creator.fail(describe(error));
    }
    return creator.result(round2(this.reads.spent - spentBefore), emailAgrees);
  }

  /** Step 1: turn the handle into an id, then pull that account's report. */
  async #readStart(platform: Platform, handle: string, creator: CreatorMatch): Promise<Start | undefined> {
    const me = await this.#findAccount(creator, platform, handle);
    if (!me) return undefined;
    const report = await this.#tryReport(creator, platform, me.userId);
    const followers = report?.profile?.followers ?? me.followers ?? null;
    creator.accept({ platform, userId: me.userId, username: nameOf(me), followers, how: 'input' });
    if (!report) return undefined;
    return {
      platform,
      userId: me.userId,
      names: new Set([handle.toLowerCase(), ...namesOf(me), ...namesOf(report.profile)]),
      report,
    };
  }

  /** Steps 2 and 3: a linked account is a match only when its own report links back to the start. */
  async #followProfileLinks(start: Start, creator: CreatorMatch): Promise<ReportProfile[]> {
    const confirmed: ReportProfile[] = [];
    for (const other of PLATFORMS) {
      if (other === start.platform) continue;
      const linked: { account: Account; report: ReportProfile }[] = [];
      for (const userId of await this.#linkedIds(start, other, creator)) {
        const report = await this.#tryReport(creator, other, userId);
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

  async #linkedIds(start: Start, other: Platform, creator: CreatorMatch): Promise<string[]> {
    const ids = new Set<string>();
    for (const contact of start.report.contacts ?? []) {
      if (contact.type !== other || !contact.value) continue;
      const id = idFrom(other, contact.value);
      if (id) {
        ids.add(id);
        continue;
      }
      const handle = handleFrom(other, contact.value);
      const row = handle ? await this.#findAccount(creator, other, handle) : undefined;
      if (row) ids.add(row.userId);
    }
    return [...ids];
  }

  /** Step 4: one account per platform across the emails is a match; a shared address or a conflict gives candidates. */
  async #matchByEmail(creator: CreatorMatch, claimedOn: ReportProfile[]): Promise<EmailEvidence> {
    const claimed = claimedOn.flatMap((report) => [...emailsIn(report)]);
    const evidence = await searchEmailEvidence(claimed, creator.matched, (emails) =>
      this.#safe(creator, 'email search', async () => emailSearchHits(await this.reads.searchEmails(emails))),
    );
    for (const { accept, candidate } of evidence.verdicts) {
      if (!accept) {
        creator.suggest(candidate);
        continue;
      }
      const report = creator.heldReport(candidate.platform, candidate.userId);
      creator.accept({ ...candidate, followers: report?.profile?.followers ?? candidate.followers });
    }
    return evidence;
  }

  /** Step 5: an account with one of the start's names is a guess until its own report confirms it. */
  async #trySameHandle(start: Start, creator: CreatorMatch, evidence: EmailEvidence): Promise<void> {
    for (const other of creator.missing()) {
      for (const name of start.names) {
        if (creator.account(other)) break;
        const row = await this.#findAccount(creator, other, name);
        if (!row) continue;
        const back = await this.#tryReport(creator, other, row.userId);
        const followers = back?.profile?.followers ?? row.followers ?? null;
        const base = { platform: other, userId: row.userId, username: nameOf(row), followers };
        const shared = back ? evidence.confirming(creator.matched, other, row.userId, emailsIn(back)) : [];
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

  async #findAccount(creator: CreatorMatch, platform: Platform, handle: string): Promise<FoundAccount | undefined> {
    const rows = await this.#safe(creator, `lookup ${platform} @${handle}`, () => this.reads.lookupAccounts(platform, handle));
    return pickAccount(rows ?? [], handle);
  }

  #tryReport(creator: CreatorMatch, platform: Platform, userId: string): Promise<ReportProfile | undefined> {
    return creator.reportOnce(platform, userId, () =>
      this.#safe(creator, `report ${platform} ${userId}`, () => this.reads.report(platform, userId)),
    );
  }
}
