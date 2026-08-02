/**
 * HTTP-level check: the Express route really streams a UI message stream that
 * `useChat` can consume, including the custom `data-search` parts.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { createApp } from './app';
import { createMockApi } from './modash/mock';
import { scriptedSearchModel, SCRIPTED_SUMMARY } from './testing/scripted-model';

const server = createApp(createMockApi(), { model: scriptedSearchModel() }).listen(0);
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}`;

after(() => {
  server.close();
});

test('GET /api/config reports mock mode', async () => {
  const response = await fetch(`${baseUrl}/api/config`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()) as Record<string, unknown>, {
    mock: true,
    creditBudget: 5,
    maxPageSize: 20,
  });
});

test('POST /api/chat rejects a malformed body', async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nope: true }),
  });
  assert.equal(response.status, 400);
});

test('POST /api/chat streams text and search data parts', async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Find sleep-routine creators on Instagram.' }],
        },
      ],
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

  const body = await response.text();
  assert.match(body, /"type":"data-search"/);
  assert.match(body, /"status":"complete"/);
  assert.match(body, /"type":"data-usage"/);
  assert.ok(body.includes(SCRIPTED_SUMMARY), 'expected the assistant summary in the stream');
});
