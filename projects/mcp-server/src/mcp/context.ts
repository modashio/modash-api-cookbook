import type { Config } from '../config.js';
import { CreditLedger, RawRequestLedger } from '../server/modash/budget.js';
import { ModashClient } from '../server/modash/client.js';
import { MockTransport } from '../server/modash/mock.js';
import { HttpTransport, type ModashTransport } from '../server/modash/transport.js';

export interface ToolContext {
  client: ModashClient;
  ledger: CreditLedger;
  rawLedger: RawRequestLedger;
  mock: boolean;
  /** Whether to register the RAW API tools. RAW is a separate product from Discovery. */
  raw: boolean;
}

/**
 * One set of meters per process, shared by every connection.
 *
 * The Streamable HTTP transport builds a fresh `McpServer` for each request, so anything held on
 * the server instance would reset constantly and the budgets would never bind. They have to
 * outlive the request, which is why they are created here and closed over.
 */
export function createToolContext(config: Config): ToolContext {
  const transport: ModashTransport = config.mock
    ? new MockTransport()
    : new HttpTransport(config.baseUrl, config.apiToken!);

  const ledger = new CreditLedger(config.creditBudget);
  const rawLedger = new RawRequestLedger(config.rawBudget);

  return {
    client: new ModashClient(transport, { credits: ledger, rawRequests: rawLedger }),
    ledger,
    rawLedger,
    mock: config.mock,
    raw: config.raw,
  };
}
