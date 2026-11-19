import { type FoundAccount, pickAccount, type Platform } from './contacts.js';
import { type EmailSearchHit, emailSearchHits } from './email-evidence.js';
import { MockDataMissingError, stopsTheRun } from './modash/errors.js';
import type { ModashReads } from './modash/reads.js';
import type { ReportProfile } from './modash/responses.js';
import { round2 } from './numbers.js';

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${error.message} (${code})` : error.message;
}

/**
 * The API reads made while matching one creator. Make one per creator. A read that fails gives undefined and an error
 * in `errors`, except an error that stops the run, which is thrown. `credits` is what this creator has spent so far.
 */
export class CreatorReads {
  readonly #reads: ModashReads;
  readonly #spentBefore: number;
  readonly #errors: string[] = [];
  /** Reports asked for (null when the call failed), so none is paid for twice. */
  readonly #reports = new Map<string, ReportProfile | null>();

  constructor(reads: ModashReads) {
    this.#reads = reads;
    this.#spentBefore = reads.spent;
  }

  get errors(): string[] {
    return [...this.#errors];
  }

  get credits(): number {
    return round2(this.#reads.spent - this.#spentBefore);
  }

  /** Lets an error that stops the run, or a mock-data bug, through, and records any other one. */
  fail(error: unknown, what?: string): void {
    if (stopsTheRun(error) || error instanceof MockDataMissingError) throw error;
    this.#errors.push(what === undefined ? describe(error) : `${what}: ${describe(error)}`);
  }

  /** Free. The account on `platform` that answers to `handle`. */
  async account(platform: Platform, handle: string): Promise<FoundAccount | undefined> {
    const rows = await this.#try(`lookup ${platform} @${handle}`, () => this.#reads.lookupAccounts(platform, handle));
    return pickAccount(rows ?? [], handle);
  }

  /** A report that failed is not asked for again: the failed call may have been billed. */
  async report(platform: Platform, userId: string): Promise<ReportProfile | undefined> {
    const key = `${platform}:${userId}`;
    if (!this.#reports.has(key)) {
      const report = await this.#try(`report ${platform} ${userId}`, () => this.#reads.report(platform, userId));
      this.#reports.set(key, report ?? null);
    }
    return this.#reports.get(key) ?? undefined;
  }

  /** A report already read for this creator. Never calls the API. */
  heldReport(platform: Platform, userId: string): ReportProfile | undefined {
    return this.#reports.get(`${platform}:${userId}`) ?? undefined;
  }

  /** The accounts that list each email. */
  searchEmails(emails: string[]): Promise<EmailSearchHit[] | undefined> {
    return this.#try('email search', async () => emailSearchHits(await this.#reads.searchEmails(emails)));
  }

  async #try<T>(what: string, step: () => Promise<T>): Promise<T | undefined> {
    try {
      return await step();
    } catch (error) {
      this.fail(error, what);
      return undefined;
    }
  }
}
