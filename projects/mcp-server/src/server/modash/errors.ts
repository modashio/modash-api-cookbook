import * as z from 'zod';

/**
 * The documented error envelope is `{ error: true, code, message }`, and the docs are explicit
 * that you should branch on `code` because messages change without notice.
 *
 * Two undocumented variations show up in practice and will crash a strict parser:
 *
 *  1. `message` is sometimes an array of validation strings rather than one string. This is the
 *     norm for `invalid_body_params`.
 *  2. Some framework-level errors carry no `code` at all, just `statusCode`. For example
 *     `GET /ai/mentions?platform=youtube` returns
 *     `{"message":"Mentions dictionary is not supported for YouTube","error":true,"statusCode":400}`.
 *
 * So every field is optional and the shape stays loose.
 */
const errorEnvelopeSchema = z.looseObject({
  error: z.boolean().optional(),
  code: z.string().optional(),
  message: z.union([z.string(), z.array(z.string())]).optional(),
  statusCode: z.number().optional(),
});

/** Error codes worth branching on. The full table is on https://docs.modash.io. */
export const MODASH_ERROR_CODES = [
  'api_token_invalid',
  'bad_request',
  'handle_not_found',
  'account_not_found',
  'posts_not_found',
  'account_removed',
  'media_not_found',
  'entity_not_found',
  'private_account',
  'empty_audience',
  'retry_later',
  'not_enough_credits',
  'internal_server_error',
  'request_timeout',
  'client_error',
  'invalid_body_params',
  'feature_not_available',
  'no_result',
  'page_limit',
] as const;

export type ModashErrorCode = (typeof MODASH_ERROR_CODES)[number];

export class ModashApiError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
    /** Undefined for the framework-level errors that ship no `code`. Branch on this, not `message`. */
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'ModashApiError';
  }

  /** True for the failures that are worth trying again rather than reporting to the user. */
  get isRetryable(): boolean {
    return (
      this.status === 429 ||
      this.status >= 500 ||
      this.code === 'internal_server_error' ||
      this.code === 'request_timeout'
    );
  }

  /** What the model should read. Includes the code so it can react without parsing prose. */
  toToolMessage(): string {
    const prefix = this.code ? `Modash error ${this.code} (HTTP ${this.status})` : `Modash error (HTTP ${this.status})`;
    return `${prefix}: ${this.message}`;
  }
}

/** Raised locally, before anything is sent, when a call would breach a session budget. */
export class CreditBudgetExceededError extends Error {
  constructor(
    readonly requested: number,
    readonly spent: number,
    readonly budget: number,
    remaining: number,
    /** Credits held by calls that are still in flight and have not been billed yet. */
    reserved = 0,
  ) {
    // Without naming the held credits, a refusal caused entirely by calls still in flight reads as
    // "only 0 of 2 left (0 already spent)", which invites a model to retry immediately.
    const accounting =
      reserved > 0
        ? `${spent} already spent, ${reserved} held by calls still in flight`
        : `${spent} already spent`;

    super(
      `This call would cost about ${requested} ${requested === 1 ? 'credit' : 'credits'}, but only ` +
        `${remaining} of the ${budget}-credit session budget is left (${accounting}). Raise ` +
        `MODASH_CREDIT_BUDGET if you meant to spend more.`,
    );
    this.name = 'CreditBudgetExceededError';
  }
}

/**
 * Turns any non-2xx body — or a 2xx body that admits an error — into a `ModashApiError`.
 *
 * The second case is the reason this takes the body rather than just the status. Nearly every 200
 * response schema in the spec declares an `error: boolean` field, so a successful status does not
 * on its own prove success. Checking the flag costs one branch and closes the gap.
 */
export function assertNotAnError(status: number, body: unknown): void {
  const envelope = errorEnvelopeSchema.safeParse(body);
  const failed = status < 200 || status >= 300 || envelope.data?.error === true;
  if (!failed) return;

  const raw = envelope.data?.message;
  const message = Array.isArray(raw) ? raw.join('; ') : (raw ?? `Request failed with HTTP ${status}`);

  throw new ModashApiError(message, envelope.data?.statusCode ?? status, envelope.data?.code);
}

/**
 * The RAW equivalent. Separate from the credit budget because it guards a separate allowance,
 * counted in requests rather than credits.
 */
export class RawBudgetExceededError extends Error {
  constructor(
    readonly requested: number,
    readonly spent: number,
    readonly budget: number,
    remaining: number,
  ) {
    super(
      `This call needs ${requested} RAW ${requested === 1 ? 'request' : 'requests'}, but only ` +
        `${remaining} of the ${budget}-request session budget is left (${spent} already used). ` +
        `RAW requests are billed even when a call ` +
        `fails, so this counts attempts. Raise MODASH_RAW_BUDGET if you meant to spend more.`,
    );
    this.name = 'RawBudgetExceededError';
  }
}
