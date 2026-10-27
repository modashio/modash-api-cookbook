# Modash API Cookbook

Runnable example projects built on the [Modash API](https://www.modash.io/influencer-marketing-api) —
a creator database covering Instagram, TikTok and YouTube, with search, profile reports
including audience demographics, and brand collaboration history.

The [API reference](https://docs.modash.io) documents every endpoint, its parameters and what
it costs. This repo is the part a reference can't show you: complete working apps you can
clone, point at your own token, and read. If you're evaluating whether the API fits your
product, running one of these against a trial token is faster than reading a spec.

**No API access yet?** [Request an intro to the Modash API →](https://www.modash.io/influencer-marketing-api?utm_source=github&utm_campaign=api_cookbook)
Meanwhile, every project here runs in a **mock mode** with no token at all, so you can try the
UI and read the code before you talk to anyone.

---

## Projects

| Project | What it shows | Stack |
| --- | --- | --- |
| [`projects/agentic-influencer-search`](./projects/agentic-influencer-search) | An agent that turns a vague brief ("we're launching a magnesium sleep supplement, find me creators") into structured [AI Search](https://www.modash.io/influencer-marketing-api/ai-search) queries, critiques its own results, and builds a shortlist | Node.js + tsx, TypeScript, Express, Vercel AI SDK, React, Tailwind CSS, TanStack Query |
| [`projects/mcp-server`](./projects/mcp-server) | An [MCP](https://modelcontextprotocol.io) server that hands creator search, profile reports and collaboration history to Claude, Cursor, Codex or any other MCP client — metering credit spend per call and refusing anything that would breach a session budget. Includes a priced, end-to-end brand crossover analysis: do creators who post about one brand also post about its rival? Optional [RAW API](https://www.modash.io/influencer-marketing-api/raw) tools for live platform data | Node.js + tsx, TypeScript, MCP TypeScript SDK, Zod, Express |

Every project runs standalone: `cd` into it, install, add a token, run. There is no monorepo
tooling, no shared build step, and nothing to bootstrap at the root.

### Install into Claude

This repository is also a Claude Code plugin marketplace, so a project that ships as a plugin can
be installed without cloning anything:

```
/plugin marketplace add modashio/modash-api-cookbook
/plugin install modash-api-mcp@modash-api-cookbook
```

For Claude Desktop, download the `.mcpb` bundle from the
[latest release](https://github.com/modashio/modash-api-cookbook/releases?q=mcp-server&expanded=true)
and double-click it. Not on Claude? The same server
runs in [Cursor](./projects/mcp-server#install-it-into-cursor),
[Codex](./projects/mcp-server#install-it-into-codex),
[Notion](./projects/mcp-server#install-it-into-notion-or-anything-else-that-only-takes-a-url) and
anything else that speaks MCP — the project's README has the config for each. Either way, it runs
on synthetic fixtures until you give it a token, so it costs nothing to try.

---

## What you can build with

Product pages, if you're still scoping what to buy:

- **[Discovery API](https://www.modash.io/influencer-marketing-api/discovery)** — search,
  reports and dictionaries. What most product teams want, and what the projects here use.
  - **[AI Search](https://www.modash.io/influencer-marketing-api/ai-search)** — natural-language
    and image-based creator discovery
  - **[Creator Lookalikes](https://www.modash.io/influencer-marketing-api/creator-lookalikes)** —
    find creators similar to ones you already work with, across platforms
  - **[Collaborations](https://www.modash.io/influencer-marketing-api/collaborations-api)** —
    past brand partnerships, for vetting and competitor tracking
- **[RAW API](https://www.modash.io/influencer-marketing-api/raw)** — lower-level access to raw
  social data. Sold separately from Discovery.

[Pricing](https://www.modash.io/influencer-marketing-api/pricing) ·
[API overview](https://www.modash.io/influencer-marketing-api) ·
[If you're building a platform](https://www.modash.io/influencer-marketing-api/builders)

---

## Getting set up

### Get access

The API is a commercial product, so tokens are issued per account rather than self-served from
a signup form. [Request an intro](https://www.modash.io/influencer-marketing-api?utm_source=github&utm_campaign=api_cookbook)
if you're new to Modash. If you're already a customer, check with whoever owns your account —
API access is a separate product from the Modash platform UI and may already be enabled.

Two things worth being explicit about in that conversation:

- **Which product you need.** Discovery API or RAW API, per the list above.
- **What you need for evaluation.** A credit allowance so you can build against real data, and
  a higher AI Search rate limit if you plan to fan out searches.

Your token lives at [marketer.modash.io/developer](https://marketer.modash.io/developer). It's
a long-lived bearer token tied to your billing account, so treat it like a password: keep it
server-side and out of version control. Every project here reads it from an environment
variable and never ships it to the browser.

### Confirm auth without spending anything

`GET /user/info` and the dictionary endpoints cost zero credits, which makes them the right
first call:

```bash
export MODASH_API_TOKEN="your-token-here"

curl -s https://api.modash.io/v1/user/info -H "Authorization: Bearer $MODASH_API_TOKEN"
```

That returns your remaining credit balance and your rate limits, both worth watching while you
develop. A couple of paid endpoints are also free to call with specific arguments — see
[Testing the API](https://docs.modash.io/products/discovery_api/openapi_doc/discovery/section/testing-the-api) —
so you can inspect full response shapes at no cost before writing any code.

### Budget for credits before you write a loop

Credits are consumed per **result**, not per request. Per-endpoint costs are in the
[reference](https://docs.modash.io) and plan-level allowances are on the
[pricing page](https://www.modash.io/influencer-marketing-api/pricing). The shape of it is that
search-type calls cost a small fraction of a credit per profile returned, while a full profile
report costs a whole credit. That gap is why the standard pattern is *search broadly, then pull
reports only for the shortlist*.

Failed requests (5xx, timeouts) aren't billed, so retrying them is free.

Two habits that save real money while developing:

1. **Log the cost of every paid call** and keep a running total for the process. The agentic
   search project does this and streams the number into the UI.
2. **Cap it.** Give yourself a hard per-session credit budget in code and fail loudly when you
   hit it, rather than finding an accidental pagination loop on next month's invoice.

### Branch on error codes, not messages

Errors arrive with a non-`200` status, a stable machine-readable `code`, and a human-readable
`message`. Switch on `code` — messages change without notice. The full list is in the
[reference](https://docs.modash.io); the ones you'll hit while building are
`api_token_invalid`, `not_enough_credits`, `feature_not_available` (the endpoint isn't on your
plan) and `no_result` (filters too narrow).

---

## Talk to us

- **Scoping an integration or want access:** [request an intro to the API](https://www.modash.io/influencer-marketing-api?utm_source=github&utm_campaign=api_cookbook).
  Bring your use case and expected volume; that conversation covers which endpoints you
  actually need and what it costs.
- **Want to see the platform first:** [book a demo](https://www.modash.io/book-demo?utm_source=github&utm_campaign=api_cookbook).
- **Already a customer with an integration question:** the [API reference](https://docs.modash.io)
  and [help.modash.io](https://help.modash.io) answer most of them, including error codes, rate
  limits and filter behaviour. Your Modash contact is there for what they don't.
- **Something wrong in this repo:** [open an issue](https://github.com/modashio/modash-api-cookbook/issues/new/choose).
  Security problems go through [private reporting](./SECURITY.md) instead.

---

## Contributing

Bug reports, fixes and suggestions for new examples are all welcome —
[`CONTRIBUTING.md`](./CONTRIBUTING.md) covers what belongs here and how to run the checks.
The full conventions, for contributors and coding agents alike, live in
[`AGENTS.md`](./AGENTS.md). Participation is governed by the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[MIT](./LICENSE)
