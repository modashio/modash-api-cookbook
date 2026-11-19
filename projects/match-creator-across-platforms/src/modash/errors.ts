import { round2 } from '../numbers.js';

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

/** Mock mode asked for an answer the fixtures do not have. This is a bug, not an API answer, so nothing catches it. */
export class MockDataMissingError extends Error {
  constructor(key: string) {
    super(`the mock data has no answer for "${key}"`);
    this.name = 'MockDataMissingError';
  }
}

export function stopsTheRun(error: unknown): error is CreditBudgetExceededError | ModashApiError {
  return error instanceof CreditBudgetExceededError || (error instanceof ModashApiError && error.isFatal);
}
