/**
 * A small, dependency-free HTTP client for the Modash API.
 *
 * It exists mainly to encapsulate the three things every Modash integration
 * eventually needs:
 *
 *  1. Bearer auth against https://api.modash.io/v1
 *  2. Rate limiting. AI Search endpoints are capped at 1 request/second by
 *     default, so requests are serialised through a queue rather than fired in
 *     parallel. Higher limits are available on request.
 *  3. Retries. `429` and `5xx` are transient and, per the API docs, failed
 *     requests are not billed — so retrying them is free and safe.
 *
 * Docs: https://docs.modash.io
 */

export const MODASH_API_BASE_URL = 'https://api.modash.io/v1';

/** Error codes documented at https://docs.modash.io. Branch on these, never on `message`. */
export type ModashErrorCode =
  | 'api_token_invalid'
  | 'bad_request'
  | 'not_enough_credits'
  | 'feature_not_available'
  | 'no_result'
  | 'page_limit'
  | 'request_timeout'
  | 'internal_server_error'
  | 'rate_limited'
  | (string & {});

export class ModashApiError extends Error {
  constructor(
    readonly code: ModashErrorCode,
    readonly status: number,
    message: string,
    /** From the `Retry-After` header, when the API tells us how long to wait. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ModashApiError';
  }

  get isTransient(): boolean {
    return this.status === 429 || this.status >= 500 || this.code === 'request_timeout';
  }

  /** A message that is safe and useful to show an end user. */
  get userFacingMessage(): string {
    switch (this.code) {
      case 'api_token_invalid':
        return 'The Modash API token was rejected. Check MODASH_API_TOKEN against https://marketer.modash.io/developer.';
      case 'not_enough_credits':
        return 'This Modash account is out of credits. Top up or wait for the monthly reset.';
      case 'feature_not_available':
        return 'This endpoint is not enabled for this Modash account. AI Search requires Discovery API access.';
      case 'no_result':
        return 'No creators matched those filters. Try loosening them.';
      case 'page_limit':
        return 'Pagination depth limit reached for this search (max 1500 results).';
      default:
        return this.message;
    }
  }
}

export interface ModashClientOptions {
  token: string;
  baseUrl?: string;
  /**
   * Minimum gap between requests. Defaults to 1100ms because AI Search is
   * limited to 1 RPS and we'd rather queue than eat a 429.
   */
  minRequestIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  /** Called once per completed request. Handy for logging and cost tracking. */
  onRequest?: (info: {
    method: string;
    path: string;
    status: number;
    durationMs: number;
    attempts: number;
  }) => void;
}

type QueryValue = string | number | boolean | undefined;

export class ModashClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly minRequestIntervalMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly onRequest: ModashClientOptions['onRequest'];

  /** Tail of the serial request queue. Every request chains onto this. */
  private tail: Promise<void> = Promise.resolve();
  private lastRequestStartedAt = 0;

  constructor(options: ModashClientOptions) {
    if (!options.token) {
      throw new Error('A Modash API token is required. Get one at https://marketer.modash.io/developer');
    }
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? MODASH_API_BASE_URL;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 1_100;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.onRequest = options.onRequest;
  }

  get(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal): Promise<unknown> {
    return this.enqueue('GET', buildPath(path, query), undefined, signal);
  }

  post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.enqueue('POST', path, body, signal);
  }

  /**
   * Chains a request onto the serial queue so we never exceed 1 RPS, regardless
   * of how many callers are in flight.
   */
  private enqueue(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = this.tail.then(() => this.requestWithRetries(method, path, body, signal));
    // Keep the queue alive even if this request rejects.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async requestWithRetries(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      await this.respectRateLimit(signal);

      const startedAt = Date.now();
      try {
        const { payload, status } = await this.request(method, path, body, signal);
        this.onRequest?.({
          method,
          path,
          status,
          durationMs: Date.now() - startedAt,
          attempts: attempt,
        });
        return payload;
      } catch (error) {
        lastError = error;

        const retryable = error instanceof ModashApiError && error.isTransient;
        if (!retryable || attempt > this.maxRetries || signal?.aborted) break;

        // Prefer the server's own answer. Account-wide limits can be far tighter
        // than the per-endpoint ones — low single digits per minute on some plans —
        // and no exponential backoff starting at 1s will ride that out.
        const backoffMs =
          error.retryAfterMs ?? 2 ** (attempt - 1) * 1_000 + Math.random() * 250;
        await sleep(backoffMs, signal);
      }
    }

    throw lastError;
  }

  private async respectRateLimit(signal?: AbortSignal): Promise<void> {
    const waitMs = this.lastRequestStartedAt + this.minRequestIntervalMs - Date.now();
    if (waitMs > 0) await sleep(waitMs, signal);
    this.lastRequestStartedAt = Date.now();
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ payload: unknown; status: number }> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: combined,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ModashApiError('request_timeout', 408, `Request to ${path} failed: ${describe(error)}`);
    }

    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      throw toApiError(response.status, payload, response.headers.get('retry-after'));
    }

    // Some endpoints return HTTP 200 with `error: true` in the body.
    if (isRecord(payload) && payload.error === true) {
      throw toApiError(response.status, payload);
    }

    return { payload, status: response.status };
  }
}

function toApiError(status: number, payload: unknown, retryAfter?: string | null): ModashApiError {
  const code = isRecord(payload) && typeof payload.code === 'string' ? payload.code : undefined;
  const message = isRecord(payload) && typeof payload.message === 'string' ? payload.message : undefined;

  return new ModashApiError(
    code ?? (status === 429 ? 'rate_limited' : `http_${status}`),
    status,
    message ?? `Modash API responded with HTTP ${status}`,
    parseRetryAfter(retryAfter),
  );
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function buildPath(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
