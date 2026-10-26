# AGENTS.md

Guidance for coding agents (and humans) working in this repository.

## What this repo is

`modash-api-cookbook` is a **public** collection of standalone example projects built on the
[Modash API](https://docs.modash.io). Each directory under `projects/` is an independent app
that a prospective or existing Modash customer can clone, point at their own API token, and
read as reference material.

The audience is a developer evaluating or integrating the API. Optimise for **readability over
cleverness**: someone should be able to follow the request/response flow by reading top to
bottom, without a debugger.

## Ground rules for a public repo

Read this section before writing any file.

### Never commit secrets

- No API tokens, cookies, session ids, or model provider keys — not in code, not in tests, not
  in committed `.env` files, not in example output, not in comments.
- `.env`, `.env.local` and friends are gitignored. Only `.env.example` is committed, and it
  contains **placeholder values only**.
- If you need a token to test something, read it from the environment. If it isn't there, fail
  with a clear message telling the reader where to get one
  ([marketer.modash.io/developer](https://marketer.modash.io/developer)).
- If a secret is ever committed by accident, treat it as compromised: it must be rotated, not
  just removed in a follow-up commit.

### Never commit real API responses

Modash API responses contain third-party personal data: creator names, handles, profile
photos, contact emails, and audience demographics. Do not paste real responses into fixtures,
tests, README examples, or commit messages.

- Fixtures and mock data must be **obviously synthetic** — invented handles, round numbers,
  locally generated placeholder images.
- Illustrative snippets in docs should use the sanitised examples already published in the
  [public API reference](https://docs.modash.io) (e.g. the `instagram` account), or clearly
  fake values.
- No customer names, deal details, or account identifiers anywhere.

### Only document what's public

Everything written here should be verifiable against [docs.modash.io](https://docs.modash.io)
or the public [modash.io](https://www.modash.io) site. Do not add internal endpoints,
unreleased features, infrastructure details, roadmap items, internal ticket references, or
undocumented behaviour discovered by poking at the API. If something is genuinely useful but
undocumented, the right move is to get it into the public docs first.

### Respect credits

Paid endpoints spend real money from the reader's account. Every project must:

- Work end to end in a **mock mode** with no token, so the code can be reviewed and the UI
  demoed for free.
- Make **zero paid API calls** during `install`, `typecheck`, `build`, `lint`, or CI. Automated
  checks must never need a token.
- Track and surface estimated credit spend, and enforce a configurable per-session budget that
  fails loudly when exceeded.
- Prefer the free endpoints (`/user/info`, dictionaries) for anything that doesn't strictly
  need paid data. Per-endpoint costs are in the
  [API reference](https://docs.modash.io); the habits that keep them down are in the
  [root README](./README.md#budget-for-credits-before-you-write-a-loop).

### Respect rate limits

The AI Search endpoints are limited to 1 request per second by default. Serialise calls to
them, back off on `429`, and never fan out parallel paid requests in a project.

### Keep CI unpoisonable

Anyone can open a pull request, and CI then runs their code. That is safe only because the jobs
have nothing worth stealing and nothing they can tamper with.
[`.github/scripts/audit-ci.mjs`](./.github/scripts/audit-ci.mjs) runs first in every build and
fails it when one of these stops being true.

- **No secrets and no `write` permission in anything a pull request can trigger.** A workflow
  with no secrets in it cannot leak one, and every check here passes without credentials. A
  workflow that only runs after a merge, on a tag, or by hand is running reviewed code and may
  have both — that is the line, not write access as such.
- **No `pull_request_target`, no `workflow_run`, no `issue_comment`.** All three pair a
  privileged token with input an outsider controls. Plain `pull_request` gives a fork a
  read-only token and no secrets.
- **Every workflow declares its own `permissions:`.** The repository-wide default is a setting
  you cannot see from the file.
- **Actions pinned to a full commit SHA**, with the version in a trailing comment. A tag is a
  pointer its owner can move, which is how most Actions compromises have worked. Dependabot
  bumps the pins.
- **`npm ci --ignore-scripts`.** `npm ci` makes the lock file the only thing that decides what
  is installed. `--ignore-scripts` stops every `postinstall` in the tree from running code in
  the runner. A dependency that needs its install hooks is a deliberate decision, not one to
  inherit.
- **Lock files resolve to `registry.npmjs.org` and carry integrity hashes.** A tarball URL
  smuggled into `package-lock.json` is one ordinary-looking line in a diff.

Two protections live in repository settings, where the audit cannot see them: **require
approval for all outside collaborators' workflow runs**, and **branch protection on `main` with
the CI checks required**. A required check that never runs blocks the merge — that is what stops
someone deleting the audit job in the same pull request that needs it.

## Layout

```
README.md                    Customer-facing intro: getting API access, credits, first call
AGENTS.md                    This file
.cursor/skills/              Agent skills for this repo; run repo-maintenance for a health check
projects/<project-name>/     One self-contained project per directory
  README.md                  What it does, how to run it, how it maps to the API
  AGENTS.md                  Project-specific notes (only if it adds something)
  package.json               Own dependencies; no workspace linking
  .env.example               Placeholders only
  src/
```

There is deliberately **no monorepo tooling**. Projects do not share code, do not share a lock
file, and are not linked together. Duplication between projects is acceptable and preferred
over indirection — each one has to be readable on its own.

## Repo conventions

- One self-contained project per directory under `projects/`.
- **TypeScript**, `strict: true`, ESM (`"type": "module"`) everywhere.
- **`tsx`** runs server and CLI code directly; no build step for the backend.
- Typecheck with **`tsgo`** (`@typescript/native-preview`), not `tsc`. Project scripts
  should wire `npm run typecheck` to `tsgo --noEmit`.
- No API token is ever required to install, typecheck, or build a project.
- **Express** for HTTP, **Vercel AI SDK** (`ai`, `@ai-sdk/react`) for model calls and streaming,
  **React + Vite** for UI.
- **Zod** for validating anything crossing a boundary: HTTP request bodies, agent tool inputs,
  and API responses.
- Keep the Modash HTTP layer isolated in its own module (`src/server/modash/`) so a reader can
  see exactly which endpoints are hit and what they cost. Business logic goes elsewhere.
- Never expose the Modash token to the browser. All Modash calls happen server-side; the
  frontend only talks to the project's own `/api/*` routes.
- The code is the source of truth. Write a comment only when it is the only way to explain an
  edge case the code cannot show on its own — an API quirk, a cost trade-off, a workaround that
  looks wrong without the reason. Never narrate what the code already says. If you are unsure,
  leave it out.
- Node.js 22+ (the AI SDK requires it).

## Demos and screen recordings

- **Use Computer Use to record, even when the UI is a browser app.** It captures the real
  screen: a real window, real cursor movement, real scrolling. A headless browser screencast
  is not a substitute — there is no pointer, so clicks look like things happening by
  themselves, and it shows a viewport rather than a desktop.
- **If Computer Use isn't available in a session, say so.** Don't silently fall back to a
  scripted headless capture; the result is worse and the reader has no way to tell how it was
  made.
- **Record demos in mock mode unless the audience is internal.** A recording made against a
  live token shows real creator handles, profile photos, contact emails and audience
  demographics — the same third-party personal data this repo forbids committing. The rule
  doesn't stop applying because the data is in a video.
- Keep it short and let the interesting moments breathe. Speeding a long agent run up two or
  three times is fine; a demo nobody watches to the end proves nothing.

## Working on a project

```bash
cd projects/<project-name>
npm install
cp .env.example .env          # then fill in your own values
npm run dev                   # API + web UI
npm run typecheck             # must pass, no token needed
npm run build                 # must pass, no token needed
```

Mock mode (`MODASH_MOCK=true`) is the default development path when you don't have a token.
Use it for anything UI-related.

## Adding a new project

Open an issue with the [Suggest a project](./.github/ISSUE_TEMPLATE/project_request.yml)
template first and agree scope. One workflow end to end beats a tour of every endpoint.

Work through every item below. The easy misses are the repo-wide wiring steps — CI matrix,
root README, and the bug-report project dropdown — not the project directory itself.

### Scaffold

- [ ] Create `projects/<kebab-case-name>/` as a self-contained app. No workspace linking, no
      shared lockfile, no imports from sibling projects.
- [ ] Own `package.json` with `"type": "module"`, `"engines": { "node": ">=22" }`, and scripts
      for `dev`, `typecheck`, `test`, and `build`.
- [ ] Own `tsconfig.json` with `strict: true`.
- [ ] Typecheck with **`tsgo`** (`@typescript/native-preview`): `npm run typecheck` →
      `tsgo --noEmit`. Use `tsx` to run server/CLI code; no backend build step unless the
      project ships a compiled artifact (e.g. an MCP binary).
- [ ] Own `.env.example` with **placeholder values only**. Document every variable the project
      reads. Never commit `.env`.
- [ ] Commit the `package-lock.json`. CI installs with `npm ci --ignore-scripts`, so a project
      without one, or one that needs a dependency's install hooks, does not build.
- [ ] Own `README.md`: what it shows, how to run it in mock mode, how to run it with a live
      token, which Modash endpoints it hits, and what a typical session costs in credits.
- [ ] Optional project `AGENTS.md` only if it adds project-specific notes beyond this file.
- [ ] Keep the Modash HTTP layer in `src/server/modash/` (or equivalent). Never expose the
      Modash token to the browser; the frontend talks only to the project's own `/api/*`
      routes.

### Mock mode, credits, and rate limits

- [ ] Mock mode works with no token from the first commit. Default on when
      `MODASH_API_TOKEN` is unset. Fixtures are obviously synthetic.
- [ ] `npm install`, `npm run typecheck`, `npm test`, and `npm run build` make **zero** paid
      API calls and need **no** environment variables.
- [ ] Every paid call is credit-metered, behind a configurable per-session budget that fails
      loudly when exceeded, and serialised / backed off on `429`. No parallel paid fan-out.
- [ ] Prefer free endpoints (`/user/info`, dictionaries) wherever they suffice.

### Repo-wide wiring (easy to miss)

- [ ] Add a row to the projects table in the [root README](./README.md#projects).
- [ ] Add the directory name to the `project` matrix in
      [`.github/workflows/ci.yml`](./.github/workflows/ci.yml). CI runs per project; a project
      missing from the matrix is never built or tested and the green check means nothing. The
      CI audit fails the build if you forget.
- [ ] Add the directory name to the **Which project** dropdown in
      [`.github/ISSUE_TEMPLATE/bug_report.yml`](./.github/ISSUE_TEMPLATE/bug_report.yml).
      Bug reports otherwise have no way to name the new project.
- [ ] Skim
      [`.github/ISSUE_TEMPLATE/project_request.yml`](./.github/ISSUE_TEMPLATE/project_request.yml)
      and [`.github/ISSUE_TEMPLATE/config.yml`](./.github/ISSUE_TEMPLATE/config.yml). Update
      them only if the new project changes how people should file requests or contact links
      (usually a no-op).
- [ ] When opening the PR, fill the **New project** section of
      [`.github/pull_request_template.md`](./.github/pull_request_template.md) as well as the
      shared checklist. Do not delete that section for a new-project PR.
- [ ] If the project is installable as a Claude Code plugin, wire it into
      [`.claude-plugin/`](./.claude-plugin/) and document the install command in the root
      README. Skip when it is not a plugin.
- [ ] Search with `rg --hidden` for the other project directory names and any hardcoded
      project lists. Dotfiles and `.github/` are the usual place a rename or addition is
      missed.

### Verify before you push

- [ ] From `projects/<name>`, with a clean env:
      `npm install && npm run typecheck && npm test && npm run build`.
- [ ] `npm run dev` works in mock mode and the README's "no token" path is accurate.
- [ ] Diff contains no tokens, keys, real API responses, or real creator data.
- [ ] Everything documented is verifiable against [docs.modash.io](https://docs.modash.io) or
      [modash.io](https://www.modash.io).

## Releasing something downloadable

Some projects ship an artefact a reader installs rather than clones — currently the MCP server's
`.mcpb` bundle. Those are published as **GitHub release assets**, built by a workflow from the
released commit, so no binary is ever committed and none is ever built on someone's laptop.

- **Releasing is merging.** A project's version is the switch: land a pull request that raises it
  and the workflow tags the merge commit and publishes. There is no separate release step to
  remember, and no window where `main` claims a version that nothing has published.
- **Bump the version in every manifest that carries one, in the same pull request.** The build
  fails on a disagreement, so a half-done bump blocks the release rather than shipping a bundle
  that lies about its version.
- Tags are project-scoped (`mcp-server-v1.2.3`), because projects version independently. Pushing
  one by hand releases a commit that is not the tip of `main`; nothing else publishes.
- A workflow no pull request can trigger is allowed secrets and `write`
  (see [Keep CI unpoisonable](#keep-ci-unpoisonable)), but the release build here takes neither
  beyond the write access the release itself needs, and must not spend credits. Everything it does
  works without a Modash token.
- Whatever is published must be started and exercised by the workflow first. Validating that a
  bundle is well-formed is not the same as knowing that it runs.

### Cutting a release of the MCP bundle

1. **Bump the version in all four places in the same commit** —
   [`package.json`](./projects/mcp-server/package.json) (with `npm version patch --no-git-tag-version`,
   so the lock file follows),
   [`.claude-plugin/plugin.json`](./projects/mcp-server/.claude-plugin/plugin.json),
   [`plugin/mcpb/manifest.json`](./projects/mcp-server/plugin/mcpb/manifest.json) and `SERVER_INFO`
   in [`src/mcp/server.ts`](./projects/mcp-server/src/mcp/server.ts), which is the
   `serverInfo.version` clients see. `npm test` fails
   when they disagree, and so does the release build, so a half-done bump blocks the release rather
   than publishing a bundle that lies about its version.
2. **Check it locally**, from `projects/mcp-server`, with no env vars set:
   `npm ci --ignore-scripts && npm run typecheck && npm test && npm run build:mcpb && npm run verify:mcpb`.
   The last one unpacks the bundle and starts it; the rest is what CI runs anyway.
3. **Open a pull request and merge it.** That is the release. The workflow tags the merge commit,
   rebuilds the bundle, verifies it again and publishes it with a checksum.
4. **Check the run finished and the release exists.** If it failed on something transient, re-run
   it from the Actions tab: a re-run keeps the event that started it, so it still publishes.

Things not to do, each of which produces a release nobody can reproduce or trust:

- **Do not create the tag, the release, or the asset by hand.** `gh release create` from a laptop
  uploads a bundle built on that laptop, from a tree nobody reviewed.
- **Do not commit a `.mcpb`.** `build/` is gitignored. The artefact belongs to the release, not to
  the history.
- **Do not bump the version in a pull request that is not meant to release.** Merging it publishes.
- **Do not retag to fix a bad release.** Bump the patch version and merge again; the tag and the
  bundle it points at are what a checksum in the wild refers to.

### If you are the client, not the author

An agent or harness that has this server *installed* — as a Claude Code plugin, a Claude Desktop
bundle, or a command in an MCP config — does not get new versions for free. Nothing here updates
itself by default, and the one path that can is off unless someone turns it on. The per-client
commands are in
[the project README](./projects/mcp-server/README.md#keeping-it-up-to-date). Two rules regardless
of client:

- **Check what is running, not what is on disk.** The MCP `initialize` response carries
  `serverInfo.version`, which is the version of the code answering tool calls. A manifest or a
  `package.json` in a working copy can say something else.
- **Never patch an installed copy in place.** Editing an unpacked bundle in Claude Desktop's
  extensions directory, or `dist/` in a clone, produces a server whose behaviour matches no commit
  and which the next legitimate update silently discards.

## Before you open a PR

- [ ] `npm run typecheck`, `npm test` and `npm run build` pass with **no** env vars set.
- [ ] `git diff` contains no tokens, keys, or real API responses.
- [ ] No real creator handles, names, photos, emails, or audience data.
- [ ] Everything documented is verifiable against the public docs.
- [ ] Any new paid API call is credit-metered, budget-capped, and rate-limited.
- [ ] The README explains cost implications of running the project.
- [ ] If you touched anything in `.github/`, `node .github/scripts/audit-ci.mjs` still passes.
- [ ] If this PR adds a project, the [Adding a new project](#adding-a-new-project) checklist
      is complete — including CI matrix, root README row, bug-report dropdown, and the PR
      template's **New project** section.
- PR titles and commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:`, …).
- Documentation-only changes can skip CI. GitHub reads `[skip ci]` from the **commit message**,
  not the PR title — though a squash merge turns the title into one, so suffixing the title
  skips the run on `main`. Two things to know: a skipped run leaves its checks pending, which
  blocks the merge if any of them are required, and the match is a plain substring, so a commit
  message that merely *mentions* the marker skips CI too. Write around it when you need to.

## Working style

- **Write simply.** Short sentences. Plain words. No flourish. This covers docs, comments,
  commit messages, PR descriptions and replies to maintainers. If a sentence can be shorter,
  make it shorter. If a word has a simpler synonym, use it.
- **Search with `rg --hidden`.** Ripgrep skips dotfiles and dot-directories by default and does
  not tell you, so a repo-wide search silently misses `.github/`, `.claude-plugin/`, `.cursor/`
  and every `.env.example`. A rename that looks finished usually isn't.
- **Don't watch CI.** Push and move on. CI runs what you can run locally
  (`npm run typecheck && npm test && npm run build`, no env vars), so a green local run is the
  signal.
- **Describe the change, not the journey.** A PR description and a commit message say what
  changed and why it matters to the reader. They are not a log of merges, syncs, review rounds,
  false starts or the order you did things in. Nobody reading the history later needs that.
- **"Remember this" means write it here.** Add it to this file in the same change. A preference
  kept only in one session is lost.

## Cursor Cloud specific instructions

There is **no root `package.json`**. Each project under `projects/` is standalone with its own
dependencies and lockfile, so the startup install step installs each one separately (loops over
`projects/*/package.json`). Adding a new project is picked up automatically.

- **Per-project commands.** Always `cd projects/<name>` first; there is no root task runner. The
  standard scripts are in each project's `package.json` and `README.md`/`AGENTS.md`:
  `npm run dev`, `npm run typecheck`, `npm test`, `npm run build`. All of typecheck/test/build
  pass with **no** env vars set and spend no credits.
- **Both dev servers default to `PORT=3000`.** To run `projects/agentic-influencer-search`
  (Express API on `:3000`, Vite UI on `:5173`) and `projects/mcp-server` at the same time, start
  the MCP server on another port, e.g. `PORT=3100 npm run dev`.
- **Mock mode is automatic without a token.** Both projects serve synthetic fixtures and spend no
  credits when `MODASH_API_TOKEN` is unset — this is the default dev/demo path.
- **The agentic search project's chat needs a model provider key even in mock mode.**
  `MODASH_MOCK` only mocks the Modash API; the agent loop still calls a real LLM, so the browser
  chat needs `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (see its `.env.example`). Without one, the UI
  loads but a submitted brief fails with "No model provider key found." The full agent loop is
  still covered headlessly by `npm test`, which drives the real `/api/chat` route with a scripted
  model.
- **`mcp-server` needs no keys to exercise end to end.** Start it (`npm run dev`) and connect any
  MCP client to `http://localhost:<port>/mcp`; tool calls return synthetic data with credit
  metering in mock mode. The HTTP transport binds loopback, so reach it over `localhost` or set
  `MODASH_HTTP_HOST`.
- Node 22 is required. Node 22.14 emits harmless `EBADENGINE` warnings for the optional
  `@modelcontextprotocol/inspector` dev tool (wants `>=22.19`); installs and all scripts still work.
