import type * as z from 'zod';

import type { CreditLedger, RawRequestLedger } from './budget.js';
import { assertNotAnError, ModashApiError } from './errors.js';
import {
  AI_SEARCH_INTERVAL_MS,
  backoffDelayMs,
  DISCOVERY_INTERVAL_MS,
  RATE_LIMITED_CODE,
  RAW_INTERVAL_MS,
  RateLimiter,
  sleep,
} from './rate-limit.js';
import type { ModashHttpRequest, ModashTransport } from './transport.js';

const MAX_ATTEMPTS = 3;

export interface ModashCall<T> {
  request: ModashHttpRequest;
  schema: z.ZodType<T>;
  /**
   * Discovery credits this call spends, computed from the request before it is sent. Zero for the
   * free endpoints. **Not billed if the call fails**, so it is recorded only on success.
   */
  cost?: number;
  /**
   * RAW API requests this call spends, drawn from a separate allowance. **Billed even if the call
   * fails**, so it is recorded either way. See `raw.ts` for why these are two fields and not one.
   */
  rawRequests?: number;
  /** Recorded in the ledger so `modash://budget` can show where the money went. */
  tool: string;
  detail: string;
  /** Each product and endpoint family gets its own limit. */
  queue?: 'discovery' | 'ai-search' | 'raw';
}

export interface Meters {
  credits: CreditLedger;
  rawRequests: RawRequestLedger;
}

/**
 * Every Modash request in this server goes through `call`, in this order:
 *
 *   1. refuse the call if it would breach the relevant session budget
 *   2. wait for a slot in the relevant rate-limit queue
 *   3. send it, retrying 429s and 5xx with backoff
 *   4. reject the response if it carries an error, whatever the HTTP status said
 *   5. parse it against a deliberately permissive schema
 *   6. record what it spent
 *
 * The ordering is the point. Steps 1 and 6 bracket the request so an overspend is prevented rather
 * than reported. What step 6 records depends on which product was called: a failed Discovery call
 * costs nothing and never reaches the ledger, while a failed RAW request is billed anyway and is
 * recorded before the error is rethrown.
 *
 * That asymmetry also changes what a retry means. Retrying Discovery is free. Retrying RAW is not,
 * which is why `MAX_ATTEMPTS` applies to both but only ever fires on a `429` or a `5xx` — the
 * cases where the request did not produce an answer.
 */
export class ModashClient {
  readonly #queues = {
    discovery: new RateLimiter(DISCOVERY_INTERVAL_MS),
    'ai-search': new RateLimiter(AI_SEARCH_INTERVAL_MS),
    raw: new RateLimiter(RAW_INTERVAL_MS),
  } as const;

  constructor(
    private readonly transport: ModashTransport,
    readonly meters: Meters,
  ) {}

  /** Kept for the Discovery code and the tests, which only ever look at credits. */
  get ledger(): CreditLedger {
    return this.meters.credits;
  }

  async call<T>({
    request,
    schema,
    cost = 0,
    rawRequests = 0,
    tool,
    detail,
    queue = 'discovery',
  }: ModashCall<T>): Promise<T> {
    // Taken synchronously, before anything is in flight, so a concurrent call sees the hold.
    const hold = this.meters.credits.reserve(cost);
    // RAW has no hold to take: it is charged at the moment each attempt goes out, below.
    this.meters.rawRequests.assertAffordable(rawRequests);

    try {
      const response = await this.#sendWithRetries(request, queue, { rawRequests, tool, detail });
      assertNotAnError(response.status, response.body);

      const parsed = schema.safeParse(response.body);
      if (!parsed.success) {
        // Because response schemas are permissive, reaching here means a field we actually read
        // came back as the wrong type — worth failing loudly on rather than passing junk to a model.
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        throw new Error(`Unexpected response shape from ${request.path}. ${issues}`);
      }

      // RAW spend is recorded attempt-by-attempt above. Committing a zero-credit hold would count
      // the success as a free Discovery call and inflate `freeCalls` on the credit ledger.
      if (rawRequests > 0) {
        hold.release();
      } else {
        hold.commit(tool, detail);
      }
      return parsed.data;
    } catch (error) {
      // Discovery does not bill a failure, so the hold goes back untouched. Anything RAW spent on
      // the way here has already been recorded, attempt by attempt.
      hold.release();
      throw error;
    }
  }

  async #sendWithRetries(
    request: ModashHttpRequest,
    queue: 'discovery' | 'ai-search' | 'raw',
    raw: { rawRequests: number; tool: string; detail: string },
  ) {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      /**
       * Every RAW attempt is billed, including the retried ones, so the ceiling has to be checked
       * again before each. Checking once for a single request and then retrying twice would let a
       * burst of 429s spend three times what the guard approved.
       *
       * The check and the charge both happen inside the queued task. The queue runs one task at a
       * time, which is what makes that pair atomic against other RAW calls — the same problem the
       * credit reservation solves for Discovery, solved here by the serialisation that already
       * exists for the rate limit.
       */
      const response = await this.#queues[queue].run(async () => {
        if (raw.rawRequests > 0) {
          try {
            this.meters.rawRequests.assertAffordable(raw.rawRequests);
          } catch (error) {
            // On the first attempt the caller wants to know why. Out of budget part-way through a
            // retry, stop quietly and let the error that caused the retry stand.
            if (attempt === 0) throw error;
            return undefined;
          }
        }

        const result = await this.transport.send(request);

        if (raw.rawRequests > 0) {
          const failed = result.status < 200 || result.status >= 300;
          this.meters.rawRequests.record(
            raw.tool,
            failed ? `${raw.detail} (failed)` : raw.detail,
            raw.rawRequests,
          );
        }

        return result;
      });

      if (response === undefined) break;

      // Rate limiting is normal operation on this API rather than a failure, so it is retried
      // here instead of being reported to the caller.
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) return response;

      lastError = new ModashApiError(
        `Request to ${request.path} failed with HTTP ${response.status}`,
        response.status,
        response.status === 429 ? RATE_LIMITED_CODE : undefined,
      );

      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(response.retryAfterMs ?? backoffDelayMs(attempt));
      }
    }

    throw lastError ?? new Error(`Request to ${request.path} was abandoned before it completed.`);
  }
}
