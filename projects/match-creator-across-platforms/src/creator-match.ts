import { remove } from 'lodash-es';

import { PLATFORMS, type Platform } from './contacts.js';
import type { CreatorReads } from './creator-reads.js';
import type { ReportProfile } from './modash/responses.js';

export interface Account {
  userId: string;
  username: string | null;
  followers: number | null;
  how: string;
  emailAgrees?: true;
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

/** The part of the creator's reads the match reads: the reports held, the errors, and the credits spent. */
type ReadsSoFar = Pick<CreatorReads, 'heldReport' | 'errors' | 'credits'>;

/** Everything the run knows about one creator: the accounts matched so far and the candidates. */
export class CreatorMatch {
  readonly #input: MatchResult['input'];
  readonly #reads: ReadsSoFar;
  readonly #accounts: MatchResult['accounts'] = {};
  readonly #candidates: Candidate[] = [];
  #emailEvidence: EmailAgreement | undefined;

  constructor(platform: Platform, handle: string, reads: ReadsSoFar) {
    this.#input = { platform, handle };
    this.#reads = reads;
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

  heldReport(platform: Platform, userId: string): ReportProfile | undefined {
    return this.#reads.heldReport(platform, userId);
  }

  /** The email evidence searched for this creator; the result marks the matched accounts it says agree. */
  useEmailEvidence(evidence: EmailAgreement): void {
    this.#emailEvidence = evidence;
  }

  result(): MatchResult {
    for (const platform of this.#emailEvidence?.agreeing() ?? []) this.#accounts[platform]!.emailAgrees = true;
    return {
      input: this.#input,
      accounts: this.#accounts,
      candidates: this.#candidates,
      missing: this.missing(),
      credits: this.#reads.credits,
      errors: this.#reads.errors,
    };
  }
}
