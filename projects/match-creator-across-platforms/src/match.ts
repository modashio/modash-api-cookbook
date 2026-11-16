import { emailsIn, handleFrom, idFrom, nameOf, namesOf, PLATFORMS, type Platform } from './contacts.js';
import type { ModashClient } from './modash/client.js';
import { CreditBudgetExceededError, ModashApiError, round2 } from './modash/errors.js';
import {
  emailSearchResponseSchema,
  type ReportProfile,
  reportResponseSchema,
  searchResponseSchema,
  type UserRow,
  usersResponseSchema,
} from './modash/responses.js';

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

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${error.message} (${code})` : error.message;
}

const REPORT_COST = 1;
const SEARCH_ROW_COST = 0.01;
const SEARCH_PAGE_ROWS = 15;
const EMAIL_MATCH_COST = 0.02;

export class Matcher {
  #errors: string[] = [];

  constructor(
    private readonly client: ModashClient,
    private readonly cache?: ReportCache,
  ) {}

  /** The lookup can return several close matches; keep only the exact handle. */
  async lookup(platform: Platform, handle: string): Promise<Found | undefined> {
    const data = await this.client.call(
      { method: 'GET', path: `${platform}/users`, query: { query: handle, limit: '10' } },
      usersResponseSchema,
    );
    const wanted = handle.toLowerCase();
    return (data.users ?? []).find((row): row is Found => !!row.userId && namesOf(row).has(wanted));
  }

  async find(platform: Platform, handle: string): Promise<Found | undefined> {
    const row = await this.lookup(platform, handle);
    if (row) return row;
    const data = await this.client.call(
      {
        method: 'POST',
        path: `${platform}/search`,
        // hasAudienceData defaults to true on search, which would leave out creators without audience data
        body: { page: 0, filter: { influencer: { relevance: [`@${handle}`], hasAudienceData: false } } },
      },
      searchResponseSchema,
      {
        max: SEARCH_ROW_COST * SEARCH_PAGE_ROWS,
        actual: (d) => SEARCH_ROW_COST * Math.min((d.directs ?? []).length + (d.lookalikes ?? []).length, SEARCH_PAGE_ROWS),
      },
    );
    const wanted = handle.toLowerCase();
    for (const hit of [...(data.directs ?? []), ...(data.lookalikes ?? [])]) {
      const profile = hit.profile ?? hit;
      if (hit.userId && namesOf(profile).has(wanted)) return { ...profile, userId: hit.userId };
    }
    return undefined;
  }

  async report(platform: Platform, userId: string): Promise<ReportProfile> {
    const cached = this.cache?.get(platform, userId);
    if (cached) return cached;
    const data = await this.client.call(
      { method: 'GET', path: `${platform}/profile/${encodeURIComponent(userId)}/report` },
      reportResponseSchema,
      { max: REPORT_COST },
    );
    this.cache?.set(platform, userId, data.profile);
    return data.profile;
  }

  async emailSearch(emails: string[]) {
    return this.client.call({ method: 'POST', path: 'email-search', body: { emails } }, emailSearchResponseSchema, {
      max: EMAIL_MATCH_COST * emails.length,
      actual: (d) => EMAIL_MATCH_COST * Math.min((d.matchedEmails ?? []).length, emails.length),
    });
  }

  async #safe<T>(what: string, step: () => Promise<T>): Promise<T | undefined> {
    try {
      return await step();
    } catch (error) {
      if (error instanceof CreditBudgetExceededError) throw error;
      if (error instanceof ModashApiError && error.isFatal) throw error;
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
      await this.#match(platform, handle, result);
    } catch (error) {
      if (error instanceof CreditBudgetExceededError) throw error;
      if (error instanceof ModashApiError && error.isFatal) throw error;
      this.#errors.push(describe(error));
    }
    result.missing = PLATFORMS.filter((p) => !result.accounts[p]);
    result.credits = round2(this.client.spent - spentBefore);
    result.errors = this.#errors;
    return result;
  }

  async #match(platform: Platform, handle: string, result: MatchResult): Promise<void> {
    const { accounts, candidates } = result;
    const me = await this.#safe(`find ${platform} @${handle}`, () => this.find(platform, handle));
    if (!me) return;
    const startNames = new Set([...namesOf(me), handle.toLowerCase()]);
    accounts[platform] = { userId: me.userId, username: nameOf(me), followers: me.followers ?? null, how: 'input' };
    const start = await this.#safe(`report ${platform} ${me.userId}`, () => this.report(platform, me.userId));
    if (!start) return;
    accounts[platform].followers = start.profile?.followers ?? me.followers ?? null;
    const emails = emailsIn(start);

    // Steps 2 and 3
    for (const other of PLATFORMS) {
      if (other === platform) continue;
      const found: Account[] = [];
      const seen = new Set<string>();
      for (const contact of start.contacts ?? []) {
        if (contact.type !== other || !contact.value) continue;
        let otherId = idFrom(other, contact.value);
        if (!otherId) {
          const h = handleFrom(other, contact.value);
          const row = h ? await this.#safe(`lookup ${other} @${h}`, () => this.lookup(other, h)) : undefined;
          otherId = row?.userId;
        }
        if (!otherId || seen.has(otherId)) continue;
        seen.add(otherId);
        const id = otherId;
        const back = await this.#safe(`report ${other} ${id}`, () => this.report(other, id));
        if (!back) continue;
        for (const e of emailsIn(back)) emails.add(e);
        found.push({
          userId: id,
          username: nameOf(back.profile),
          followers: back.profile?.followers ?? null,
          how: Matcher.pointsBack(back, platform, startNames, me.userId) ? 'confirmed both ways' : 'profile link, one way',
        });
      }
      found.sort((a, b) => Number(a.how !== 'confirmed both ways') - Number(b.how !== 'confirmed both ways'));
      const [best, ...rest] = found;
      if (best) accounts[other] = best;
      for (const a of rest) candidates.push({ platform: other, ...a, how: `${a.how}, second link` });
    }

    // Step 4
    const missing = PLATFORMS.filter((p) => !accounts[p]);
    if (missing.length > 0 && emails.size > 0) {
      const data = await this.#safe('email search', () => this.emailSearch([...emails].sort()));
      const hits = new Map<Platform, Map<string, Candidate>>();
      for (const m of data?.matchedEmails ?? []) {
        for (const row of m.users ?? []) {
          const p = row.platform;
          if (!row.userId || !p || !(PLATFORMS as readonly string[]).includes(p)) continue;
          const plat = p as Platform;
          const existing = accounts[plat];
          if (existing?.userId === row.userId) {
            existing.email_agrees = true;
          } else if (missing.includes(plat)) {
            const byId = hits.get(plat) ?? new Map<string, Candidate>();
            byId.set(row.userId, {
              platform: plat,
              userId: row.userId,
              username: nameOf(row),
              followers: row.followers ?? null,
              how: `email (${m.email ?? ''})`,
            });
            hits.set(plat, byId);
          }
        }
      }
      for (const [plat, byId] of hits) {
        const rows = [...byId.values()];
        if (rows.length === 1) {
          const { platform: _platform, ...account } = rows[0]!;
          accounts[plat] = account;
        } else {
          for (const r of rows) candidates.push({ ...r, how: `${r.how}, shared by several accounts` });
        }
      }
    }

    // Step 5
    for (const other of PLATFORMS.filter((p) => !accounts[p])) {
      const row = await this.#safe(`lookup ${other} @${handle}`, () => this.lookup(other, handle));
      if (!row) continue;
      const base = { userId: row.userId, username: nameOf(row), followers: row.followers ?? null };
      const back = await this.#safe(`report ${other} ${row.userId}`, () => this.report(other, row.userId));
      const shared = back ? [...emailsIn(back)].filter((e) => emails.has(e)).sort() : [];
      let how: string | undefined;
      if (back && Matcher.pointsBack(back, platform, startNames, me.userId)) {
        how = 'same handle, confirmed by its profile link back';
      } else if (shared.length > 0) {
        how = `same handle, confirmed by shared email (${shared[0]})`;
      }
      const sameRow = (c: Candidate) => c.platform === other && c.userId === row.userId;
      if (how) {
        candidates.splice(0, candidates.length, ...candidates.filter((c) => !sameRow(c)));
        accounts[other] = { ...base, how };
      } else if (!candidates.some(sameRow)) {
        candidates.push({
          platform: other,
          ...base,
          how: back ? 'same handle, unconfirmed' : 'same handle, report failed',
        });
      }
    }
  }
}
