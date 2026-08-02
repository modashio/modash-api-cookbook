<!--
Title should follow Conventional Commits: feat: / fix: / docs: / chore: …
Documentation-only PRs get a [skip ci] suffix.
-->

## What this changes

<!-- What the reader of this repo gets that they didn't have before. Link any related issue. -->

## Why

<!-- Especially for changes to how a project talks to the API: what was misleading, wrong or
     more expensive before? -->

## How it was verified

<!-- Which of these you ran, and anything you checked by hand. Screenshots welcome for UI. -->

- [ ] `npm run typecheck` passes with **no env vars set**
- [ ] `npm test` passes with **no env vars set**
- [ ] `npm run build` passes with **no env vars set**
- [ ] Ran it in mock mode (no Modash token)
- [ ] Ran it against a live Modash token

## Public-repo checklist

See [`AGENTS.md`](https://github.com/modashio/modash-api-cookbook/blob/main/AGENTS.md#before-you-open-a-pr) for the full version.

- [ ] The diff contains **no tokens or keys**, and no committed `.env`
- [ ] The diff contains **no real API responses** — no real creator names, handles, photos, emails or audience data. Mock data is obviously synthetic.
- [ ] Everything documented is verifiable against [docs.modash.io](https://docs.modash.io) or [modash.io](https://www.modash.io) — no internal endpoints, unreleased features or customer references
- [ ] No paid API call happens during install, typecheck, test or build

## Credits and rate limits

<!-- Delete this section if the change adds no calls to paid endpoints. -->

- [ ] Any new paid call is credit-metered, budget-capped, and serialised behind the project's rate limiter, like the existing ones
- [ ] The README explains what the change costs to run

## New project

<!-- Delete this section unless the PR adds a directory under projects/. Full checklist:
     https://github.com/modashio/modash-api-cookbook/blob/main/AGENTS.md#adding-a-new-project -->

- [ ] Scoped in a [project-request issue](https://github.com/modashio/modash-api-cookbook/issues/new?template=project_request.yml) before building
- [ ] Own `package.json`, `tsconfig.json`, `.env.example` (placeholders only), and `README.md`
- [ ] Mock mode works with no token; fixtures are obviously synthetic
- [ ] Paid calls are credit-metered, budget-capped, and rate-limited
- [ ] Row added to the [projects table](https://github.com/modashio/modash-api-cookbook/blob/main/README.md#projects) in the root README
- [ ] Directory name added to the `project` matrix in [`.github/workflows/ci.yml`](https://github.com/modashio/modash-api-cookbook/blob/main/.github/workflows/ci.yml)
- [ ] Directory name added to the **Which project** dropdown in [`.github/ISSUE_TEMPLATE/bug_report.yml`](https://github.com/modashio/modash-api-cookbook/blob/main/.github/ISSUE_TEMPLATE/bug_report.yml)
- [ ] Skimmed `project_request.yml` and `config.yml`; updated only if contact links or request guidance changed
- [ ] `npm install && npm run typecheck && npm test && npm run build` passes in `projects/<name>` with **no env vars set**
