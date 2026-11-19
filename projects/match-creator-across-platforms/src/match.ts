import { groupBy, partition, uniqBy } from 'lodash-es';

import { CreatorMatch } from './creator-match.js';
import { emailsIn, handleFrom, idFrom, isPlatform, nameOf, namesOf, PLATFORMS, type Platform } from './contacts.js';
import { getReport, lookupUsers, searchEmails } from './modash/api.js';
import type { ModashClient } from './modash/client.js';
import { stopsTheRun } from './modash/errors.js';
import type { ReportProfile, UserRow } from './modash/responses.js';
import { round2 } from './numbers.js';

export interface Account {
  userId: string;
  username: string | null;
  followers: number | null;
  how: string;
  email_agrees?: true;
}

export interface Candidate extends Account {
  platform: Platform;
}

export interface MatchResult {
  input: { platform: Platform; handle: string };
  accounts: Partial<Record<Platform, Account>>;
  candidates: Candidate[];
  missing: Platform[];
  credits: number;
  errors: string[];
}

export interface ReportCache {
  get(platform: Platform, userId: string): ReportProfile | undefined;
  set(platform: Platform, userId: string, report: ReportProfile): void;
}

type Found = UserRow & { userId: string };

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
  constructor(
    private readonly client: ModashClient,
    private readonly cache?: ReportCache,
  ) {}

  /** The lookup can return more than one account; keep the exact handle, and a current handle over an older name. */
  async lookup(platform: Platform, handle: string): Promise<Found | undefined> {
    const data = await lookupUsers(this.client, platform, handle);
    const wanted = handle.toLowerCase();
    const rows = (data.users ?? []).filter((row): row is Found => !!row.userId);
    return (
      rows.find((row) => (nameOf(row) ?? '').toLowerCase() === wanted) ?? rows.find((row) => namesOf(row).has(wanted))
    );
  }

  async report(platform: Platform, userId: string): Promise<ReportProfile> {
    const cached = this.cache?.get(platform, userId);
    if (cached) return cached;
    const data = await getReport(this.client, platform, userId);
    this.cache?.set(platform, userId, data.profile);
    return data.profile;
  }

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
    const spentBefore = this.client.spent;
    const creator = new CreatorMatch(platform, handle);
    try {
      const start = await this.#readStart(platform, handle, creator);
      if (start) {
        await this.#followProfileLinks(start, creator);
        await this.#matchByEmail(creator);
        await this.#trySameHandle(start, creator);
        creator.markEmailAgreement();
      }
    } catch (error) {
      if (stopsTheRun(error)) throw error;
      creator.fail(describe(error));
    }
    return creator.result(round2(this.client.spent - spentBefore));
  }

  /** Step 1: turn the handle into an id, then pull that account's report. */
  async #readStart(platform: Platform, handle: string, creator: CreatorMatch): Promise<Start | undefined> {
    const me = await this.#safe(creator, `lookup ${platform} @${handle}`, () => this.lookup(platform, handle));
    if (!me) return undefined;
    const report = await this.#tryReport(creator, platform, me.userId);
    const followers = report?.profile?.followers ?? me.followers ?? null;
    creator.accept({ platform, userId: me.userId, username: nameOf(me), followers, how: 'input' });
    if (!report) return undefined;
    creator.claim(emailsIn(report));
    return {
      platform,
      userId: me.userId,
      names: new Set([handle.toLowerCase(), ...namesOf(me), ...namesOf(report.profile)]),
      report,
    };
  }

  /** Steps 2 and 3: a linked account is a match only when its own report links back to the start. */
  async #followProfileLinks(start: Start, creator: CreatorMatch): Promise<void> {
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
        creator.claim(emailsIn(match.report));
      }
      for (const { account } of alsoConfirmed) {
        creator.suggest({ platform: other, ...account, how: 'confirmed both ways, second link' });
      }
      for (const { account } of oneWay) {
        creator.suggest({ platform: other, ...account, how: 'profile link, one way' });
      }
    }
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
      const row = handle
        ? await this.#safe(creator, `lookup ${other} @${handle}`, () => this.lookup(other, handle))
        : undefined;
      if (row) ids.add(row.userId);
    }
    return [...ids];
  }

  /** Step 4: one account per platform across the emails is a match; a shared address or a conflict gives candidates. */
  async #matchByEmail(creator: CreatorMatch): Promise<void> {
    const missing = creator.missing();
    const claimed = creator.claimed;
    if (missing.length === 0 || claimed.length === 0) return;
    const data = await this.#safe(creator, 'email search', () => searchEmails(this.client, claimed));

    const rows = uniqBy(
      (data?.matchedEmails ?? []).flatMap(({ email, users }) =>
        (users ?? []).flatMap(({ platform, userId, followers, ...row }) =>
          userId && platform && isPlatform(platform)
            ? [{ email: (email ?? '').toLowerCase(), platform, userId, username: nameOf(row), followers: followers ?? null }]
            : [],
        ),
      ),
      (row) => `${row.email}:${row.platform}:${row.userId}`,
    );
    creator.recordSearch(data && rows);
    const sharedEmails = creator.sharedEmails();
    const [sharedRows, ownRows] = partition(rows, (row) => sharedEmails.has(row.email));
    const byPlatform = groupBy(
      ownRows.filter((row) => missing.includes(row.platform)),
      'platform',
    );
    for (const group of Object.values(byPlatform)) {
      const [first] = group;
      if (first && uniqBy(group, 'userId').length === 1) {
        const { email, ...row } = first;
        const report = creator.heldReport(row.platform, row.userId);
        creator.accept({ ...row, followers: report?.profile?.followers ?? row.followers, how: `email (${email})` });
        continue;
      }
      for (const { email, ...row } of group) {
        creator.suggest({ ...row, how: `email (${email}), another email names a different account` });
      }
    }
    for (const { email, ...row } of sharedRows.filter((r) => !creator.account(r.platform))) {
      creator.suggest({ ...row, how: `email (${email}), shared by several accounts` });
    }
  }

  /** Step 5: an account with one of the start's names is a guess until its own report confirms it. */
  async #trySameHandle(start: Start, creator: CreatorMatch): Promise<void> {
    for (const other of creator.missing()) {
      for (const name of start.names) {
        if (creator.account(other)) break;
        const row = await this.#safe(creator, `lookup ${other} @${name}`, () => this.lookup(other, name));
        if (!row) continue;
        const back = await this.#tryReport(creator, other, row.userId);
        const followers = back?.profile?.followers ?? row.followers ?? null;
        const base = { platform: other, userId: row.userId, username: nameOf(row), followers };
        const shared = back ? creator.confirming(other, row.userId, emailsIn(back)) : [];
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

  #tryReport(creator: CreatorMatch, platform: Platform, userId: string): Promise<ReportProfile | undefined> {
    return creator.reportOnce(platform, userId, () =>
      this.#safe(creator, `report ${platform} ${userId}`, () => this.report(platform, userId)),
    );
  }
}
