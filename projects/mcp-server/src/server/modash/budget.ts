import { CreditBudgetExceededError, RawBudgetExceededError } from './errors.js';
import { roundCredits } from './pricing.js';

export interface LedgerEntry {
  at: string;
  tool: string;
  detail: string;
  /** Credits for Discovery, requests for RAW. The two ledgers count different things. */
  amount: number;
}

export interface BudgetSummary {
  budget: number;
  spent: number;
  remaining: number;
  paidCalls: number;
  freeCalls: number;
  entries: LedgerEntry[];
}

/**
 * A running total of what this process has spent, plus a hard ceiling.
 *
 * The ceiling is checked *before* the request goes out, using the cost we can compute from the
 * request itself. Checking afterwards would tell you about an overspend you had already committed
 * to — and the failure mode this guards against is an agent that decides to paginate.
 *
 * Failed requests are not billed by Modash (5xx, timeouts and 4xx alike), so nothing is recorded
 * unless the call came back successfully.
 */
/**
 * A hold on part of the budget, taken before a request goes out and settled after it comes back.
 */
export interface Reservation {
  /** The request succeeded and was billed: turn the hold into recorded spend. */
  commit(tool: string, detail: string): void;
  /** The request failed and was not billed: give the hold back. */
  release(): void;
}

export class CreditLedger {
  #spent = 0;
  #reserved = 0;
  #freeCalls = 0;
  readonly #entries: LedgerEntry[] = [];

  constructor(readonly budget: number) {}

  get spent(): number {
    return roundCredits(this.#spent);
  }

  /** What is left to promise, which is the budget minus both spent and in-flight credits. */
  get remaining(): number {
    return roundCredits(Math.max(0, this.budget - this.#spent - this.#reserved));
  }

  /**
   * Takes a hold on `credits`, or throws if the budget cannot cover it.
   *
   * Checking and recording separately is not enough here. A request is in flight for hundreds of
   * milliseconds, and an MCP server is asked for several tools at once all the time — two parallel
   * calls would both check against the same `spent`, both pass, both succeed, and only then both
   * record, landing the session over its ceiling. Reserving up front closes that window, because
   * the hold is taken synchronously and is visible to the next caller immediately.
   */
  reserve(credits: number): Reservation {
    this.assertAffordable(credits);
    if (credits > 0) this.#reserved += credits;

    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      if (credits > 0) this.#reserved -= credits;
      return true;
    };

    return {
      commit: (tool, detail) => {
        if (settle()) this.record(tool, detail, credits);
      },
      release: () => {
        settle();
      },
    };
  }

  /** Throws `CreditBudgetExceededError` if this call would breach the budget. Call before sending. */
  assertAffordable(credits: number): void {
    if (credits <= 0) return;
    if (this.#spent + this.#reserved + credits > this.budget) {
      throw new CreditBudgetExceededError(
        roundCredits(credits),
        this.spent,
        this.budget,
        this.remaining,
        roundCredits(this.#reserved),
      );
    }
  }

  /** Record a call that actually completed. Free calls are counted but do not move the total. */
  record(tool: string, detail: string, credits: number): void {
    if (credits <= 0) {
      this.#freeCalls += 1;
      return;
    }
    this.#spent += credits;
    this.#entries.push({
      at: new Date().toISOString(),
      tool,
      detail,
      amount: roundCredits(credits),
    });
  }

  summary(): BudgetSummary {
    return {
      budget: this.budget,
      spent: this.spent,
      remaining: this.remaining,
      paidCalls: this.#entries.length,
      freeCalls: this.#freeCalls,
      entries: [...this.#entries],
    };
  }
}

/**
 * The same idea for the RAW API, which meters in requests rather than credits.
 *
 * One difference, and it is the whole reason this is a separate class rather than a `CreditLedger`
 * with a different unit: **a failed RAW request is still billed.** Discovery does not charge for a
 * `4xx` or a `5xx`, so `CreditLedger` only records successes and retrying is free. RAW charges for
 * the attempt, so this records the attempt — a malformed URL a model guessed at costs the same as
 * a good one, and a retry loop spends real allowance.
 */
export class RawRequestLedger {
  #spent = 0;
  readonly #entries: LedgerEntry[] = [];

  constructor(readonly budget: number) {}

  get spent(): number {
    return this.#spent;
  }

  get remaining(): number {
    return Math.max(0, this.budget - this.#spent);
  }

  assertAffordable(requests: number): void {
    if (requests <= 0) return;
    if (this.#spent + requests > this.budget) {
      throw new RawBudgetExceededError(requests, this.#spent, this.budget, this.remaining);
    }
  }

  /** Call this whether or not the request succeeded. That is the point. */
  record(tool: string, detail: string, requests: number): void {
    if (requests <= 0) return;
    this.#spent += requests;
    this.#entries.push({ at: new Date().toISOString(), tool, detail, amount: requests });
  }

  summary(): Omit<BudgetSummary, 'freeCalls' | 'paidCalls'> & { calls: number } {
    return {
      budget: this.budget,
      spent: this.spent,
      remaining: this.remaining,
      calls: this.#entries.length,
      entries: [...this.#entries],
    };
  }
}
