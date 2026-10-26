# MCP server for the Modash API

An [MCP](https://modelcontextprotocol.io) server that gives Claude, Cursor, or any other MCP client
access to the [Modash Discovery API](https://docs.modash.io): creator search, profile reports with
audience demographics, brand collaboration history, and the free dictionaries that make the paid
filters work.

It runs with **no token at all**, against synthetic fixtures, so you can wire it into your client
and see how it behaves before deciding whether to buy anything.

It is packaged as a Claude plugin, so trying it takes two lines:

```
/plugin marketplace add modashio/modash-api-cookbook
/plugin install modash-api-mcp@modash-api-cookbook
```

Or run it from source:

```bash
npm install
npm run dev          # Streamable HTTP on http://localhost:3000/mcp
npm run dev:stdio    # the same server over stdio, for desktop clients
```

---

## Why this exists

Wrapping an HTTP API in MCP is close to mechanical: read the OpenAPI document, emit one tool per
operation, done. That version works in a demo and then quietly costs you money, because two things
change once a language model is holding the API instead of a person.

**The caller invents arguments.** Modash validates the top level of a search request but not the
contents of the nested `filter` object. Send `filter.influencer.minFollowers` — a field that does
not exist — and you get HTTP 200, a full page of fifteen creators, and a bill for 0.15 credits. The
filter was ignored; nothing says so. A human notices that the results look wrong. A model writes a
summary of them.

**The caller paginates.** A model asked to "find the best creators" will happily pull reports for
thirty candidates at one credit each, because nothing in a plain wrapper tells it that a report is
sixty-five times more expensive than a dictionary lookup.

So this project is built around the parts that are actually hard: knowing what a call costs before
you make it, refusing the ones you cannot afford, validating what the model wrote before it becomes
a charge, and parsing responses that do not match their own specification.

---

## What it costs to run

**Mock mode costs nothing.** It is the default whenever `MODASH_API_TOKEN` is unset, no request
leaves the process, and `npm install`, `npm run typecheck`, `npm run build` and `npm test` never
touch the network.

Against a real token, cost depends entirely on which tools the model reaches for. Per-endpoint
prices are in the [API reference](https://docs.modash.io):

| Tool | Credits | Notes |
| --- | --- | --- |
| `modash_get_account` | 0 | Balance, rate limits, and this session's ledger |
| `modash_find_creator` | 0 | Handle to userId. Use before paying for a report |
| `modash_lookup_dictionary` | 0 | Location, interest, brand, language, topic and hashtag ids |
| `modash_lookup_ai_dictionary` | 0 | Brand, hashtag and mention values for AI Search |
| `modash_search_creators` | **0.15** | 0.01 per result, 15 results per page, page size fixed |
| `modash_ai_search_creators` | **0.025 × pageSize** | 0.15 at the default, 1.25 at the maximum |
| `modash_find_lookalikes` | **0.025 × pageSize** | Same pricing as AI Search |
| `modash_get_creator_report` | **1** | The expensive one. Cache it |
| `modash_compare_audience_overlap` | **1** | Flat, however many creators you compare |
| `modash_list_collaborations` | **0.2** | Up to 30 posts |
| `modash_summarise_collaborations` | **0.2** | |
| `modash_find_creators_by_email` | **0.02 per match** | Balance must cover every address submitted |

The six optional RAW tools do not appear here because they do not spend credits at all — they
spend RAW requests, one per call, from a different allowance. See
[the RAW API](#the-raw-api-which-bills-nothing-like-the-above).

Three things follow from that table, and the server enforces all three:

- **A report costs more than six searches.** Search broadly, shortlist from the search results, and
  only then pull reports. The bundled `shortlist-creators` prompt walks a model through exactly
  that order.
- **AI Search is priced by `pageSize`.** At `pageSize: 50` one search costs more than a full profile
  report. The default here is 6.
- **The free tools are not a consolation prize.** Resolving a location name to an id costs nothing
  and is mandatory anyway — a filter containing `"London"` instead of `901` is ignored and billed.

`MODASH_CREDIT_BUDGET` (default 5) is a hard ceiling for the process. The cost of each call is
computed from the request *before* it is sent, and a call that would breach the ceiling is refused
rather than reported afterwards. Every paid tool result also carries what it just spent:

```json
{
  "creators": [ "..." ],
  "cost": {
    "creditsThisCall": 0.15,
    "creditsSpentThisSession": 1.3,
    "creditsRemainingInBudget": 3.7
  }
}
```

Failed requests are not billed by Modash, so nothing lands in the ledger unless the call came back
successfully, and retrying a `429` or a `5xx` is free.

### Exploring on a real token without spending

Two calls are documented as free and are the right way to see real response shapes before you
commit to anything. The ledger knows about both and reports them at zero:

- `modash_search_creators` with `platform: "instagram"` and an **empty** filter.
- `modash_get_creator_report` with `platform: "instagram"` and `userId: "instagram"`.

Adding a filter to the first, or asking for any other creator in the second, makes it an ordinary
paid call.

### The RAW API, which bills nothing like the above

The [RAW API](https://www.modash.io/influencer-marketing-api/raw) is a **separate product**: live,
unfiltered data pulled from the platforms at the moment you ask, rather than Modash's analysis of
it. Set `MODASH_RAW=true` to add its six tools; they are off by default, because an account
without the product answers every one of them with `feature_not_available`, and six dead tools
crowd out the twelve that work.

Three things about it are the opposite of Discovery, and all three change how you write the client:

| | Discovery | RAW |
| --- | --- | --- |
| Metered in | credits (`billing.credits`) | **requests** (`billing.rawRequests`) |
| Cost | varies by endpoint, 0 to 1.25 | **1 per request**, every page included |
| A failed call | **is not billed** | **is billed** |
| Response shape | consistent, documented | whatever the platform returned |

**Failed requests are billed.** This is the one to internalise. Discovery's docs promise that a
`4xx` or `5xx` costs nothing, and they hold — retrying is free. RAW charges for the attempt: a
malformed URL that comes back `400 bad_request` still comes out of your allowance. Which means a
model guessing at identifiers costs real money, so the RAW tools reject every unsupported
platform-and-kind combination locally rather than letting the API bill you for saying no.

That is also why the budget is a separate ledger with a separate unit. `MODASH_RAW_BUDGET` counts
**attempts**, not successes.

**There is no common envelope.** The product promises "data returned as-is, without filtering" and
means it. `/raw/ig/user-info` is a bare object with no wrapper. `/raw/ig/user-feed` is
`{items, more_available, end_cursor}`. `/raw/tiktok/user-feed` is
`{success, user_feed, hasMore, maxCursor}`. `/raw/youtube/uploaded-videos` hides its cursor inside
`videos_list`. Three cursor spellings, three "is there more" conventions, no shared parent.

So the RAW tools return the payload **untouched** — a schema would mean inventing a guarantee the
product does not offer — and normalise exactly one thing: the cursor. Every result carries
`nextCursor` and `hasMore` regardless of what the platform called them, because pagination is the
one thing a caller genuinely cannot do without knowing the shape.

They also take a `maxItems` (default 10) that caps how many entries of each list come back. A feed
page is tens of thousands of tokens; a model that pulls three of them has spent its context before
reading any. The cap is local and the result says `capped: true` when it fires — you paid for the
whole page either way.

---

## Running it

```bash
cd projects/mcp-server
npm install
npm run dev
```

That is the whole setup for mock mode. To point it at the real API:

```bash
cp .env.example .env
# then uncomment MODASH_API_TOKEN and paste your token from
# https://marketer.modash.io/developer
```

Copied as-is, `.env.example` leaves you on fixtures — the token line is commented out, so a copy
you have not filled in yet cannot start spending or start failing on a placeholder.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODASH_API_TOKEN` | — | Your token. Its absence is what turns mock mode on |
| `MODASH_MOCK` | `true` when no token | Force fixtures on or off |
| `MODASH_CREDIT_BUDGET` | `5` | Hard ceiling on credits for this process |
| `MODASH_RAW` | `false` | Expose the RAW API tools. Separate product; see below |
| `MODASH_RAW_BUDGET` | `50` | Hard ceiling on RAW *requests* for this process |
| `PORT` | `3000` | Streamable HTTP port. Ignored on stdio |
| `MODASH_HTTP_HOST` | `127.0.0.1` | Interface the HTTP transport binds to. Widen it only deliberately |

The token is only ever read server-side and sent as `Authorization: Bearer …`. Modash also accepts
it as a query parameter; do not use that, it puts your token in every access log between you and the
API.

### Install it into Claude Code

The repository doubles as a plugin marketplace, so there is nothing to clone:

```
/plugin marketplace add modashio/modash-api-cookbook
/plugin install modash-api-mcp@modash-api-cookbook
/reload-plugins
```

Export `MODASH_API_TOKEN` before starting Claude Code to run against your account; without it the
plugin runs on fixtures. `MODASH_CREDIT_BUDGET` sets the ceiling and defaults to 5.

Claude Code copies the plugin into its cache without running `npm install`, so
[`plugin/launch.mjs`](./plugin/launch.mjs) installs and builds on first launch. That takes a
minute, and a client that gives a server less than that to start will time out — raise it with
`MCP_TIMEOUT=180000` for the first run, or install from a working copy where you have already run
`npm install && npm run build`:

```
/plugin marketplace add ./path/to/modash-api-cookbook
```

### Install it into Claude Desktop

Claude Desktop installs [MCP Bundles](https://github.com/modelcontextprotocol/mcpb) — a zip with a
manifest and a self-contained server — with a double click. There is nothing to clone: download
`modash-api-mcp-<version>.mcpb` from the
[latest release](https://github.com/modashio/modash-api-cookbook/releases?q=mcp-server&expanded=true),
then double-click it or drag it into the Claude Desktop window.

It asks for your token on install and stores it in the OS keychain; leave it blank to run on
fixtures. Dependencies are bundled into a single file, so nothing is installed at run time.

Each release also carries a `.sha256`, and the build is reproducible — the same commit produces
the same bytes — so a bundle you build yourself should match the one you downloaded:

```bash
npm run build:mcpb                       # writes build/modash-api-mcp-1.0.1.mcpb
npm run verify:mcpb                      # unpacks it, starts it, and calls a free tool
shasum -a 256 build/*.mcpb
```

`verify:mcpb` is worth knowing about if you change anything here. Building the bundle checks the
manifest against the schema and stops there, but the server inside it is a single esbuild output
rather than a directory with `node_modules`, so anything that resolved at run time in the source
tree can fail for the first time once packed. Verifying resolves the manifest into a command the
way Claude Desktop does, runs it, and checks that the tools it registers are the ones the manifest
advertises.

Releasing is merging. The version in [`plugin/mcpb/manifest.json`](./plugin/mcpb/manifest.json) is
the switch: land a pull request that raises it and
[`.github/workflows/release-mcpb.yml`](../../.github/workflows/release-mcpb.yml) tags the merge
commit, builds the bundle, verifies it, and publishes the release. Every other push to `main` finds
that version already released and stops. Bump the version in all four places at once —
`package.json`, `.claude-plugin/plugin.json`, the bundle manifest and `SERVER_INFO` in
`src/mcp/server.ts` — or the build fails before anything is published.

Pushing a `mcp-server-v*` tag releases a commit that is not the tip of `main`. Nothing else
publishes: running the workflow from the Actions tab, or pushing a branch, builds and verifies the
bundle and attaches it to the run so you can install it before deciding to release it.

Bundles are unsigned. Claude Desktop installs them anyway — the "unsigned extension" line in its
log is informational — unless an administrator has set `isDesktopExtensionSignatureRequired`, in
which case sign the artifact with `npx mcpb sign` and a code-signing certificate before
distributing it.

### Install it into Cursor

Opening `projects/mcp-server` as a Cursor project needs no setup: [`.cursor/mcp.json`](./.cursor/mcp.json)
is already there, and points at the same launcher the Claude Code plugin uses, so the first
connection installs and builds by itself.

To use it from any other project, add this to `~/.cursor/mcp.json` (global) or the project's
`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "modash": {
      "command": "node",
      "args": ["/absolute/path/to/projects/mcp-server/plugin/launch.mjs"],
      "env": {
        "MODASH_API_TOKEN": "${env:MODASH_API_TOKEN}",
        "MODASH_CREDIT_BUDGET": "5"
      }
    }
  }
}
```

Both files are read and merged, with the project one winning on a name clash. Cursor resolves
`${env:NAME}`, `${workspaceFolder}` and `${userHome}` in `command`, `args`, `env`, `url` and
`headers`, so the token can stay in your shell profile rather than in a file you might commit.
After saving, toggle the server off and on under **Settings → Tools & MCP**; Cursor does not always
notice the edit on its own.

### Install it into Codex

Codex uses TOML, not JSON — a `mcpServers` block pasted from anywhere else will not work. Let the
CLI write it:

```bash
codex mcp add modash \
  --env MODASH_CREDIT_BUDGET=5 \
  -- node /absolute/path/to/projects/mcp-server/plugin/launch.mjs
```

Or write it yourself in `~/.codex/config.toml`, or in a project's `.codex/config.toml` if the
directory is trusted:

```toml
[mcp_servers.modash]
command = "node"
args = ["/absolute/path/to/projects/mcp-server/plugin/launch.mjs"]
# Forward the token from your shell rather than writing it into a file you might commit.
env_vars = ["MODASH_API_TOKEN"]
# The first launch installs and builds, which takes longer than the 10-second default.
startup_timeout_sec = 180

[mcp_servers.modash.env]
MODASH_CREDIT_BUDGET = "5"
```

Run `/mcp` inside a Codex session to check it connected and see the tools. Note that the table key
is `mcp_servers`, with an underscore.

### Install it into Notion, or anything else that only takes a URL

Notion's Custom Agents connect to MCP servers **by URL**, so the stdio entry point above does not
apply — they need the Streamable HTTP transport (`npm run dev`) running somewhere Notion can reach.

A workspace owner or admin first enables custom servers under **Settings → Notion AI → AI connectors
→ Enable Custom MCP servers**. Then, in the agent's **Settings → Tools & Access → Add connection**,
choose **Custom MCP server** and give it the `/mcp` endpoint URL and a display name.

Before you point anything on the public internet at this project, read
[what is not here](#what-is-not-here): the HTTP transport has **no authentication**. It binds to
loopback and checks the `Host` header, which is right for a client on the same machine and not
enough for anything else. The Modash token lives on the server, so whoever reaches that endpoint
spends your credits — put it behind auth, or behind a tunnel only you can open, before exposing it.
The session budget limits the damage but is not a security control.

`MODASH_HTTP_HOST` widens the binding when the client genuinely cannot reach loopback, a container
being the usual reason. Nothing else changes when you set it: the `Host` check stops a browser on
another origin, but any other client on the network can send `Host: localhost` and be let through.
Loopback is the part that actually keeps this endpoint local.

### Any other MCP client

Point it at the stdio entry point directly:

```json
{
  "mcpServers": {
    "modash": {
      "command": "node",
      "args": ["/absolute/path/to/projects/mcp-server/dist/stdio.js"],
      "env": {
        "MODASH_API_TOKEN": "your-token-here",
        "MODASH_CREDIT_BUDGET": "5"
      }
    }
  }
}
```

Run `npm install && npm run build` first, or point at `plugin/launch.mjs` instead of
`dist/stdio.js` to have it do that for you on first launch. Leave `MODASH_API_TOKEN` out to connect
in mock mode.

To poke at it by hand:

```bash
npx @modelcontextprotocol/inspector npx tsx src/stdio.ts     # web UI
npx @modelcontextprotocol/inspector --tui npx tsx src/stdio.ts
```

### Keeping it up to date

New versions are published as
[releases](https://github.com/modashio/modash-api-cookbook/releases?q=mcp-server&expanded=true).
**None of the install paths above updates itself by default**, and the one that can is switched off
until someone switches it on. If you are an agent or a harness running this server, treat updating
as a thing you do on purpose.

First, find out what is actually running. The MCP `initialize` response carries
`serverInfo.version`, and that is the version of the code answering your tool calls — a manifest or
a `package.json` sitting in a working copy can say something else entirely.

| Client | What it takes |
| --- | --- |
| Claude Desktop | Download the new bundle and install it again. There is no update channel |
| Claude Code | `/plugin marketplace update` then `/plugin update`, or turn auto-update on |
| Cursor, Codex, anything on `launch.mjs` | `git pull`, then **rebuild**, then restart the server |

**Claude Desktop.** A bundle installed from a file has nowhere to check for a new one: the
[manifest format](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md) has no field
for an update URL, and Anthropic's guidance is that privately distributed extensions are updated by
installing the newer file. Download the latest `.mcpb` from the releases page and install it the way
you installed the first one. Check the extension's settings afterwards — the token lives in the OS
keychain, and it is worth confirming it survived rather than assuming it did. Only extensions from
Anthropic's own directory update on their own.

**Claude Code.** Refresh the marketplace, then update the plugin, then reload:

```
/plugin marketplace update modash-api-cookbook
/plugin update modash-api-mcp@modash-api-cookbook
/reload-plugins
```

`claude plugin update modash-api-mcp@modash-api-cookbook` does the middle step from a shell, which
is the one a harness wants; the catalog refresh is a slash command in a session.

Auto-update exists and is worth enabling, with two caveats. It is **off by default for this
marketplace** — Claude Code enables it for Anthropic's own marketplaces only — so turn it on under
`/plugin` → Marketplaces, or set `"autoUpdate": true` on the
[`extraKnownMarketplaces`](https://code.claude.com/docs/en/settings-reference#extraknownmarketplaces) entry.
And it lands quietly: Claude Code checks after a session starts, with a delay of up to ten minutes,
and the running session keeps the version it launched with until `/reload-plugins` or the next
launch. If a version bump does not appear to take, run the three commands above — there are open
reports of the flag refreshing the catalog without re-installing the plugin.

**Cursor, Codex, and anything else pointing at a clone.** `git pull` on its own is not enough, and
the way it fails is quiet. [`plugin/launch.mjs`](./plugin/launch.mjs) installs and builds only when
`dist/stdio.js` is *missing*, so a working copy that has been built once keeps serving the old
build no matter what you pull. Rebuild explicitly:

```bash
git pull
npm ci && npm run build
```

Then restart the server in the client: in Cursor, toggle it off and on under **Settings → Tools &
MCP**; in Codex, start a new session. A client pointed straight at `dist/stdio.js` needs the same
two commands.

### Testing

```bash
npm test        # 96 tests, mock mode, no token, no network
npm run typecheck
npm run build
```

The tests run the real MCP protocol end to end — a real client, the real request handler, mock
fixtures underneath — plus unit coverage of the error envelopes, the ledger, pricing, filter
validation, the rate limiter, and the plugin manifests, which nothing else would notice drifting
apart.

---

## How it maps to the API

Modash publishes 44 Discovery operations and 33 RAW ones. This server exposes 12 tools, plus 6
optional RAW tools.

That is deliberate. A tool list is not documentation — it is re-serialised into the model's context
on every turn, and selection accuracy degrades well before forty options. So the mapping is by job
rather than by route:

- The **seventeen dictionary endpoints** (`/{platform}/interests`, `/locations`, `/languages`,
  `/topics`, `/hashtags`, `/brands`) collapse into `modash_lookup_dictionary` with a `kind`
  parameter.
- The **deprecated AI Search aliases** (`/ai/text-search`, `/ai/image-search`) are not exposed at
  all; the per-platform routes replace them.
- **Twenty-eight of the 33 RAW endpoints** become 6 tools taking a `platform` and, where the
  platforms diverge, a `kind`. Instagram has tagged feeds, YouTube has streams, only Instagram
  searches hashtags — the combinations that do not exist are refused locally, which on RAW is the
  difference between an error and a bill.
- **`modash_get_creator_report` returns a summary, not the report.** A full report runs to tens of
  thousands of tokens — hundreds of posts, month-by-month history, dozens of lookalikes. The tool
  returns engagement averages, audience geography, age, gender, language, credibility and sponsored
  performance, and fetches the rest only when `include` asks for it.

Where the code lives:

```
src/
  config.ts                   Environment, validated once at startup
  stdio.ts                    Entry point for desktop clients
  http.ts                     Entry point for Streamable HTTP
  mcp/
    server.ts                 Tool, resource and prompt registration
    handler.ts                The request handler, shared by http.ts and the tests
    context.ts                Wires the client and the ledger together
    result.ts                 Cost envelope, error results
    tools/                    One file per group of tools
  server/modash/              Everything that knows about Modash
    endpoints.ts              One function per Discovery endpoint: path, cost, schema
    raw.ts                    The RAW API: endpoints, cursor normalising, list capping
    client.ts                 Budget check, rate limit, retry, error check, parse, record
    filters.ts                Request schemas (strict)
    responses.ts              Response schemas (permissive)
    errors.ts                 The three error envelope shapes
    budget.ts                 The credit ledger
    pricing.ts                What everything costs
    rate-limit.ts             Serial queues and backoff
    transport.ts              HTTP, and the seam mock mode plugs into
    mock.ts                   Synthetic fixtures

.claude-plugin/plugin.json    Claude Code plugin manifest
.mcp.json                     How Claude Code starts the server
.cursor/mcp.json              How Cursor starts the server
plugin/
  launch.mjs                  Installs and builds on first launch, then hands over
  mcpb/manifest.json          What Claude Desktop reads on install
  build-mcpb.mjs              Bundles the server and packs the .mcpb
  verify-mcpb.mjs             Installs the packed .mcpb the way a client does, and calls it
```

The repository root also carries `.claude-plugin/marketplace.json`, which is what makes
`/plugin marketplace add modashio/modash-api-cookbook` work.

`src/server/modash/endpoints.ts` is the file to read if you want to know exactly which endpoints
this can reach and what each one spends.

### Resources and prompts

- `modash://pricing` — what every tool costs, for a model that wants to plan before spending.
- `modash://budget` — the live session ledger, call by call.
- `shortlist-creators` — a prompt that walks a model from a campaign brief to a vetted shortlist in
  the cheap-to-expensive order.

---

## Things the API does that a wrapper has to handle

These are the details that cost time when you integrate, all verifiable against the
[public reference](https://docs.modash.io) or visible in the fixtures.

**Documented `required` does not mean present.** Real reports omit fields the spec marks required —
`city`, `state`, `gender`, `ageGroup` — for creators Modash has not resolved them for. Real
responses also carry fields the spec does not mention: `isVerified` and `isPrivate` on search
profiles, `count` on brand dictionary entries. So every response schema here has every field
optional and every object loose (`z.looseObject`, Zod 4's `.passthrough()`). Strict response parsing
throws on ordinary data; strict *request* parsing is the thing you want.

**The error envelope has three shapes.** The documented one is
`{ error: true, code, message }`. But `message` is often an array of validation strings rather than
one string, and framework-level errors carry no `code` at all, just a `statusCode`. `errors.ts`
tolerates all three. Branch on `code`, never on `message` — the docs are explicit that messages
change without notice, and they do: the documented text for `account_not_found` differs from the
live one by a full stop.

**A 200 does not prove success.** Nearly every 200 response schema in the spec declares an
`error: boolean` field. This server treats `error === true` as a failure regardless of HTTP status.
One branch, and the gap is closed.

**Nested filters are not validated.** Covered above; it is the reason `filters.ts` uses
`z.strictObject` and rejects unknown keys locally.

**The same concept has three vocabularies.** Account type is `1 | 2 | 3` in a search filter,
`"Regular" | "Business" | "Creator"` in a report, and `"individual_creator" | "brand" | …` in an AI
Search filter. AI Search results use `followersCount`, `profilePicture` and `fullName` where regular
search uses `followers`, `picture` and `fullname`. Do not share types between the two families.

**Filter shapes are asymmetric.** In `filter.audience`, `location`, `age` and `interests` are arrays
that combine with OR; `language` and `gender` are single objects. Because nested filters are not
validated, getting this backwards fails silently.

**AI Search is one request per second** by default. The server runs those calls through their own
serial queue so concurrency cannot produce a burst; the rest of Discovery gets a separate, looser
queue. `429` and `5xx` are retried with jittered backoff, which is free because failures are not
billed.

**Send the request the documentation shows you, and nothing more.** Both search and report take an
optional `calculationMethod` that already defaults to `median`. Spelling that default out changes
nothing about the response, and a request carrying extra parameters is not guaranteed to be priced
like the bare one in the docs — so this server leaves optional parameters unset unless the caller
actually asked for a non-default value. `transport.ts` drops `undefined` values rather than
serialising them.

**The topics and hashtags dictionaries have no browsable list.** They only answer a query, and
asking without one is a 400. The other four dictionaries will happily return everything.

**Pagination works three different ways.** Regular search takes `page` only, capped at 665, with a
fixed page size of 15. AI Search takes `page` and `pageSize`, with `(page + 1) × pageSize ≤ 1500`
and a warning not to change `pageSize` mid-run. Collaborations use an opaque `cursor` valid for two
days.

**Some things are Instagram-only.** The interests and brands dictionaries, `filter.audience.interests`
and `credibility`, `hasSponsoredPosts`, `reelsPlays`. Audience overlap is Instagram and YouTube only.
The API ignores a filter that does not apply to the platform rather than rejecting it — and bills
you for the search — so `filters.ts` checks locally and tells the model which field was wrong.

---

## What is not here

- Five RAW endpoints: TikTok's two media-download routes, which return media files rather than
  data, its challenge and music metadata routes, whose feeds are reachable through
  `modash_raw_browse`, and YouTube's video subtitles.
- Image search (`/ai/{platform}/image-search`). It works exactly like text search with a base64
  image in place of the query.
- Caching. Reports are stable enough to cache for weeks and doing so is the single biggest saving
  available, but a cache in a project obscures which call went to the API.
- Auth on the HTTP transport. It binds to loopback and checks the `Host` header, which is right
  for a local client and not enough for anything else.

## Learn more

- [Modash API reference](https://docs.modash.io)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Request access to the Modash API](https://form.jotform.com/modash/intro-modash-api?utm_source=github&utm_campaign=api_cookbook)
