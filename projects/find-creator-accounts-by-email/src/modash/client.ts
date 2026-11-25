import type * as z from 'zod';

import { CreditBudgetExceededError, ModashApiError, NoAnswerError } from './errors.js';

export interface ModashRequest {
  path: string;
  body: unknown;
}

export interface ModashResponse {
  status: number;
  body: unknown;
}

export type Transport = (request: ModashRequest) => Promise<ModashResponse>;

const BASE_URL = 'https://api.modash.io/v1';

/** The URL a live run sends the request to. */
export const requestUrl = ({ path }: ModashRequest): URL => new URL(`${BASE_URL}/${path}`);

export function liveTransport(token: string): Transport {
  return async (request) => {
    let status: number;
    let text: string;
    try {
      const response = await fetch(requestUrl(request), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(60_000),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw new NoAnswerError(request.path, error);
    }
    try {
      return { status, body: JSON.parse(text) };
    } catch {
      // A gateway or proxy page. It is not an answer, so `call` reports it as an error.
      return { status, body: { error: true, code: 'not_json', message: text.slice(0, 300) } };
    }
  };
}

interface ClientOptions {
  /** The most credits this client may spend. */
  budget: number;
  /** Pause after each call, to space calls out. */
  pauseMs?: number;
  /** First retry wait; later retries wait 2x, 3x, 4x this. */
  retryDelayMs?: number;
  /** Told about each call that got an answer, with the credits it cost. */
  onCall?: (request: ModashRequest, credits: number) => void;
}

interface CallCost<T> {
  /** The most this call can cost, held against the budget before it is sent. */
  max: number;
  /** What it actually cost, read from the response. */
  actual: (data: T) => number;
}

const ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every call this project makes is paid, so the client never sends one twice unless the API refused it with a 429. */
export class ModashClient {
  /** Credits counted against the budget: what answered calls cost, plus `unconfirmed`. */
  spent = 0;
  /** The part of `spent` held for calls with no clear answer yet, or ever. They may or may not have been billed. */
  unconfirmed = 0;
  readonly #budget: number;
  readonly #pauseMs: number;
  readonly #retryDelayMs: number;
  readonly #onCall: ClientOptions['onCall'];

  constructor(
    private readonly transport: Transport,
    options: ClientOptions,
  ) {
    this.#budget = options.budget;
    this.#pauseMs = options.pauseMs ?? 600;
    this.#retryDelayMs = options.retryDelayMs ?? 3_000;
    this.#onCall = options.onCall;
  }

  async call<T>(request: ModashRequest, schema: z.ZodType<T>, cost: CallCost<T>): Promise<T> {
    if (this.spent + cost.max > this.#budget + 1e-9) {
      throw new CreditBudgetExceededError(this.#budget, this.spent);
    }
    // The hold is unconfirmed until an answer says what the call cost, so a run stopped mid-call reports it as such.
    this.spent += cost.max;
    this.unconfirmed += cost.max;
    try {
      const data = await this.#answer(request, schema);
      const charged = Math.min(cost.actual(data), cost.max);
      this.spent -= cost.max - charged;
      this.unconfirmed -= cost.max;
      this.#onCall?.(request, charged);
      return data;
    } catch (error) {
      // A 4xx is a refusal, so it releases the hold. Anything else may follow a call that ran, so the hold stays.
      if (error instanceof ModashApiError && error.status >= 400 && error.status < 500) {
        this.spent -= cost.max;
        this.unconfirmed -= cost.max;
      }
      throw error;
    } finally {
      if (this.#pauseMs > 0) {
        await sleep(this.#pauseMs);
      }
    }
  }

  async #answer<T>(request: ModashRequest, schema: z.ZodType<T>): Promise<T> {
    const response = await this.#send(request);
    const body = response.body as { error?: unknown; code?: unknown; message?: unknown } | null;
    if (response.status >= 400 || typeof body !== 'object' || body === null || body.error === true) {
      const code = typeof body?.code === 'string' ? body.code : undefined;
      const message = Array.isArray(body?.message) ? body.message.join('; ') : String(body?.message ?? '');
      throw new ModashApiError(request.path, response.status, code, message);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      throw new ModashApiError(request.path, response.status, 'unexpected_response', issues);
    }
    return parsed.data;
  }

  /** Sends the call. Only a 429 is tried again: this project treats it as a refusal to run the call. */
  async #send(request: ModashRequest): Promise<ModashResponse> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await this.transport(request);
      if (response.status !== 429 || attempt === ATTEMPTS) {
        return response;
      }
      await sleep(this.#retryDelayMs * attempt);
    }
  }
}
