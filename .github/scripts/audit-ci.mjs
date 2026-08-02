#!/usr/bin/env node
/**
 * Fails the build when the build itself stops being trustworthy.
 *
 * This repository is public, so anyone can open a pull request and every job in
 * `.github/workflows` then runs code a stranger wrote. That is fine only while the
 * jobs have nothing worth stealing and nothing they can tamper with. The checks
 * below assert exactly that, so the property survives the next edit to a workflow
 * instead of depending on whoever reviews it noticing.
 *
 * Run it locally the same way CI does:
 *
 *   node .github/scripts/audit-ci.mjs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowDir = join(repoRoot, ".github", "workflows");
const projectsDir = join(repoRoot, "projects");

const problems = [];

function fail(where, message) {
  problems.push(`${where}: ${message}`);
}

/**
 * Strips `#` comments so a check can't be satisfied — or tripped — by prose.
 * Quotes are tracked because `${{ github.ref }}` style values may contain `#`.
 */
function stripComments(text) {
  return text
    .split("\n")
    .map((line) => {
      let single = false;
      let double = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === "'" && !double) single = !single;
        else if (char === '"' && !single) double = !double;
        else if (char === "#" && !single && !double && (i === 0 || /\s/.test(line[i - 1]))) {
          return line.slice(0, i).trimEnd();
        }
      }
      return line;
    })
    .join("\n");
}

const indentOf = (line) => line.length - line.trimStart().length;

/** npm subcommands that never install anything, so never run a dependency's hooks. */
const CANNOT_INSTALL = new Set([
  "run", "run-script", "rum", "urn", "test", "t", "tst", "start", "stop", "restart",
  "version", "pkg", "config", "c", "get", "set", "ls", "list", "la", "ll", "audit",
  "view", "v", "info", "show", "why", "outdated", "ping", "whoami", "help",
]);

/** `npm ci` and its aliases: the only installs allowed. */
const CLEAN_INSTALL = new Set(["ci", "clean-install", "ic", "install-clean"]);

/**
 * npm reads `--ignore-scripts=false` and `--ignore-scripts false` as off, so a
 * substring search for the flag would accept a command that still runs hooks.
 */
const IGNORES_SCRIPTS = /(^|\s)--ignore-scripts(=true)?(\s+(?!false\b)|\s*$)/;

/**
 * Returns the lines belonging to the mapping opened on `start`: everything more
 * deeply indented, plus the opening line itself. Enough structure for these
 * checks without pulling a YAML parser into a job that must stay dependency-free.
 */
function blockAt(lines, start) {
  const baseIndent = indentOf(lines[start]);
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) <= baseIndent) break;
    block.push(line);
  }
  return block;
}

/**
 * The `on:` section, inline or block form, or "" when the workflow has none.
 * YAML lets the key be quoted either way, and a 1.1 parser turns a bare `on` into
 * `true` — all four spellings have to find the same triggers, or a workflow could
 * hide its triggers from this audit by adding a pair of quotes.
 */
function triggersOf(lines) {
  const start = lines.findIndex((line) => /^(['"]?)on\1\s*:|^true\s*:/.test(line));
  return start === -1 ? "" : blockAt(lines, start).join("\n");
}

// --- Workflow checks ---------------------------------------------------------

const workflows = existsSync(workflowDir)
  ? readdirSync(workflowDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  : [];

if (workflows.length === 0) {
  fail(".github/workflows", "no workflows found — this audit would pass vacuously");
}

for (const name of workflows) {
  const path = join(workflowDir, name);
  const where = relative(repoRoot, path);
  const source = stripComments(readFileSync(path, "utf8"));
  const lines = source.split("\n");

  const triggers = triggersOf(lines);

  // These three pair a privileged token with input somebody outside the repo
  // controls, which is how most Actions compromises have started. Nothing here
  // needs them, so they are refused outright rather than reviewed case by case.
  for (const trigger of ["pull_request_target", "workflow_run", "issue_comment"]) {
    if (new RegExp(`\\b${trigger}\\b`).test(triggers)) {
      fail(where, `uses the '${trigger}' trigger, which pairs a privileged token with input an outsider controls`);
    }
  }

  // A workflow a pull request can trigger runs code nobody has reviewed yet, so it
  // gets nothing: no secrets and no write access. A workflow that only runs after a
  // merge, on a tag, or by hand is running reviewed code and may have both. An
  // unreadable `on:` counts as untrusted, so a workflow cannot escape by confusing
  // this check.
  const untrusted = triggers === "" || /\bpull_request\b/.test(triggers);

  if (untrusted && (/\bsecrets\s*\./.test(source) || /^\s*secrets:/m.test(source))) {
    fail(where, "hands a secret to a workflow a pull request can trigger");
  }

  // A GitHub-hosted runner is a fresh VM that is destroyed afterwards. A
  // self-hosted one is a machine an attacker can leave something behind on.
  // `runs-on` takes a label, a list of labels, or a `group:` mapping, so read the
  // whole value rather than just the rest of the line.
  for (const [index, line] of lines.entries()) {
    const match = /^\s*runs-on:\s*(.*)$/.exec(line);
    if (!match) continue;
    const inline = match[1].trim();
    const labels =
      inline === ""
        ? blockAt(lines, index)
            .slice(1)
            .map((entry) => entry.replace(/^\s*-\s*/, "").trim())
        : inline.replace(/^\[|\]$/g, "").split(",");
    for (const label of labels.map((entry) => entry.trim().replace(/^["']|["']$/g, ""))) {
      if (label !== "" && !/^(ubuntu|macos|windows)-[\w.]+$/.test(label)) {
        fail(where, `runs on '${label}' — only ephemeral GitHub-hosted runners are allowed`);
      }
    }
  }

  // A version tag is a moving pointer: whoever controls the action's repository
  // can repoint it at new code, and it lands here with no diff and no review.
  // A full commit SHA is the only reference that cannot be changed underneath us.
  for (const match of source.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) {
    const ref = match[1];
    if (!/@[0-9a-f]{40}$/.test(ref)) {
      fail(where, `'${ref}' is not pinned to a full commit SHA`);
    }
  }

  // Every checkout must drop the token afterwards, so that nothing later in the
  // job — a dependency's install script included — can find credentials on disk.
  // It has to be the input itself: the same text in an `env` value or a comment
  // would satisfy a substring search while the token stayed on disk.
  lines.forEach((line, index) => {
    if (!/uses:\s*actions\/checkout@/.test(line)) return;
    const step = blockAt(lines, index);
    const withStart = step.findIndex((entry) => /^\s*with:\s*$/.test(entry));
    const inputs = withStart === -1 ? [] : blockAt(step, withStart).slice(1);
    if (!inputs.some((input) => /^\s*persist-credentials:\s*false\s*$/.test(input))) {
      fail(where, "an actions/checkout step does not pass persist-credentials: false");
    }
  });

  // Least privilege, stated explicitly: the repository-wide default for the token
  // is a setting we cannot see from here, so every workflow pins its own.
  if (!lines.some((line) => /^permissions:/.test(line))) {
    fail(where, "does not declare top-level 'permissions:'");
  }
  if (untrusted) {
    for (const line of lines.filter((entry) => /^\s*permissions:/.test(entry))) {
      const inline = line.split(":").slice(1).join(":").trim();
      if (inline !== "" && inline !== "{}" && inline !== "read-all") {
        fail(where, `'${line.trim()}' grants more than read access to a workflow a pull request can trigger`);
      }
    }
    for (const [index, line] of lines.entries()) {
      if (!/^\s*permissions:\s*$/.test(line)) continue;
      for (const scope of blockAt(lines, index).slice(1)) {
        const level = scope.split(":").slice(1).join(":").trim();
        if (level !== "read" && level !== "none") {
          fail(where, `'${scope.trim()}' grants write access to a workflow a pull request can trigger`);
        }
      }
    }
  }

  // An unbounded job is a free VM for as long as GitHub will keep it alive.
  const jobsStart = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsStart === -1) {
    fail(where, "has no 'jobs:' block");
  } else {
    for (let i = jobsStart + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") continue;
      if (indentOf(line) === 0) break;
      if (!/^\s{2}[\w-]+:\s*$/.test(line)) continue;
      if (!/^\s*timeout-minutes:/m.test(blockAt(lines, i).join("\n"))) {
        fail(where, `job '${line.trim().replace(":", "")}' has no timeout-minutes`);
      }
    }
  }

  // Shell steps are the other half of the attack surface. `run: |` puts the script
  // on the lines that follow, so collect those too rather than checking the pipe.
  const commands = [];
  for (const [index, line] of lines.entries()) {
    const match = /^\s*(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!match) continue;
    if (/^[|>]/.test(match[1].trim())) {
      commands.push(...blockAt(lines, index).slice(1).map((script) => script.trim()));
    } else {
      commands.push(match[1].trim());
    }
  }

  for (const command of commands) {
    // npm answers to a long list of aliases — `i`, `in`, `isntall`, `ic`,
    // `clean-install` — so matching the spellings we happen to remember would leave
    // the rest as a way through. Allowlist the subcommands that cannot install and
    // hold everything else to `npm ci --ignore-scripts`.
    for (const [, subcommand, args] of command.matchAll(/\bnpm\s+([\w:-]+)([^;&|]*)/g)) {
      if (CANNOT_INSTALL.has(subcommand)) continue;
      if (!CLEAN_INSTALL.has(subcommand)) {
        fail(where, `'npm ${subcommand}' resolves dependencies afresh — use 'npm ci --ignore-scripts' so the lock file decides`);
      } else if (!IGNORES_SCRIPTS.test(args)) {
        fail(where, `'npm ${subcommand}${args}' lets every dependency's install script run arbitrary code — add --ignore-scripts`);
      }
    }
    if (/(curl|wget)[^|]*\|\s*(ba|z|d)?sh/.test(command)) {
      fail(where, `'${command}' pipes a downloaded script straight into a shell`);
    }
  }
}

// --- Project checks ----------------------------------------------------------

const projects = readdirSync(projectsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(projectsDir, entry.name, "package.json")))
  .map((entry) => entry.name);

if (projects.length === 0) {
  fail("projects", "no projects found — this audit would pass vacuously");
}

const ciPath = join(workflowDir, "ci.yml");
const ciSource = existsSync(ciPath) ? stripComments(readFileSync(ciPath, "utf8")) : "";

for (const project of projects) {
  const where = `projects/${project}`;

  // CI runs one job per matrix entry, so a project missing from the matrix is
  // never built or tested and the green check on a pull request touching it is
  // telling the reader something that was never checked.
  if (!new RegExp(`^\\s+- ${project}\\s*$`, "m").test(ciSource)) {
    fail(where, "is not in the CI matrix in .github/workflows/ci.yml, so it is never built or tested");
  }

  // `npm ci` refuses to run without a lock file, and only a lock file makes the
  // set of code CI executes reviewable.
  const lockPath = join(projectsDir, project, "package-lock.json");
  if (!existsSync(lockPath)) {
    fail(where, "has no package-lock.json");
    continue;
  }

  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.lockfileVersion < 2) {
    fail(where, `package-lock.json is lockfileVersion ${lock.lockfileVersion}; v2+ is needed for integrity hashes`);
  }

  // `npm ci` installs whatever the lock file points at, including a tarball on a
  // host nobody has heard of or a git URL that resolves to a moving branch. Both
  // read as one changed line in a diff, so check the whole tree instead.
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (name === "" || entry.link) continue;
    if (!entry.resolved) {
      fail(where, `'${name}' has no resolved URL in package-lock.json`);
      continue;
    }
    if (!entry.resolved.startsWith("https://registry.npmjs.org/")) {
      fail(where, `'${name}' resolves to ${entry.resolved}, outside the public npm registry`);
    }
    if (!entry.integrity) {
      fail(where, `'${name}' has no integrity hash, so its contents are not verified on install`);
    }
  }

  // An .npmrc can point the whole install somewhere else, or turn install scripts
  // back on, without touching the workflow or the lock file.
  const npmrcPath = join(projectsDir, project, ".npmrc");
  if (existsSync(npmrcPath)) {
    for (const line of readFileSync(npmrcPath, "utf8").split("\n")) {
      const setting = line.split("#")[0].trim();
      if (setting === "") continue;
      if (/registry\s*=/.test(setting) && !setting.includes("registry.npmjs.org")) {
        fail(where, `.npmrc points at a non-public registry: '${setting}'`);
      }
      if (/^ignore-scripts\s*=\s*false/.test(setting)) {
        fail(where, ".npmrc re-enables install scripts");
      }
    }
  }
}

// --- Report ------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`CI audit failed with ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error("\nWhy these rules exist: .github/scripts/audit-ci.mjs\n");
  process.exit(1);
}

console.log(
  `CI audit passed: ${workflows.length} workflow(s), ${projects.length} project(s) — nothing a ` +
    "pull request can trigger holds a secret or write access, every action is pinned to a SHA, " +
    "every install is locked.",
);
