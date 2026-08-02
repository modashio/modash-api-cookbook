import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CreditLedger, RawRequestLedger } from '../src/server/modash/budget.js';
import { ModashClient } from '../src/server/modash/client.js';
import { getReport, searchCreators } from '../src/server/modash/endpoints.js';
import {
  HttpTransport,
  type ModashHttpRequest,
  type ModashHttpResponse,
  type ModashTransport,
} from '../src/server/modash/transport.js';

/** Records what was sent so the tests can assert on the request, not just the response. */
class RecordingTransport implements ModashTransport {
  readonly sent: ModashHttpRequest[] = [];

  async send(request: ModashHttpRequest): Promise<ModashHttpResponse> {
    this.sent.push(request);
    return { status: 200, body: { error: false, total: 0, profile: {} } };
  }
}

const build = (budget = 100) => {
  const transport = new RecordingTransport();
  const ledger = new CreditLedger(budget);
  const rawLedger = new RawRequestLedger(50);
  const client = new ModashClient(transport, { credits: ledger, rawRequests: rawLedger });
  return { transport, ledger, rawLedger, client };
};

describe('request shape', () => {
  it('leaves out parameters the caller did not ask for', async () => {
    const { transport, client } = build();
    await getReport(client, { platform: 'instagram', userId: 'example' });
    assert.equal(transport.sent[0]?.query?.['calculationMethod'], undefined);
  });

  it('never puts an undefined parameter in the URL', async () => {
    const requested: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ error: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const transport = new HttpTransport('https://api.invalid/v1', 'placeholder-token');
      await transport.send({
        method: 'GET',
        path: '/instagram/profile/example/report',
        query: { calculationMethod: undefined, limit: 5 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requested[0], 'https://api.invalid/v1/instagram/profile/example/report?limit=5');
  });

  it('passes a calculation method through when one is asked for', async () => {
    const { transport, client } = build();
    await getReport(client, { platform: 'instagram', userId: 'example', calculationMethod: 'average' });
    assert.equal(transport.sent[0]?.query?.['calculationMethod'], 'average');
  });

  it('always sends a filter object, so an unfiltered search matches the documented shape', async () => {
    const { transport, client } = build();
    await searchCreators(client, { platform: 'instagram', filter: undefined });
    assert.deepEqual((transport.sent[0]?.body as { filter: unknown }).filter, {});
  });
});

/**
 * Modash documents two calls that cost nothing: an Instagram search with an empty filter, and the
 * Instagram report for the `instagram` account. Both are how you explore the response shapes
 * without paying, and both are easy to break by accident, so the ledger is asserted directly.
 */
describe('documented free calls', () => {
  it('does not charge for an unfiltered Instagram search', async () => {
    const { ledger, client } = build();
    await searchCreators(client, { platform: 'instagram', filter: {} });
    assert.equal(ledger.spent, 0);
  });

  it('charges for the same search on another platform', async () => {
    const { ledger, client } = build();
    await searchCreators(client, { platform: 'tiktok', filter: {} });
    assert.equal(ledger.spent, 0.15);
  });

  it('charges as soon as the Instagram search has a filter', async () => {
    const { ledger, client } = build();
    await searchCreators(client, {
      platform: 'instagram',
      filter: { influencer: { followers: { min: 1000 } } },
    });
    assert.equal(ledger.spent, 0.15);
  });

  it('does not charge for the Instagram report on the instagram account', async () => {
    const { ledger, client } = build();
    await getReport(client, { platform: 'instagram', userId: 'instagram' });
    assert.equal(ledger.spent, 0);
  });

  it('charges when the free Instagram probe carries a calculationMethod', async () => {
    const { ledger, client } = build();
    await getReport(client, {
      platform: 'instagram',
      userId: 'instagram',
      calculationMethod: 'median',
    });
    assert.equal(ledger.spent, 1);
  });

  it('charges a full credit for any other report', async () => {
    const { ledger, client } = build();
    await getReport(client, { platform: 'instagram', userId: 'someone-else' });
    assert.equal(ledger.spent, 1);
  });
});
