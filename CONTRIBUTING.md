# Contributing

Thanks for looking. This repo is a set of standalone example projects for the
[Modash API](https://docs.modash.io) — each one exists to be cloned, run against your own
token, and read as reference material.

That purpose shapes what belongs here. The bar for a change isn't "does it work", it's **does
it make the API easier to understand for someone seeing it for the first time**.

## Where to take things

| You want to | Go here |
| --- | --- |
| Report a bug in a project | [Open an issue](https://github.com/modashio/modash-api-cookbook/issues/new/choose) |
| Suggest a project | [Open an issue](https://github.com/modashio/modash-api-cookbook/issues/new/choose) |
| Know how an endpoint behaves, or what it costs | [docs.modash.io](https://docs.modash.io) |
| Work out an error, a rate limit or a filter | [help.modash.io](https://help.modash.io) |
| Get API access or credits | [Request an intro](https://www.modash.io/influencer-marketing-api?utm_source=github&utm_campaign=api_cookbook) |
| Report a security vulnerability | [`SECURITY.md`](./SECURITY.md) — **not** a public issue |

This tracker is for the code in this repo. The API's own behaviour is documented in the reference
and the help centre, and reading them is faster than waiting on a reply here — so please look
there first, and open an issue when the docs and a project disagree.

## Before you write code

Read [`AGENTS.md`](./AGENTS.md). It is the full conventions document — for humans as much as
for coding agents — and it covers the layout, the TypeScript/Express/React stack, and the
[ground rules](./AGENTS.md#ground-rules-for-a-public-repo) that a public repo built on a paid,
personal-data-heavy API has to follow.

Four of those rules reject a PR outright, so they're worth repeating here:

1. **No secrets.** No API tokens, cookies, session ids or model provider keys — not in code,
   tests, fixtures, committed `.env` files, example output, or commit messages. Only
   `.env.example` is committed, with placeholders.
2. **No real API responses.** Modash responses contain third-party personal data — creator
   names, handles, profile photos, contact emails, audience demographics. Fixtures and mock
   data must be **obviously synthetic**: invented handles, round numbers, locally generated
   placeholder images.
3. **No credits spent by automated checks.** `install`, `typecheck`, `test` and `build` must
   pass with **no environment variables set at all**. CI is given no token by design.
4. **Only document what's public.** Everything stated here should be verifiable against
   [docs.modash.io](https://docs.modash.io) or [modash.io](https://www.modash.io). No internal
   endpoints, unreleased features, ticket references, or customer names.

## Working on a project

Each project is self-contained. There is no monorepo tooling, no shared lock file, and nothing
to bootstrap at the root — `cd` into the one you're changing. Every project pins **Node.js
22+** in its `engines`, and older versions fail in ways that don't point at the cause.

```bash
cd projects/<project-name>
npm install
cp .env.example .env   # then fill in your own values
npm run dev
npm test
npm run typecheck
npm run build
```

Mock mode is how you develop without spending credits. It turns itself on whenever
`MODASH_API_TOKEN` is empty, so there's nothing to configure — set `MODASH_MOCK` explicitly
only when you want to force it on while a token is present.

Mock mode replaces the *Modash* token, and only that. `agentic-influencer-search` calls a real
LLM of its own, so `npm run dev` there also needs `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`
before it will answer anything; its `npm test` needs neither, because it drives the agent with
a scripted model. `mcp-server` needs no model key at all — the MCP client brings the model.

Read the project's own README first. They differ more than the shared commands suggest: one is
an Express API with a React UI, the other is a headless MCP server with stdio and HTTP
transports.

Duplication between projects is fine, and preferred over indirection. Each project has to be
readable top to bottom on its own, so don't factor shared code out into a common package.

## Adding a new project

Follow [the full checklist in `AGENTS.md`](./AGENTS.md#adding-a-new-project). In short:

1. Open an issue with the
   [Suggest a project](./.github/ISSUE_TEMPLATE/project_request.yml) template and agree scope
   first. One workflow end to end is more useful than a tour of every endpoint.
2. Scaffold `projects/<kebab-case-name>/` with its own `package.json`, `package-lock.json`,
   `tsconfig.json`, `.env.example` (placeholders only) and `README.md`. Mock mode from the
   first commit. CI installs with `npm ci --ignore-scripts`, so a project without a lock file,
   or one that needs a dependency's install hooks, does not build.
3. Wire the rest of the repo — these are the easy misses:
   - a row in the [projects table](./README.md#projects)
   - the directory name in the `project` matrix in
     [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) (CI runs per project; absent
     means never built)
   - the directory name in the **Which project** dropdown in
     [`.github/ISSUE_TEMPLATE/bug_report.yml`](./.github/ISSUE_TEMPLATE/bug_report.yml)
   - the **New project** section of
     [`.github/pull_request_template.md`](./.github/pull_request_template.md) filled in on
     the PR itself
4. Confirm `npm install && npm run typecheck && npm test && npm run build` passes with no
   environment variables set at all.

## Pull requests

- **Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/)**
  (`feat:`, `fix:`, `docs:`, `chore:`, …). Documentation-only changes can carry `[skip ci]` —
  GitHub reads that from the commit message rather than the PR title.
- **One logical change per commit.** These projects get read as much as run, and a clean
  history is part of that.
- **Run the [pre-PR checklist](./AGENTS.md#before-you-open-a-pr)** and fill in
  [`.github/pull_request_template.md`](./.github/pull_request_template.md). The important
  shared items are that `npm run typecheck`, `npm test` and `npm run build` all pass with no
  env vars set — that's exactly what CI runs, and it gets no token. New-project PRs also fill
  the template's **New project** section (CI matrix, README row, bug-report dropdown).
- **Explain cost.** If your change introduces a call to a paid endpoint, say so in the PR, and
  make sure it's credit-metered, budget-capped and rate-limited like the existing ones.

By opening a pull request you agree to license your contribution under the repo's
[MIT license](./LICENSE).

## Code of conduct

Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).
