#!/usr/bin/env node
/**
 * Packs the server into an `.mcpb` bundle — the format Claude Desktop installs with a double
 * click, and the same one Claude Code accepts.
 *
 * A bundle is a zip containing a `manifest.json` and a server that runs with no install step, so
 * the dependencies have to travel with it. esbuild flattens the whole import graph into one file
 * rather than copying `node_modules` wholesale, which takes the bundle from megabytes to a few
 * hundred kilobytes and removes any question of what shipped.
 *
 * Only `src/stdio.ts` is bundled. The Streamable HTTP entry point and Express go nowhere near it.
 */
import {
  copyFileSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { getAllFilesWithCount, validateManifest } from '@anthropic-ai/mcpb/node';
import * as esbuild from 'esbuild';
import yazl from 'yazl';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(projectRoot, 'plugin', 'mcpb', 'manifest.json');
const outputDir = join(projectRoot, 'build', 'mcpb');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// Three manifests carry a version — this one, package.json, and the Claude Code plugin manifest —
// and a bundle that claims a version the source does not is the kind of thing nobody notices
// until they are debugging the wrong build. Checking here is cheaper than finding out later.
const versions = {
  'package.json': JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version,
  '.claude-plugin/plugin.json': JSON.parse(
    readFileSync(join(projectRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
  ).version,
  'plugin/mcpb/manifest.json': manifest.version,
};

const disagreements = Object.entries(versions).filter(([, version]) => version !== manifest.version);
if (disagreements.length > 0) {
  throw new Error(
    'Version mismatch across manifests:\n' +
      Object.entries(versions)
        .map(([file, version]) => `  ${file}: ${version}`)
        .join('\n'),
  );
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(join(outputDir, 'server'), { recursive: true });

await esbuild.build({
  entryPoints: [join(projectRoot, 'src', 'stdio.ts')],
  outfile: join(outputDir, 'server', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Node resolves `import` in a .js file by the nearest package.json `type`, and there is no
  // package.json inside the bundle, so the banner keeps ESM-only globals working.
  banner: {
    js: [
      "import { createRequire } from 'node:module';",
      "import { fileURLToPath } from 'node:url';",
      "import { dirname } from 'node:path';",
      'const require = createRequire(import.meta.url);',
      'const __filename = fileURLToPath(import.meta.url);',
      'const __dirname = dirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
});

copyFileSync(manifestPath, join(outputDir, 'manifest.json'));
copyFileSync(join(projectRoot, '..', '..', 'LICENSE'), join(outputDir, 'LICENSE'));

// `mcpb` is a pinned devDependency rather than an `npx --yes` download, so the schema the manifest
// is checked against is the version in the lock file, and the build works offline.
if (!validateManifest(join(outputDir, 'manifest.json'))) {
  process.exit(1);
}

const bundlePath = join(projectRoot, 'build', `${manifest.name}-${manifest.version}.mcpb`);
await writeBundle(outputDir, bundlePath);

console.log(`\nBundle written to ${bundlePath} (${statSync(bundlePath).size} bytes)`);
console.log('Install it by double-clicking the file, or dragging it into Claude Desktop.');
console.log('Check it runs with: npm run verify:mcpb');

/**
 * Writes the `.mcpb` itself, which is what `mcpb pack` would otherwise do, with one difference:
 * every entry is **stored** rather than deflated.
 *
 * Claude Desktop reads bundles with yauzl, and on the versions affected by
 * https://github.com/anthropics/claude-code/issues/67865 that read deadlocks on any deflated entry
 * larger than the stream high-water mark — 16 KB on Windows, 64 KB on macOS. The install then does
 * nothing whatsoever: no dialog, no error, no log line, nothing for the user to report. `mcpb pack`
 * always deflates at level 9 and has no flag to turn that off, so a bundle packed the ordinary way
 * is silently uninstallable for anyone on an affected version — and the bundled server is a single
 * 870 KB file, well past the threshold.
 *
 * Stored entries skip the inflate path entirely and are ordinary zip that every version reads. It
 * costs about 700 KB of download. Once the fix has shipped widely this whole function goes away and
 * `packExtension` from the same package does the job.
 *
 * The file list comes from `mcpb`'s own walk of the staging directory, so the archive holds exactly
 * what `mcpb pack` would have put in it, under the same paths.
 *
 * Everything that would otherwise leak the machine into the archive is pinned, because a release
 * asset is only worth checksumming if a reader can rebuild it and get the same bytes:
 *
 *  - **Order.** The walk returns whatever `readdirSync` returns, which is filesystem order, not
 *    alphabetical. Sorting makes the sequence of entries the same on ext4 and APFS.
 *  - **Permissions.** The staged files carry the mode they happened to be created with, and that
 *    depends on the builder's umask: esbuild's output comes out `755` under the usual `022` and
 *    `700` under `077`, which is two different archives from one commit. Only the executable bit
 *    is worth preserving, so the rest is fixed.
 *  - **Timestamps.** Fixed, for the same reason. yazl also writes the mandatory DOS date/time
 *    with local getters (`getHours`, …), so the process timezone is pinned to UTC below —
 *    otherwise the same UTC `mtime` encodes differently outside UTC and the `.sha256` drifts.
 */
async function writeBundle(stagingDir, outputPath) {
  process.env.TZ = 'UTC';
  const { files } = getAllFilesWithCount(stagingDir);
  const zip = new yazl.ZipFile();

  for (const [path, { data, mode }] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    zip.addBuffer(Buffer.from(data), path, {
      compress: false,
      mode: mode & 0o111 ? 0o755 : 0o644,
      mtime: new Date('2020-01-01T00:00:00Z'),
    });
  }

  zip.end();
  await pipeline(zip.outputStream, createWriteStream(outputPath));
}
