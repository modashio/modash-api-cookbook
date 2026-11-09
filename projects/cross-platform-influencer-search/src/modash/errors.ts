/** Codes after which every later call fails too, so a batch should stop rather than log each one. */
const FATAL_CODES = new Set(['api_token_invalid', 'not_enough_credits']);

export class ModashApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    /** Branch on this, not on `message`: Modash changes messages without notice. */
    readonly code: string | undefined,
    detail: string,
  ) {
    super(`${path}: HTTP ${status}${code ? ` ${code}` : ''}${detail ? ` ${detail}` : ''}`);
    this.name = 'ModashApiError';
  }

  get isFatal(): boolean {
    return this.status === 401 || (this.code !== undefined && FATAL_CODES.has(this.code));
  }
}

export class CreditBudgetExceededError extends Error {
  constructor(budget: number, spent: number) {
    super(
      `the next call could take this run over its budget of ${budget} credits (spent ${round2(spent)}). ` +
        'Raise --max-credits or MODASH_CREDIT_BUDGET to go on.',
    );
    this.name = 'CreditBudgetExceededError';
  }
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;
