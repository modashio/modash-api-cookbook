import type * as z from 'zod';

import { CreditBudgetExceededError, ModashApiError } from './errors.js';

export interface ModashRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface ModashResponse {
  status: number;
  body: unknown;
}

export type Transport = (request: ModashRequest) => Promise<ModashResponse>;

const BASE_URL = 'https://api.modash.io/v1';

export function liveTransport(token: string): Transport {
  return async ({ method, path, query, body }) => {
    const url = new URL(`${BASE_URL}/${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    return { status: response.status, body: parsed };
  };
}

export interface ClientOptions {
  budget?: number | undefined;
  /** Pause after each successful call, to stay under about 2 calls a second. */
  pauseMs?: number;
  /** First retry wait; later retries wait 2x, 3x, 4x this. */
  retryDelayMs?: number;
}

export interface CallCost<T> {
  /** The most this call can cost, held against the budget before it is sent. */
  max: number;
  /** What it actually cost, read from the response. Defaults to `max`. */
  actual?: (data: T) => number;
}

const ATTEMPTS = 5;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Node's fetch reports a dropped connection as TypeError('fetch failed') and a timeout as a
// TimeoutError. Any other TypeError is a bug and should surface on the first attempt.
const isNetworkError = (error: unknown) =>
  (error instanceof TypeError && error.message === 'fetch failed') ||
  (error instanceof DOMException && error.name === 'TimeoutError');

export class ModashClient {
  spent = 0;
  readonly #budget: number | undefined;
  readonly #pauseMs: number;
  readonly #retryDelayMs: number;

  constructor(
    private readonly transport: Transport,
    options: ClientOptions = {},
  ) {
    this.#budget = options.budget;
    this.#pauseMs = options.pauseMs ?? 600;
    this.#retryDelayMs = options.retryDelayMs ?? 3_000;
  }

  async call<T>(request: ModashRequest, schema: z.ZodType<T>, cost: CallCost<T> = { max: 0 }): Promise<T> {
    if (this.#budget !== undefined && this.spent + cost.max > this.#budget + 1e-9) {
      throw new CreditBudgetExceededError(this.#budget, this.spent);
    }
    this.spent += cost.max;
    let response: ModashResponse;
    try {
      response = await this.#send(request);
    } catch (error) {
      this.spent -= cost.max;
      throw error;
    }

    const body = response.body as { error?: unknown; code?: unknown; message?: unknown } | null;
    if (response.status >= 400 || typeof body !== 'object' || body === null || body.error === true) {
      this.spent -= cost.max;
      const code = typeof body?.code === 'string' ? body.code : undefined;
      const message = Array.isArray(body?.message) ? body.message.join('; ') : String(body?.message ?? '');
      throw new ModashApiError(request.path, response.status, code, message);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      // A 200 is billed even when its body is not what we expected, so the hold is kept.
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      throw new ModashApiError(request.path, response.status, 'unexpected_response', issues);
    }
    const actual = cost.actual ? cost.actual(parsed.data) : cost.max;
    this.spent -= cost.max - Math.min(actual, cost.max);
    if (this.#pauseMs > 0) await sleep(this.#pauseMs);
    return parsed.data;
  }

  async #send(request: ModashRequest): Promise<ModashResponse> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await this.transport(request);
        if (!RETRY_STATUSES.has(response.status) || attempt === ATTEMPTS) return response;
      } catch (error) {
        if (!isNetworkError(error) || attempt === ATTEMPTS) throw error;
      }
      await sleep(this.#retryDelayMs * attempt);
    }
  }
}
