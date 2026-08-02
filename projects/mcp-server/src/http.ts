import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';

import { loadConfig } from './config.js';
import { createMcpHandler } from './mcp/handler.js';

/**
 * The Streamable HTTP transport, for clients that connect over the network rather than by spawning
 * a process. Same tools, same context, different door.
 *
 * `createMcpExpressApp` is the SDK's Express app with JSON parsing and DNS-rebinding protection
 * already wired up — a local MCP endpoint that trusts any `Host` header is reachable from any page
 * the user happens to have open.
 *
 * That check is not a substitute for binding loopback, so this does both: a header is only
 * unforgeable to a browser, and any other client on the network can send `Host: localhost`.
 */
const config = loadConfig();
const handler = createMcpHandler(config);
const app = createMcpExpressApp();

// Express has already drained the body, so hand it to the handler rather than letting it re-read.
const node = toNodeHandler(handler);
app.all('/mcp', (req, res) => void node(req, res, req.body));

app.get('/', (_req, res) => {
  res.json({
    name: 'modash-mcp-server',
    mcpEndpoint: '/mcp',
    mode: config.mock ? 'mock' : 'live',
    creditBudget: config.creditBudget,
  });
});

app.listen(config.port, config.httpHost, () => {
  console.log(
    `modash MCP server listening on http://${config.httpHost}:${config.port}/mcp ` +
      `(${config.mock ? 'mock mode, no credits will be spent' : 'live'}, budget ${config.creditBudget} credits)`,
  );
  if (config.httpHost !== '127.0.0.1' && config.httpHost !== '::1') {
    console.warn(
      `  warning: bound to ${config.httpHost}, not loopback. This endpoint has no authentication ` +
        'and spends your credits — make sure something else is restricting who can reach it.',
    );
  }
});
