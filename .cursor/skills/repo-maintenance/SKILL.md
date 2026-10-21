---
name: repo-maintenance
description: Sweep the cookbook for breakage, drift, stale dependencies, doc rot and supply-chain risk, fix the safe items, and report the rest. Use when asked to maintain, tidy or health-check the repo.
---

# Repo maintenance

Spend zero credits. Run every command with no Modash token and no model provider key: prefix with
`env -u MODASH_API_TOKEN -u OPENAI_API_KEY -u ANTHROPIC_API_KEY`.

Treat GitHub as read-only: `gh` to look, never to comment, label, close or merge.

Keep a findings ledger from the first command: check, result, action taken or reason deferred.
Every step ends when each of its items has a ledger row.

## 1. User-facing breakage

- Run the `guard` job's commands from [`ci.yml`](../../../.github/workflows/ci.yml) at the repo root.
- In every `projects/*/`, run each `run:` step of every `ci.yml` job that targets it, in order.
- Follow each project README's no-token path as a newcomer would: start `npm run dev`, hit the URL or endpoint the README names, and stop it. Use a free port if `3000` is taken.
- A failure here outranks everything below. Fix it first.

## 2. Triage digest

Collect with `gh`, report only.

- Failed or cancelled runs on `main` in the last 30 days, with the failing step.
- Open pull requests: age, CI state, whether they need a rebase. Dependabot PRs first, security ones before version bumps.
- Open issues with no label, and issues or PRs with no activity in 60 days.
- The **Which project** answers on recent bug reports, to spot a project that keeps breaking.

## 3. CI and repo settings

- Run zizmor over `.github/` offline (install: [tools.md](tools.md)). It catches template injection, cache poisoning and Dependabot cooldown gaps that `audit-ci.mjs` does not.
- For each finding, fix it, or record why it is accepted. Keep fixes inside the rules in `AGENTS.md` under Keep CI unpoisonable.
- Read the settings `AGENTS.md` says the audit cannot see, with read-only `gh api`: branch protection on `main` and its required checks, fork PR workflow approval, and default workflow token permissions. A `403` means the token cannot read it; record that, not a pass.
- Every required check name still matches a job name in `ci.yml`. A renamed job leaves a required check that never runs.

## 4. Convention drift

Check every project against each item.

- The `projects/*` directory list matches the root `README.md` projects table, the **Which project** dropdown in `.github/ISSUE_TEMPLATE/bug_report.yml`, and `.claude-plugin/marketplace.json` for plugin projects. Find any other hardcoded list with `rg --hidden` for each project name.
- `package.json` has `"type": "module"`, `"engines": { "node": ">=22" }`, and `dev`, `typecheck`, `test`, `build` scripts. `typecheck` is `tsgo --noEmit`, with `@typescript/native-preview` in `devDependencies`.
- `tsconfig.json` sets `strict: true`.
- Every env var the source reads (`rg -o 'process\.env\.\w+'` plus any `env[...]` lookups) is in `.env.example`, with a placeholder value.
- The Node version agrees across `engines`, every `node-version:` in `.github/workflows/`, and the docs.

## 5. Dependencies

Per project:

- `npm audit` and `npm audit signatures`. A signature failure is a stop-the-sweep finding.
- `npm outdated`. For each update, check its publish date with `npm view <pkg> time --json`. Hold anything published under 7 days ago, unless it fixes a high or critical advisory.
- Read the release notes for every minor and major you would take.
- Apply in-range and minor updates with `npm update --ignore-scripts`. Review the lock file diff: no new registry hosts, no lost integrity hashes, no surprise new packages. Then rerun step 1 for that project.
- Leave majors in the ledger with what breaks.
- Find unused and missing dependencies with knip ([tools.md](tools.md)). Remove an unused one only after `rg` confirms nothing imports it, including configs and scripts.
- Leave each project's own `version` alone. For `mcp-server`, merging a version bump publishes a release (`AGENTS.md`, Releasing something downloadable).

## 6. Docs

- Run lychee over every tracked `*.md` ([tools.md](tools.md)): offline first for relative links and anchors, then online. Retry an external failure once before recording it.
- lychee cannot resolve an anchor on a directory link. Check those against the directory's `README.md` by hand.
- Every `npm run <script>` quoted in a project's docs exists in that project's `package.json`.
- Credit costs and rate limits quoted in docs match the public [API reference](https://docs.modash.io). Record both values on a mismatch; do not guess.
- `SECURITY.md`, `CONTRIBUTING.md` and `.github/ISSUE_TEMPLATE/config.yml` still point at working contacts and pages.

## 7. Public-repo hygiene

- Run gitleaks over the full git history, not only the working tree ([tools.md](tools.md)).
- No tracked `.env` other than `.env.example` (`git ls-files`).
- Fixtures and examples stay obviously synthetic: no real-looking emails, creator handles or profile photo URLs.
- A real secret is compromised even if it only lives in history. Record it for rotation; deleting it in a commit does not help.

## 8. Fix and report

- Fix mechanical items: lists, links, scripts, `.env.example`, in-range dependency updates, zizmor safe fixes that keep `audit-ci.mjs` green. One Conventional Commit per logical change.
- Defer with a reason: majors, policy changes (new Dependabot ecosystems, cooldown settings), anything that changes API calls or credit cost, anything needing a version bump, settings changes, suspected secrets.
- Rerun step 1 after the last fix. Done when it passes again.
- Open a draft PR titled `chore: repo maintenance sweep`, using `.github/pull_request_template.md`. Under **What this changes**, put three short lists: fixed, deferred with reason, needs a maintainer decision. Put the triage digest after them.
