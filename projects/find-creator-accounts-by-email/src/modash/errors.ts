import { round2 } from '../numbers.js';

/** Codes after which every later call fails too, so a run should stop rather than log each one. */
const FATAL_CODES = new Set(['api_token_invalid', 'not_enough_credits', 'unexpected_response']);

export class ModashApiError extends Error {
  constructor(
    path: string,
    readonly status: number,
    /** Branch on this, not on `message`: Modash changes messages without notice. */
    readonly code: string | undefined,
    detail: string,
  ) {
    super(`${path}: HTTP ${status}${code ? ` ${code}` : ''}${detail ? ` ${detail}` : ''}`);
    this.name = 'ModashApiError';
  }

  get isFatal(): boolean {
    return this.status === 401 || this.status === 403 || (this.code !== undefined && FATAL_CODES.has(this.code));
  }
}

/** The request was sent and no answer came back: a timeout or a dropped connection. The API may still have run it. */
export class NoAnswerError extends Error {
  constructor(path: string, cause: unknown) {
    super(`${path}: no answer (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
    this.name = 'NoAnswerError';
  }
}

export class CreditBudgetExceededError extends Error {
  constructor(budget: number, spent: number) {
    super(
      `the next call could take this run over its budget of ${budget} credits (spent or held ${round2(spent)}). ` +
        'Raise --max-credits or MODASH_CREDIT_BUDGET, or lower --batch-size, to go on.',
    );
    this.name = 'CreditBudgetExceededError';
  }
}

/** Mock mode was asked for a call this project does not make. This is a bug, not an API answer, so nothing catches it. */
export class MockDataMissingError extends Error {
  constructor(call: string) {
    super(`the mock data has no answer for "${call}"`);
    this.name = 'MockDataMissingError';
  }
}

export function stopsTheRun(error: unknown): error is CreditBudgetExceededError | ModashApiError {
  return error instanceof CreditBudgetExceededError || (error instanceof ModashApiError && error.isFatal);
}
