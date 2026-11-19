import { remove } from 'lodash-es';

import { PLATFORMS, type Platform } from './contacts.js';
import type { ReportProfile } from './modash/responses.js';

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

/** The part of the email evidence the result reads: the platforms whose matched accounts agree by email. */
interface EmailAgreement {
  agreeing(): Platform[];
}

/** Everything the run knows about one creator: the accounts matched so far, the candidates, and the reports held. */
export class CreatorMatch {
  readonly #input: MatchResult['input'];
  readonly #accounts: MatchResult['accounts'] = {};
  readonly #candidates: Candidate[] = [];
  readonly #errors: string[] = [];
  /** Reports asked for while matching this creator (null when the call failed), so none is paid for twice. */
  readonly #reports = new Map<string, ReportProfile | null>();
  #emailEvidence: EmailAgreement | undefined;

  constructor(platform: Platform, handle: string) {
    this.#input = { platform, handle };
  }

  account(platform: Platform): Account | undefined {
    return this.#accounts[platform];
  }

  get matched(): MatchResult['accounts'] {
    return { ...this.#accounts };
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

  /** The email evidence searched for this creator; the result marks the matched accounts it says agree. */
  useEmailEvidence(evidence: EmailAgreement): void {
    this.#emailEvidence = evidence;
  }

  result(credits: number): MatchResult {
    for (const platform of this.#emailEvidence?.agreeing() ?? []) this.#accounts[platform]!.email_agrees = true;
    return {
      input: this.#input,
      accounts: this.#accounts,
      candidates: this.#candidates,
      missing: this.missing(),
      credits,
      errors: this.#errors,
    };
  }
}
