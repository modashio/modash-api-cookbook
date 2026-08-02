#!/usr/bin/env node
/**
 * Entry point for the packaged Claude Code plugin.
 *
 * A plugin installed from a marketplace arrives as a copy of this directory in Claude Code's
 * plugin cache: source files, `package.json`, lock file, and no `node_modules`. Nothing runs
 * `npm install` on the user's behalf, so the server has to be able to stand itself up on first
 * launch. That is all this file does — install, build, then hand over.
 *
 * The one rule it has to respect: **stdout belongs to the MCP protocol.** A single stray byte on
 * fd 1 corrupts the JSON-RPC stream, and the error the client reports will say nothing about npm.
 * So every child process writes to stderr, and so does every message here.
 *
 * Written in plain JavaScript against Node builtins only, because at the moment it runs there is
 * nothing installed for it to import.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entryPoint = join(pluginRoot, 'dist', 'stdio.js');

const log = (message) => process.stderr.write(`modash plugin: ${message}\n`);

function npm(description, args) {
  log(description);

  const result = spawnSync('npm', args, {
    cwd: pluginRoot,
    // fd 1 and fd 2 both point at stderr: npm is chatty and none of it is protocol traffic.
    stdio: ['ignore', 2, 2],
    // On Windows `npm` is a .cmd shim, which spawn cannot execute directly.
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    log(`\`npm ${args.join(' ')}\` failed. Run it by hand in ${pluginRoot} to see why.`);
    process.exit(1);
  }
}

// The plugin cache directory is per-version, so a plugin update lands in an empty directory and
// this runs again — which is what you want, since the dependencies may have changed too.
if (!existsSync(entryPoint)) {
  log('first launch: installing dependencies and building. This takes a minute.');
  npm('installing dependencies', ['install', '--no-audit', '--no-fund', '--loglevel=error']);
  npm('building', ['run', 'build']);
  log('ready.');
}

await import(pathToFileURL(entryPoint).href);
