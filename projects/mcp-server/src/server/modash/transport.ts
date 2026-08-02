export interface ModashHttpRequest {
  method: 'GET' | 'POST';
  /** Path relative to the API base URL, e.g. `/instagram/search`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface ModashHttpResponse {
  status: number;
  body: unknown;
  /** Parsed from the `Retry-After` header when the API asks us to wait. */
  retryAfterMs?: number;
}

/**
 * The seam between "which endpoint am I calling" and "how does the request get there".
 *
 * Mock mode implements this interface rather than stubbing the client, so fixtures travel the same
 * error checking, schema parsing and cost accounting as live responses. A mock that short-circuits
 * those is a mock that stops catching the bugs you wrote it for.
 */
export interface ModashTransport {
  send(request: ModashHttpRequest): Promise<ModashHttpResponse>;
}

export class HttpTransport implements ModashTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
  ) {}

  async send({ method, path, query, body }: ModashHttpRequest): Promise<ModashHttpResponse> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method,
      headers: {
        // The token also works as a query or body parameter, but that leaks it into access logs
        // and proxies. Always send the header.
        Authorization: `Bearer ${this.apiToken}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return {
      status: response.status,
      body: await readJson(response),
      ...parseRetryAfter(response.headers.get('retry-after')),
    };
  }
}

/** A 5xx from a proxy in front of the API can be HTML, so never assume the body parses. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: true, message: text.slice(0, 500) };
  }
}

function parseRetryAfter(header: string | null): { retryAfterMs?: number } {
  if (header === null) return {};
  const seconds = Number(header);
  return Number.isFinite(seconds) ? { retryAfterMs: seconds * 1000 } : {};
}
