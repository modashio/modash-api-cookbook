#!/usr/bin/env node
/**
 * Checks that the packed `.mcpb` actually works, by installing it the way a client does.
 *
 * Building one checks the manifest against the schema and stops there — nothing so far says the
 * bundled server starts, and that is the failure that matters. esbuild flattens the import graph
 * into a single file, so anything resolved at run time rather than at build time (a dynamic
 * `require`, a native binding, a file read relative to the package it came from) survives
 * `npm test` against the source tree and throws on a user's machine, where the stack trace lands
 * in a log nobody opens.
 *
 * So this unpacks the archive into a temporary directory, resolves the manifest into a command the
 * same way Claude Desktop does, spawns it, and talks MCP to it. No token, mock mode, no credits.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unpackExtension } from '@anthropic-ai/mcpb';
import { getMcpConfigForManifest } from '@anthropic-ai/mcpb/node';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
  readFileSync(join(projectRoot, 'plugin', 'mcpb', 'manifest.json'), 'utf8'),
);
const bundlePath = join(projectRoot, 'build', `${manifest.name}-${manifest.version}.mcpb`);

/**
 * What a reader would type into the install dialog. RAW is switched on so every tool the manifest
 * advertises is actually registered and can be compared against the list; the budgets are set to
 * something other than their defaults so a substitution that silently dropped them is visible.
 * None of it spends anything — with no token the server runs on fixtures.
 */
const userConfig = { enable_raw: true, credit_budget: 2, raw_budget: 3 };

const unpacked = mkdtempSync(join(tmpdir(), 'modash-mcpb-'));
let client;

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

try {
  if (!(await unpackExtension({ mcpbPath: bundlePath, outputDir: unpacked, silent: true }))) {
    throw new Error(`Could not unpack ${bundlePath}. Run \`npm run build:mcpb\` first.`);
  }

  // Read the manifest back out of the archive rather than trusting the source copy: this is what
  // proves it landed at the root, which is where a client looks for it.
  const installed = JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8'));
  check(installed.version === manifest.version, 'the packed manifest is not the source manifest');

  const mcpConfig = await getMcpConfigForManifest({
    manifest: installed,
    extensionPath: unpacked,
    systemDirs: {},
    userConfig,
    pathSeparator: sep,
  });
  check(mcpConfig !== undefined, 'the manifest did not resolve to a runnable command');

  client = new Client({ name: 'modash-mcpb-verify', version: manifest.version });

  try {
    await client.connect(
      new StdioClientTransport({
        command: mcpConfig.command,
        args: mcpConfig.args,
        env: { ...getDefaultEnvironment(), ...mcpConfig.env },
        // The bundled server loads dotenv, which reads `.env` from the working directory. Running
        // it from the unpacked bundle rather than from the project keeps a developer's real token
        // out of a check that is supposed to cost nothing.
        cwd: unpacked,
        stderr: 'inherit',
      }),
    );
  } catch (cause) {
    // The interesting failure. Whatever the server printed on the way down is above this line.
    throw new Error(`The bundled server did not start: ${cause.message}`, { cause });
  }

  const { tools } = await client.listTools();
  const registered = tools.map((tool) => tool.name).sort();
  const advertised = installed.tools.map((tool) => tool.name).sort();
  check(
    JSON.stringify(registered) === JSON.stringify(advertised),
    `the bundle registers different tools than the manifest advertises:\n` +
      `  advertised: ${advertised.join(', ')}\n  registered: ${registered.join(', ')}`,
  );

  const { resources } = await client.listResources();
  const { prompts } = await client.listPrompts();
  check(resources.length > 0, 'no resources');
  check(prompts.length > 0, 'no prompts');

  // One free call, end to end through the bundled code. It also reads back the user_config the
  // manifest turned into environment variables, which is the part with the most ways to go wrong.
  const account = await client.callTool({ name: 'modash_get_account', arguments: {} });
  check(account.isError !== true, `modash_get_account failed: ${JSON.stringify(account.content)}`);
  check(
    account.structuredContent?.mode === 'mock',
    'the bundle did not fall back to mock mode without a token — it may be about to spend credits',
  );
  check(
    account.structuredContent?.session.budget === userConfig.credit_budget,
    `credit_budget did not reach the server: got ${account.structuredContent?.session.budget}`,
  );

  console.log(`Verified ${bundlePath}`);
  console.log(
    `  ${registered.length} tools, ${resources.length} resources, ${prompts.length} prompts`,
  );
  console.log(`  runs in mock mode on a ${account.structuredContent.session.budget} credit budget`);
} finally {
  await client?.close();
  rmSync(unpacked, { recursive: true, force: true });
}
