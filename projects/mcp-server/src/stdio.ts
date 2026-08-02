#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config.js';
import { createToolContext } from './mcp/context.js';
import { createMcpServer } from './mcp/server.js';

/**
 * The stdio transport: how desktop MCP clients (Claude Desktop, Cursor, and friends) run a server.
 * The client spawns this process and talks JSON-RPC over its stdin and stdout.
 *
 * Which is why every message below goes to **stderr**. A single `console.log` writes into the
 * protocol stream and breaks the connection, and the resulting error says nothing about what you
 * did. See the README for the client configuration block.
 */
const config = loadConfig();
const ctx = createToolContext(config);

const handle = serveStdio(() => createMcpServer(ctx));

console.error(
  `modash MCP server ready on stdio (${config.mock ? 'mock mode, no credits will be spent' : 'live'}, ` +
    `budget ${config.creditBudget} credits)`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
