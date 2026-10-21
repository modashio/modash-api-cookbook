---
name: repo-maintenance
description: Sweep the cookbook for broken checks, convention drift, stale dependencies and doc rot, fix the safe items, and report the rest. Use when asked to maintain, tidy or health-check the repo.
---

# Repo maintenance

Spend zero credits. Run every command with no Modash token and no model provider key in the
environment: prefix with `env -u MODASH_API_TOKEN -u OPENAI_API_KEY -u ANTHROPIC_API_KEY`.

Work on one branch. Record every finding as you go: check, result, action taken or reason not.

## 1. Baseline

- Run the `guard` job's two commands from [`ci.yml`](../../../.github/workflows/ci.yml) at the repo root.
- In every `projects/*/`, run each `run:` step of every `ci.yml` job that targets it, in order.
- Done when every command has a recorded pass or fail. A failure here is the first thing to fix.

## 2. Convention drift

Check every project against each item. The CI audit already covers workflows and lock files; this is what it does not see.

- The `projects/*` directory list matches the root `README.md` projects table, the **Which project** dropdown in `.github/ISSUE_TEMPLATE/bug_report.yml`, and `.claude-plugin/marketplace.json` for plugin projects. Find any other hardcoded list with `rg --hidden` for each project name.
- `package.json` has `"type": "module"`, `"engines": { "node": ">=22" }`, and `dev`, `typecheck`, `test`, `build` scripts. `typecheck` is `tsgo --noEmit`, with `@typescript/native-preview` in `devDependencies`.
- `tsconfig.json` sets `strict: true`.
- Every env var the source reads (`rg -o 'process\.env\.\w+'` plus any `env[...]` lookups) is in `.env.example`, with a placeholder value.
- The Node version agrees across `engines`, every `node-version:` in `.github/workflows/`, and the Node version stated in docs.

## 3. Dependencies

- Per project: `npm outdated` and `npm audit`.
- Apply in-range and minor updates with `npm update --ignore-scripts`, then rerun step 1 for that project and the CI audit.
- Leave majors in the report with what breaks, unless `npm audit` flags a high or critical advisory with no in-range fix.
- Leave each project's own `version` alone. For `mcp-server`, merging a version bump publishes a release (see `AGENTS.md`, Releasing something downloadable).

## 4. Docs

- Every relative link and `#anchor` in every tracked `*.md` resolves. Include dotfile directories.
- Every external link responds (`curl -sIL -o /dev/null -w '%{http_code}'`). Retry a failure once before reporting it.
- Every `npm run <script>` quoted in a project's docs exists in that project's `package.json`.
- Credit costs and rate limits quoted in docs match the public [API reference](https://docs.modash.io). Report a mismatch with both values; do not guess.

## 5. Public-repo hygiene

Scan tracked files only (`git ls-files`, `git grep`).

- No committed `.env` other than `.env.example`, and no token-shaped strings (long hex, base64 or `sk-`-style keys).
- Fixtures and examples stay obviously synthetic: no real-looking emails, creator handles or profile photo URLs.
- A real secret found here is compromised. Report it for rotation; deleting it in a commit is not enough.

## 6. Fix and report

- Fix mechanical drift: lists, links, scripts, `.env.example`, in-range dependency updates. One Conventional Commit per logical change.
- Report without fixing: majors, anything that changes API calls or credit cost, anything that needs a version bump, and suspected secrets.
- Rerun step 1 after the last fix. Done when it passes again.
- Open a draft PR titled `chore: repo maintenance sweep`, using `.github/pull_request_template.md`. Put the findings table in **What this changes**: check, result, action.
