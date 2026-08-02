#!/usr/bin/env node
/**
 * Tests for the CI audit.
 *
 * A guard that has quietly stopped guarding is worse than no guard, because the
 * green check keeps saying everything is fine. Each case below takes the real
 * workflow, poisons it in one specific way, and asserts the audit notices. Adding
 * a check to the audit means adding a case here.
 *
 * No dependencies and no test framework beyond node's own, so this runs in the
 * same job as the audit itself:
 *
 *   node --test .github/scripts/audit-ci.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const realWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

/** Every project the real workflow claims to cover, so the fixture matches it. */
const fixtureProjects = [...realWorkflow.matchAll(/^\s+- ([a-z][a-z0-9-]*)\s*$/gm)].map((m) => m[1]);

const lockFor = (name) => ({
  name,
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name, version: "1.0.0" },
    "node_modules/example-dependency": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/example-dependency/-/example-dependency-1.0.0.tgz",
      integrity: "sha512-placeholder",
    },
  },
});

/**
 * Builds a throwaway repository that passes the audit, hands it to `mutate`, then
 * runs the real audit script against it.
 */
function audit(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "audit-ci-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, ".github", "scripts"), { recursive: true });
  cpSync(join(repoRoot, ".github", "scripts", "audit-ci.mjs"), join(root, ".github", "scripts", "audit-ci.mjs"));
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), realWorkflow);

  for (const project of fixtureProjects) {
    const dir = join(root, "projects", project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: project, version: "1.0.0" }));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lockFor(project)));
  }

  const helpers = {
    root,
    project: fixtureProjects[0],
    editWorkflow(edit) {
      const path = join(root, ".github", "workflows", "ci.yml");
      writeFileSync(path, edit(readFileSync(path, "utf8")));
    },
    editLock(edit) {
      const path = join(root, "projects", fixtureProjects[0], "package-lock.json");
      writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, "utf8")))));
    },
    addWorkflow(name, contents) {
      writeFileSync(join(root, ".github", "workflows", name), contents);
    },
  };
  mutate(helpers);

  const result = spawnSync(process.execPath, [join(root, ".github", "scripts", "audit-ci.mjs")], {
    encoding: "utf8",
  });
  return { code: result.status, output: result.stdout + result.stderr };
}

test("a clean repository passes", () => {
  const { code, output } = audit();
  assert.equal(code, 0, output);
  assert.match(output, /CI audit passed/);
});

/** Each case: a one-line poisoning, and the words the audit must say about it. */
const poisonings = [
  {
    name: "a trigger that runs untrusted code with a privileged token",
    mutate: (h) => h.editWorkflow((yml) => yml.replace("  pull_request:", "  pull_request_target:")),
    expect: /pull_request_target/,
  },
  {
    name: "a banned trigger hidden behind a quoted 'on' key",
    mutate: (h) =>
      h.editWorkflow((yml) => yml.replace("on:\n  push:", "'on':\n  workflow_run:\n    workflows: [CI]\n  push:")),
    expect: /workflow_run/,
  },
  {
    name: "a secret handed to a job",
    mutate: (h) => h.editWorkflow((yml) => yml.replace("- run: npm ci", "- run: echo ${{ secrets.NPM_TOKEN }}\n      - run: npm ci")),
    expect: /hands a secret to a workflow a pull request can trigger/,
  },
  {
    name: "a self-hosted runner",
    mutate: (h) => h.editWorkflow((yml) => yml.replace("runs-on: ubuntu-latest", "runs-on: self-hosted")),
    expect: /ephemeral GitHub-hosted runners/,
  },
  {
    name: "a self-hosted runner written as a list",
    mutate: (h) =>
      h.editWorkflow((yml) => yml.replace("runs-on: ubuntu-latest", "runs-on: [self-hosted, linux]")),
    expect: /runs on 'self-hosted'/,
  },
  {
    name: "a self-hosted runner written as an indented block",
    mutate: (h) =>
      h.editWorkflow((yml) =>
        yml.replace("    runs-on: ubuntu-latest\n", "    runs-on:\n      - self-hosted\n      - linux\n"),
      ),
    expect: /runs on 'self-hosted'/,
  },
  {
    name: "an action pinned to a movable tag",
    mutate: (h) => h.editWorkflow((yml) => yml.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v7")),
    expect: /not pinned to a full commit SHA/,
  },
  {
    name: "a checkout that leaves its token on disk",
    mutate: (h) => h.editWorkflow((yml) => yml.replace(/\n\s*persist-credentials: false/, "")),
    expect: /persist-credentials: false/,
  },
  {
    name: "a checkout that only mentions persist-credentials in an env value",
    mutate: (h) =>
      h.editWorkflow((yml) =>
        yml.replace(
          "        with:\n          persist-credentials: false\n\n      - uses: actions/setup-node",
          "        env:\n          NOTE: \"persist-credentials: false\"\n\n      - uses: actions/setup-node",
        ),
      ),
    expect: /does not pass persist-credentials: false/,
  },
  {
    name: "a job granted write access",
    mutate: (h) => h.editWorkflow((yml) => yml.replace(/permissions:\n(\s+)contents: read/, "permissions:\n$1contents: write")),
    expect: /grants write access/,
  },
  {
    name: "an inline blanket permission",
    mutate: (h) => h.editWorkflow((yml) => yml.replace("permissions:\n  contents: read", "permissions: write-all")),
    expect: /grants more than read access/,
  },
  {
    name: "a job with no time limit",
    mutate: (h) => h.editWorkflow((yml) => yml.replace("    timeout-minutes: 15\n", "")),
    expect: /has no timeout-minutes/,
  },
  {
    name: "an install that ignores the lock file",
    mutate: (h) => h.editWorkflow((yml) => yml.replace("npm ci --ignore-scripts", "npm install")),
    expect: /lock file decides/,
  },
  {
    name: "an install that lets dependencies run their own code",
    mutate: (h) => h.editWorkflow((yml) => yml.replace("npm ci --ignore-scripts", "npm ci")),
    expect: /--ignore-scripts/,
  },
  {
    name: "an install under one of npm's aliases for install",
    mutate: (h) => h.editWorkflow((yml) => yml.replace("npm ci --ignore-scripts", "npm isntall")),
    expect: /'npm isntall' resolves dependencies afresh/,
  },
  {
    name: "an npm ci alias with install scripts still on",
    mutate: (h) => h.editWorkflow((yml) => yml.replace("npm ci --ignore-scripts", "npm clean-install")),
    expect: /add --ignore-scripts/,
  },
  {
    name: "an --ignore-scripts flag explicitly turned off",
    mutate: (h) => h.editWorkflow((yml) => yml.replace("npm ci --ignore-scripts", "npm ci --ignore-scripts=false")),
    expect: /add --ignore-scripts/,
  },
  {
    name: "an --ignore-scripts flag given false as its value",
    mutate: (h) => h.editWorkflow((yml) => yml.replace("npm ci --ignore-scripts", "npm ci --ignore-scripts false")),
    expect: /add --ignore-scripts/,
  },
  {
    name: "a script downloaded and piped into a shell",
    mutate: (h) => h.editWorkflow((yml) => yml.replace("- run: npm ci", "- run: curl -sL https://example.test/install.sh | bash\n      - run: npm ci")),
    expect: /pipes a downloaded script/,
  },
  {
    name: "a download piped into a shell inside a multi-line script",
    mutate: (h) =>
      h.editWorkflow((yml) =>
        yml.replace(
          "      - run: npm ci --ignore-scripts",
          "      - run: |\n          curl -sL https://example.test/install.sh | bash\n          npm ci --ignore-scripts",
        ),
      ),
    expect: /pipes a downloaded script/,
  },
  {
    name: "a project dropped from the matrix",
    mutate: (h) => h.editWorkflow((yml) => yml.replace(`          - ${h.project}\n`, "")),
    expect: /never built or tested/,
  },
  {
    name: "a dependency resolved from outside the public registry",
    mutate: (h) =>
      h.editLock((lock) => {
        lock.packages["node_modules/example-dependency"].resolved = "https://example.test/example-dependency.tgz";
        return lock;
      }),
    expect: /outside the public npm registry/,
  },
  {
    name: "a dependency with no integrity hash",
    mutate: (h) =>
      h.editLock((lock) => {
        delete lock.packages["node_modules/example-dependency"].integrity;
        return lock;
      }),
    expect: /no integrity hash/,
  },
  {
    name: "an .npmrc redirecting the registry",
    mutate: (h) =>
      writeFileSync(join(h.root, "projects", h.project, ".npmrc"), "registry=https://example.test/\n"),
    expect: /non-public registry/,
  },
  {
    name: "an .npmrc turning install scripts back on",
    mutate: (h) => writeFileSync(join(h.root, "projects", h.project, ".npmrc"), "ignore-scripts=false\n"),
    expect: /re-enables install scripts/,
  },
];

for (const { name, mutate, expect } of poisonings) {
  test(`the audit catches ${name}`, () => {
    const { code, output } = audit(mutate);
    assert.equal(code, 1, `expected a failure, got:\n${output}`);
    assert.match(output, expect);
  });
}

test("prose in a comment cannot satisfy a check", () => {
  const { code, output } = audit((h) =>
    h.editWorkflow((yml) => yml.replace(/actions\/setup-node@[0-9a-f]{40}/, "actions/setup-node@v7 # 0123456789abcdef0123456789abcdef01234567")),
  );
  assert.equal(code, 1, output);
  assert.match(output, /not pinned to a full commit SHA/);
});

/**
 * The line the audit draws is around untrusted input, not around write access as
 * such. A release workflow no pull request can reach is running reviewed code, so
 * it may hold a token and write — otherwise the first person who needs one deletes
 * the audit instead of arguing with it.
 */
const releaseWorkflow = `name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567
        with:
          persist-credentials: false
      - run: gh release upload "\${{ github.ref_name }}" dist/plugin.mcpb
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

test("a release workflow no pull request can trigger may hold a token and write", () => {
  const { code, output } = audit((h) => h.addWorkflow("release.yml", releaseWorkflow));
  assert.equal(code, 0, output);
});

test("the same release workflow is refused once a pull request can trigger it", () => {
  const { code, output } = audit((h) =>
    h.addWorkflow("release.yml", releaseWorkflow.replace('  push:\n    tags: ["v*"]', "  pull_request:")),
  );
  assert.equal(code, 1, output);
  assert.match(output, /grants write access to a workflow a pull request can trigger/);
  assert.match(output, /hands a secret to a workflow a pull request can trigger/);
});

test("a workflow with no readable triggers is treated as untrusted", () => {
  const { code, output } = audit((h) =>
    h.addWorkflow("release.yml", releaseWorkflow.replace(/on:\n  push:\n    tags: \["v\*"\]\n/, "")),
  );
  assert.equal(code, 1, output);
  assert.match(output, /grants write access to a workflow a pull request can trigger/);
});
