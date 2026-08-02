/**
 * Credit accounting.
 *
 * Modash bills per *result*, not per request, and an agent that can call a
 * search endpoint in a loop is exactly the kind of thing that produces a
 * surprising invoice. So every paid call in this project goes through a ledger
 * with a hard per-session budget.
 *
 * Costs below are from https://docs.modash.io — the ones this project touches.
 */

/** Credits per profile returned by any `/ai/*` search or lookalike endpoint. */
export const CREDITS_PER_AI_SEARCH_PROFILE = 0.025;

/**
 * A full profile report. Forty times the cost of a search result, which is the
 * whole reason the workflow is "search broadly, report only the shortlist".
 */
export const CREDITS_PER_REPORT = 1;

export class CreditBudgetExceededError extends Error {
  constructor(
    readonly requested: number,
    readonly remaining: number,
  ) {
    super(
      `This search would cost about ${requested.toFixed(3)} credits but only ${remaining.toFixed(
        3,
      )} remain in this session's budget.`,
    );
    this.name = 'CreditBudgetExceededError';
  }
}

export interface CreditEntry {
  label: string;
  credits: number;
  at: number;
}

export class CreditLedger {
  private readonly entries: CreditEntry[] = [];

  constructor(readonly budget: number) {}

  get spent(): number {
    return this.entries.reduce((total, entry) => total + entry.credits, 0);
  }

  get remaining(): number {
    return Math.max(0, this.budget - this.spent);
  }

  get calls(): number {
    return this.entries.length;
  }

  /**
   * Call *before* a paid request, with the worst-case cost. AI Search bills per
   * returned profile, so the worst case is `pageSize` profiles.
   */
  assertCanSpend(estimatedCredits: number): void {
    if (estimatedCredits > this.remaining) {
      throw new CreditBudgetExceededError(estimatedCredits, this.remaining);
    }
  }

  /** Call *after* a paid request, with the actual number of billed results. */
  record(label: string, credits: number): CreditEntry {
    const entry: CreditEntry = { label, credits, at: Date.now() };
    this.entries.push(entry);
    return entry;
  }

  history(): readonly CreditEntry[] {
    return this.entries;
  }
}

export function aiSearchCost(profileCount: number): number {
  return Number((profileCount * CREDITS_PER_AI_SEARCH_PROFILE).toFixed(4));
}
