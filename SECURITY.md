# Security policy

## What this policy covers

This repo contains **example projects**, not Modash production systems. Where you report
something depends on where the problem is:

| Where the problem is | Report it |
| --- | --- |
| The code in this repo — a leaked credential, an injection in a project, a dependency advisory, a pattern that would put a reader's token at risk | [Report a vulnerability](https://github.com/modashio/modash-api-cookbook/security/advisories/new) on this repo |
| The Modash API, the Modash platform, or any modash.io service | [`hello@modash.io`](mailto:hello@modash.io) |
| Anything involving personal data | [`privacy@modash.io`](mailto:privacy@modash.io) |

**Please don't open a public issue for a security problem.** GitHub's private vulnerability
reporting keeps the report between you and the maintainers until there's a fix.

If you can't use GitHub's reporting form, email [`hello@modash.io`](mailto:hello@modash.io) and
say up front that the message is a security report.

## What to include

The more of this you have, the faster it gets fixed:

- Which project, and the commit or version you saw it on
- What an attacker can do with it, concretely
- Steps to reproduce — please use [mock mode](./AGENTS.md#respect-credits) rather than a live
  token where you can
- Any suggested fix

Please **don't include real API tokens, real Modash API responses, or real creator data** in a
report. Synthetic reproductions are just as useful and this repo's ground rules forbid us from
storing the alternative. If a token is genuinely central to the report, say so and we'll find a
channel for it.

## What to expect

We aim to acknowledge a report quickly and keep you updated while we work on it. There is no
paid bug bounty for this repo. If you'd like credit in the fix or advisory, say so and we'll
include it.

## Supported versions

Only the `main` branch is maintained. These are reference projects rather than a versioned
product, so fixes land on `main` and there are no backports or patch releases for older
commits.

## How CI is protected

This repo is public, so CI runs code from anyone who opens a pull request. Those jobs are built
to be worth nothing to an attacker: no secrets, a read-only token, no `pull_request_target`,
actions pinned to commit SHAs, and installs done with `npm ci --ignore-scripts` so no
dependency's install hook runs in the runner.
[`.github/scripts/audit-ci.mjs`](./.github/scripts/audit-ci.mjs) checks all of that on every
build. A way around it is a vulnerability in this repo — please report it.

## Scope notes for readers running these projects

Two things worth knowing before you point a project at anything real:

- **The projects are single-user local development apps.** Nothing here authenticates its own
  callers, because an auth layer would obscure the API integration these exist to demonstrate.
  Whoever reaches the port is talking to a server that holds your Modash token, so they can
  spend your credits. The MCP server binds loopback unless you widen it deliberately; the
  agentic search project's API and dev server both bind every interface, so on a shared
  network anyone who can reach the port can drive it. Treat the port as the security boundary
  and don't put either on a public URL as-is. The per-session credit budget limits the damage;
  it is not a security control.
- **Your Modash token is a long-lived bearer token tied to your billing account.** Treat it
  like a password. Every project reads it from an environment variable, keeps it server-side
  and never ships it to the browser — preserve that if you adapt the code.

### If you leak your own token

Rotate it at [marketer.modash.io/developer](https://marketer.modash.io/developer). A token
committed to git is compromised even after you delete the line, because it stays in the
history — rotating is the fix, not a follow-up commit. Then check your credit balance with
`GET /user/info` for spend you don't recognise.
