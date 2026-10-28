import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { SERVER_INFO } from '../src/mcp/server.js';

/**
 * The plugin packaging is four manifests that have to agree with each other and with the code:
 * the Claude Code plugin manifest, the marketplace entry that points at it, the MCP server
 * definition, and the MCPB manifest Claude Desktop reads. None of them is exercised by running
 * the server, so nothing else would notice them drifting apart.
 */
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(projectRoot, '..', '..');

const readJson = (path: string): Record<string, any> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

const pluginManifest = readJson(join(projectRoot, '.claude-plugin', 'plugin.json'));
const mcpConfig = readJson(join(projectRoot, '.mcp.json'));
const marketplace = readJson(join(repoRoot, '.claude-plugin', 'marketplace.json'));
const mcpbManifest = readJson(join(projectRoot, 'plugin', 'mcpb', 'manifest.json'));
const cursorConfig = readJson(join(projectRoot, '.cursor', 'mcp.json'));
const packageJson = readJson(join(projectRoot, 'package.json'));

/**
 * Two identifiers, deliberately different:
 *
 *  - `modash-api-mcp` names the *plugin* — what you install, and what has to be distinctive in a
 *    marketplace listing alongside anything else Modash might publish.
 *  - `modash` names the *MCP server* inside it, which is already namespaced by the plugin and
 *    matches the `modash_*` tool prefix. Naming it `modash-api-mcp` too would render as
 *    `plugin:modash-api-mcp:modash-api-mcp` with nothing gained.
 */
const PLUGIN_NAME = 'modash-api-mcp';

describe('Claude Code plugin', () => {
  it('uses one plugin identifier everywhere it identifies the plugin', () => {
    assert.equal(pluginManifest['name'], PLUGIN_NAME);
    assert.equal(mcpbManifest['name'], PLUGIN_NAME);
    assert.ok(
      marketplace['plugins'].some((plugin: { name: string }) => plugin.name === PLUGIN_NAME),
      'the marketplace entry must use the same name',
    );
  });

  it('declares the server under the same name the server reports', () => {
    const servers = Object.keys(mcpConfig['mcpServers']);
    assert.deepEqual(servers, [SERVER_INFO.name]);
  });

  it('launches through a script that actually exists', () => {
    const { command, args } = mcpConfig['mcpServers'][SERVER_INFO.name];
    assert.equal(command, 'node');

    const entry = String(args[0]);
    assert.match(entry, /^\$\{CLAUDE_PLUGIN_ROOT\}\//, 'paths must be relative to the plugin root');
    assert.ok(existsSync(join(projectRoot, entry.replace('${CLAUDE_PLUGIN_ROOT}/', ''))));
  });

  /**
   * Claude Code passes `${VAR}` through unexpanded when the variable is unset and has no default,
   * so the server would receive the literal string `${MODASH_API_TOKEN}` as a token. Every
   * reference needs a `:-` fallback.
   */
  it('gives every environment reference a default', () => {
    for (const [name, value] of Object.entries<string>(
      mcpConfig['mcpServers'][SERVER_INFO.name].env,
    )) {
      assert.match(value, /^\$\{[A-Z_]+:-[^}]*\}$/, `${name} needs a \${VAR:-default} fallback`);
    }
  });

  it('is listed in the repository marketplace, pointing at this directory', () => {
    const entry = marketplace['plugins'].find(
      (plugin: { name: string }) => plugin.name === pluginManifest['name'],
    );
    assert.ok(entry, `no marketplace entry named "${pluginManifest['name']}"`);
    assert.ok(existsSync(resolve(repoRoot, entry.source)));
    assert.equal(resolve(repoRoot, entry.source), projectRoot);
  });
});

describe('Cursor project config', () => {
  it('starts the same server through the same launcher', () => {
    const server = cursorConfig['mcpServers'][SERVER_INFO.name];
    assert.ok(server, `no "${SERVER_INFO.name}" entry`);
    assert.equal(server.command, 'node');

    // Cursor resolves ${workspaceFolder} to the directory holding .cursor/mcp.json.
    const entry = String(server.args[0]);
    assert.match(entry, /^\$\{workspaceFolder\}\//);
    assert.ok(existsSync(join(projectRoot, entry.replace('${workspaceFolder}/', ''))));
  });

  it('reads the token from the environment rather than hardcoding one', () => {
    const { env } = cursorConfig['mcpServers'][SERVER_INFO.name];
    assert.equal(env.MODASH_API_TOKEN, '${env:MODASH_API_TOKEN}');
  });
});

describe('Claude Desktop bundle', () => {
  it('points at the file the build script emits', () => {
    assert.equal(mcpbManifest['server'].entry_point, 'server/index.js');
    assert.deepEqual(mcpbManifest['server'].mcp_config.args, ['${__dirname}/server/index.js']);
  });

  it('asks for the token as a secret, and does not require one', () => {
    const token = mcpbManifest['user_config'].api_token;
    assert.equal(token.sensitive, true, 'the token must be masked and stored securely');
    // Not required, because the whole thing runs against fixtures without one.
    assert.notEqual(token.required, true);
  });

  it('lists every tool the server can register, including the optional RAW ones', () => {
    const declared = mcpbManifest['tools'].map((tool: { name: string }) => tool.name).sort();
    const registered = [
      'modash_ai_search_creators',
      'modash_brand_crossover',
      'modash_compare_audience_overlap',
      'modash_find_creator',
      'modash_find_creators_by_email',
      'modash_find_lookalikes',
      'modash_get_account',
      'modash_get_creator_report',
      'modash_list_collaborations',
      'modash_lookup_ai_dictionary',
      'modash_lookup_dictionary',
      'modash_plan_brand_crossover',
      'modash_raw_browse',
      'modash_raw_get_post',
      'modash_raw_get_profile',
      'modash_raw_list_comments',
      'modash_raw_list_posts',
      'modash_raw_search',
      'modash_search_creators',
      'modash_summarise_collaborations',
    ];
    assert.deepEqual(declared, registered);
  });

  it('offers RAW as an opt-in, defaulting off', () => {
    const enableRaw = mcpbManifest['user_config'].enable_raw;
    assert.equal(enableRaw.type, 'boolean');
    assert.equal(enableRaw.default, false);
  });
});

/**
 * A release is a version bump landing on main: the workflow reads this manifest, names the tag and
 * the asset after it, and publishes if that version has no release yet. Both halves of that only
 * work while the workflow is still looking at the file it thinks it is — and the place you find out
 * otherwise is a release run, on a runner, after the merge.
 */
describe('release workflow', () => {
  const MANIFEST_PATH = 'projects/mcp-server/plugin/mcpb/manifest.json';
  const TAG_PREFIX = 'mcp-server-v';

  const workflow = readFileSync(
    join(repoRoot, '.github', 'workflows', 'release-mcpb.yml'),
    'utf8',
  );

  it('reads the version from the manifest, at the path the manifest is actually at', () => {
    assert.ok(existsSync(join(repoRoot, MANIFEST_PATH)), `${MANIFEST_PATH} has moved`);
    assert.ok(workflow.includes(MANIFEST_PATH), `the workflow does not read ${MANIFEST_PATH}`);
  });

  it('builds the tag with the same prefix it triggers on', () => {
    assert.ok(workflow.includes(`'${TAG_PREFIX}*'`), 'no tag trigger');
    // A hand-pushed tag is checked against this one, so the two spellings have to agree or no tag
    // can ever match.
    assert.ok(
      workflow.includes(`tag="${TAG_PREFIX}\${version}"`),
      'the tag is built with a different prefix than the trigger matches',
    );
  });
});

describe('versions', () => {
  it('agree across every manifest that carries one', () => {
    assert.equal(pluginManifest['version'], packageJson['version']);
    assert.equal(mcpbManifest['version'], packageJson['version']);
    assert.equal(SERVER_INFO.version, packageJson['version']);
  });
});
