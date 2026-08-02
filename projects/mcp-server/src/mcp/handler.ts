import { createMcpHandler as createSdkHandler } from '@modelcontextprotocol/server';

import type { Config } from '../config.js';
import { createToolContext } from './context.js';
import { createMcpServer } from './server.js';

/**
 * Builds the request handler that both `src/http.ts` and the tests use.
 *
 * The SDK calls the factory once per request and throws the resulting server away, which is what
 * lets the same process serve any number of clients with no session state to keep straight. The
 * tool context is created once, outside the factory, because the credit ledger has to survive
 * between requests — a budget that resets every request is not a budget.
 */
export function createMcpHandler(config: Config) {
  const ctx = createToolContext(config);
  return createSdkHandler(() => createMcpServer(ctx));
}
