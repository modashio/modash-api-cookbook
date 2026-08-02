/**
 * A serial queue that starts at most one request per `minIntervalMs`.
 *
 * AI Search defaults to 1 request per second, which is low enough that an agent firing three
 * searches to compare phrasings will trip it. The queue makes that impossible by construction
 * rather than relying on the retry path to clean up afterwards. Higher AI Search limits are
 * available on request; raise `AI_SEARCH_INTERVAL_MS` if yours has been raised.
 *
 * The rest of Discovery is limited per account rather than per endpoint. `GET /user/info` reports
 * your actual limit in `rateLimits.discoveryRatelimit`; the default below is deliberately modest.
 */
export const AI_SEARCH_INTERVAL_MS = 1_000;
export const DISCOVERY_INTERVAL_MS = 500;

/**
 * The RAW API has its own account-wide limit, reported separately as `rateLimits.rawRatelimit`.
 * It gets its own queue so a burst of RAW calls cannot eat the Discovery allowance, or vice versa.
 */
export const RAW_INTERVAL_MS = 500;

/** Not one of Modash's documented codes — this server's own label for an HTTP 429. */
export const RATE_LIMITED_CODE = 'rate_limited';

export class RateLimiter {
  #tail: Promise<unknown> = Promise.resolve();
  #nextSlotAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  /** Queues `task`, running it no sooner than `minIntervalMs` after the previous one started. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const scheduled = this.#tail.then(async () => {
      const wait = this.#nextSlotAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.#nextSlotAt = Date.now() + this.minIntervalMs;
      return task();
    });

    // Keep the chain alive after a rejection, or one failed call would stall every later one.
    this.#tail = scheduled.catch(() => undefined);
    return scheduled;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter, so a burst of retries does not resynchronise into a new burst. */
export function backoffDelayMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return Math.round(base * (0.5 + Math.random() / 2));
}
