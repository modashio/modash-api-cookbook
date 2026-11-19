import { groupBy, remove, uniq, uniqBy } from 'lodash-es';

import { emailsIn, isPlatform, PLATFORMS, type Platform } from './contacts.js';
import type { Account, Candidate, MatchResult } from './match.js';
import type { ReportProfile } from './modash/responses.js';

/** One account that lists one email: from email search, or from a report the tool holds. */
export interface EmailListing {
  email: string;
  platform: Platform;
  userId: string;
}

/** The creator's account per platform, as far as the run has matched them. */
type Matched = Partial<Record<Platform, { userId: string }>>;

/**
 * Everything the run knows about one creator: the accounts matched so far, the candidates, the reports held, and
 * what the emails prove. An address belongs to more than one person when two accounts on one platform list it, or
 * when an account other than the creator's lists it on a platform where the creator is matched. Such an address
 * proves nothing. Every answer about emails takes the matches known at the time it is asked.
 */
export class CreatorMatch {
  readonly #input: MatchResult['input'];
  readonly #accounts: MatchResult['accounts'] = {};
  readonly #candidates: Candidate[] = [];
  readonly #errors: string[] = [];
  /** Reports asked for while matching this creator (null when the call failed), so none is paid for twice. */
  readonly #reports = new Map<string, ReportProfile | null>();
  readonly #claimed = new Set<string>();
  /** What email search answered; undefined until it answers. */
  #searchHits: EmailListing[] | undefined;

  constructor(platform: Platform, handle: string) {
    this.#input = { platform, handle };
  }

  account(platform: Platform): Account | undefined {
    return this.#accounts[platform];
  }

  missing(): Platform[] {
    return PLATFORMS.filter((p) => !this.#accounts[p]);
  }

  accept({ platform, ...account }: Candidate): void {
    remove(this.#candidates, (c) => c.platform === platform && c.userId === account.userId);
    this.#accounts[platform] = account;
  }

  /** An account already listed keeps its first, stronger reason. */
  suggest(candidate: Candidate): void {
    const listed = this.#candidates.some((c) => c.platform === candidate.platform && c.userId === candidate.userId);
    if (!listed) this.#candidates.push(candidate);
  }

  fail(error: string): void {
    this.#errors.push(error);
  }

  /** A report that failed is not asked for again for the same creator: the failed call may have been billed. */
  async reportOnce(
    platform: Platform,
    userId: string,
    ask: () => Promise<ReportProfile | undefined>,
  ): Promise<ReportProfile | undefined> {
    const key = `${platform}:${userId}`;
    if (!this.#reports.has(key)) {
      const report = await ask();
      this.#reports.set(key, report ?? null);
    }
    return this.#reports.get(key) ?? undefined;
  }

  heldReport(platform: Platform, userId: string): ReportProfile | undefined {
    return this.#reports.get(`${platform}:${userId}`) ?? undefined;
  }

  /** Emails on the starting report and on accounts confirmed both ways: the ones the creator puts their name to. */
  claim(emails: Iterable<string>): void {
    for (const email of emails) this.#claimed.add(email);
  }

  /** The claimed emails, in the order email search is asked for them. */
  get claimed(): string[] {
    return [...this.#claimed].sort();
  }

  /** Records what email search answered, or undefined when the call failed. */
  recordSearch(hits: EmailListing[] | undefined): void {
    this.#searchHits = hits;
  }

  sharedEmails(): Set<string> {
    return this.#shared(this.#accounts);
  }

  /**
   * The claimed emails that confirm `candidate`: it lists them, and they stay unshared if it were the creator's
   * account. None when email search has not answered, since then nothing is known about who else lists them.
   */
  confirming(candidate: Platform, userId: string, listed: Iterable<string>): string[] {
    if (this.#searchHits === undefined) return [];
    const shared = this.#shared({ ...this.#accounts, [candidate]: { userId } });
    return [...listed].filter((email) => this.#claimed.has(email) && !shared.has(email)).sort();
  }

  /** An email that matched accounts on two platforms both list, and no other account is known to list, is a second piece of evidence for both. */
  markEmailAgreement(): void {
    const shared = this.sharedEmails();
    const listings = this.#emailsOfFound().filter((listing) => !shared.has(listing.email));
    const groups = Object.values(groupBy(listings, 'email'));
    const agreeing = uniq(
      groups.filter((group) => uniqBy(group, 'platform').length > 1).flatMap((group) => group.map((listing) => listing.platform)),
    );
    for (const platform of agreeing) {
      this.#accounts[platform]!.email_agrees = true;
    }
  }

  result(credits: number): MatchResult {
    return {
      input: this.#input,
      accounts: this.#accounts,
      candidates: this.#candidates,
      missing: this.missing(),
      credits,
      errors: this.#errors,
    };
  }

  #shared(matched: Matched): Set<string> {
    const listedByOthers = (listings: EmailListing[]) =>
      Object.entries(groupBy(listings, 'platform')).some(([platform, group]) => {
        const listers = uniq(group.map((listing) => listing.userId));
        const own = isPlatform(platform) ? matched[platform]?.userId : undefined;
        return listers.length > 1 || (own !== undefined && listers[0] !== own);
      });
    return new Set(
      Object.entries(groupBy(this.#searchHits ?? [], 'email'))
        .filter(([, listings]) => listedByOthers(listings))
        .map(([email]) => email),
    );
  }

  /** The emails each matched account lists, for the accounts whose report the tool holds. */
  #emailsOfFound(): EmailListing[] {
    return PLATFORMS.flatMap((platform) => {
      const account = this.#accounts[platform];
      const report = account && this.heldReport(platform, account.userId);
      return report ? [...emailsIn(report)].map((email) => ({ email, platform, userId: account.userId })) : [];
    });
  }
}
