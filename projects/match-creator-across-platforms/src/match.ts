import { groupBy, partition, remove, uniqBy } from 'lodash-es';

import { EmailEvidence, type EmailListing } from './email-evidence.js';
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
  emails: EmailEvidence;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${error.message} (${code})` : error.message;
}

export class Matcher {
  #errors: string[] = [];
  /** Reports asked for while matching one creator (null when the call failed), so none is paid for twice. */
  #reports = new Map<string, ReportProfile | null>();

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

  async #safe<T>(what: string, step: () => Promise<T>): Promise<T | undefined> {
    try {
      return await step();
    } catch (error) {
      if (stopsTheRun(error)) throw error;
      this.#errors.push(`${what}: ${describe(error)}`);
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
    this.#errors = [];
    this.#reports.clear();
    const spentBefore = this.client.spent;
    const result: MatchResult = {
      input: { platform, handle },
      accounts: {},
      candidates: [],
      missing: [],
      credits: 0,
      errors: [],
    };
    try {
      const start = await this.#readStart(platform, handle, result);
      if (start) {
        await this.#followProfileLinks(start, result);
        await this.#matchByEmail(start, result);
        await this.#trySameHandle(start, result);
        this.#markEmailAgreement(start, result);
      }
    } catch (error) {
      if (stopsTheRun(error)) throw error;
      this.#errors.push(describe(error));
    }
    result.missing = PLATFORMS.filter((p) => !result.accounts[p]);
    result.credits = round2(this.client.spent - spentBefore);
    result.errors = this.#errors;
    return result;
  }

  /** Step 1: turn the handle into an id, then pull that account's report. */
  async #readStart(platform: Platform, handle: string, { accounts }: MatchResult): Promise<Start | undefined> {
    const me = await this.#safe(`lookup ${platform} @${handle}`, () => this.lookup(platform, handle));
    if (!me) return undefined;
    const account: Account = { userId: me.userId, username: nameOf(me), followers: me.followers ?? null, how: 'input' };
    accounts[platform] = account;
    const report = await this.#tryReport(platform, me.userId);
    if (!report) return undefined;
    account.followers = report.profile?.followers ?? account.followers;
    const emails = new EmailEvidence();
    emails.claim(emailsIn(report));
    return {
      platform,
      userId: me.userId,
      names: new Set([handle.toLowerCase(), ...namesOf(me), ...namesOf(report.profile)]),
      report,
      emails,
    };
  }

  /** Steps 2 and 3: a linked account is a match only when its own report links back to the start. */
  async #followProfileLinks(start: Start, result: MatchResult): Promise<void> {
    for (const other of PLATFORMS) {
      if (other === start.platform) continue;
      const linked: { account: Account; report: ReportProfile }[] = [];
      for (const userId of await this.#linkedIds(start, other)) {
        const report = await this.#tryReport(other, userId);
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
        result.accounts[other] = { ...match.account, how: 'confirmed both ways' };
        start.emails.claim(emailsIn(match.report));
      }
      for (const { account } of alsoConfirmed) {
        this.#suggest(result, { platform: other, ...account, how: 'confirmed both ways, second link' });
      }
      for (const { account } of oneWay) {
        this.#suggest(result, { platform: other, ...account, how: 'profile link, one way' });
      }
    }
  }

  async #linkedIds(start: Start, other: Platform): Promise<string[]> {
    const ids = new Set<string>();
    for (const contact of start.report.contacts ?? []) {
      if (contact.type !== other || !contact.value) continue;
      const id = idFrom(other, contact.value);
      if (id) {
        ids.add(id);
        continue;
      }
      const handle = handleFrom(other, contact.value);
      const row = handle ? await this.#safe(`lookup ${other} @${handle}`, () => this.lookup(other, handle)) : undefined;
      if (row) ids.add(row.userId);
    }
    return [...ids];
  }

  /** Step 4: one account per platform across the emails is a match; a shared address or a conflict gives candidates. */
  async #matchByEmail(start: Start, result: MatchResult): Promise<void> {
    const { accounts } = result;
    const missing = PLATFORMS.filter((p) => !accounts[p]);
    const claimed = start.emails.claimed;
    if (missing.length === 0 || claimed.length === 0) return;
    const data = await this.#safe('email search', () => searchEmails(this.client, claimed));

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
    start.emails.recordSearch(data && rows);
    const sharedEmails = start.emails.shared(accounts);
    const [sharedRows, ownRows] = partition(rows, (row) => sharedEmails.has(row.email));
    const byPlatform = groupBy(
      ownRows.filter((row) => missing.includes(row.platform)),
      'platform',
    );
    for (const group of Object.values(byPlatform)) {
      const [first] = group;
      if (first && uniqBy(group, 'userId').length === 1) {
        const { email, ...row } = first;
        const report = this.#reports.get(`${row.platform}:${row.userId}`);
        this.#accept(result, { ...row, followers: report?.profile?.followers ?? row.followers, how: `email (${email})` });
        continue;
      }
      for (const { email, ...row } of group) {
        this.#suggest(result, { ...row, how: `email (${email}), another email names a different account` });
      }
    }
    for (const { email, ...row } of sharedRows.filter((r) => !accounts[r.platform])) {
      this.#suggest(result, { ...row, how: `email (${email}), shared by several accounts` });
    }
  }

  /** An email that matched accounts on two platforms both list, and no other account is known to list, is a second piece of evidence for both. */
  #markEmailAgreement(start: Start, { accounts }: MatchResult): void {
    for (const platform of start.emails.agreeing(this.#emailsOfFound(accounts), accounts)) {
      accounts[platform]!.email_agrees = true;
    }
  }

  /** The emails each matched account lists, for the accounts whose report the tool holds. */
  #emailsOfFound(accounts: MatchResult['accounts']): EmailListing[] {
    return PLATFORMS.flatMap((platform) => {
      const account = accounts[platform];
      const report = account && this.#reports.get(`${platform}:${account.userId}`);
      return report ? [...emailsIn(report)].map((email) => ({ email, platform, userId: account.userId })) : [];
    });
  }

  /** Step 5: an account with one of the start's names is a guess until its own report confirms it. */
  async #trySameHandle(start: Start, result: MatchResult): Promise<void> {
    for (const other of PLATFORMS.filter((p) => !result.accounts[p])) {
      for (const name of start.names) {
        if (result.accounts[other]) break;
        const row = await this.#safe(`lookup ${other} @${name}`, () => this.lookup(other, name));
        if (!row) continue;
        const back = await this.#tryReport(other, row.userId);
        const followers = back?.profile?.followers ?? row.followers ?? null;
        const base = { platform: other, userId: row.userId, username: nameOf(row), followers };
        const shared = back ? start.emails.confirming(other, row.userId, emailsIn(back), result.accounts) : [];
        if (back && Matcher.pointsBack(back, start.platform, start.names, start.userId)) {
          this.#accept(result, { ...base, how: 'same handle, confirmed by its profile link back' });
        } else if (shared.length > 0) {
          this.#accept(result, { ...base, how: `same handle, confirmed by shared email (${shared[0]})` });
        } else {
          this.#suggest(result, { ...base, how: back ? 'same handle, unconfirmed' : 'same handle, report failed' });
        }
      }
    }
  }

  /** A report that failed is not asked for again for the same creator: the failed call may have been billed. */
  async #tryReport(platform: Platform, userId: string): Promise<ReportProfile | undefined> {
    const key = `${platform}:${userId}`;
    if (!this.#reports.has(key)) {
      const report = await this.#safe(`report ${platform} ${userId}`, () => this.report(platform, userId));
      this.#reports.set(key, report ?? null);
    }
    return this.#reports.get(key) ?? undefined;
  }

  #accept(result: MatchResult, { platform, ...account }: Candidate): void {
    remove(result.candidates, (c) => c.platform === platform && c.userId === account.userId);
    result.accounts[platform] = account;
  }

  /** An account already listed keeps its first, stronger reason. */
  #suggest(result: MatchResult, candidate: Candidate): void {
    const listed = result.candidates.some((c) => c.platform === candidate.platform && c.userId === candidate.userId);
    if (!listed) result.candidates.push(candidate);
  }
}
