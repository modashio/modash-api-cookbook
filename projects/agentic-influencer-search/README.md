# Agentic influencer search

An agent that turns a campaign brief into creator discovery.

You type something a marketer would actually say — *"we're launching a magnesium sleep
supplement in the US, find creators who talk about evening routines, 20k–200k followers, must
have a contact email"* — and the agent decides which
[Modash AI Search](https://docs.modash.io/products/discovery_api/openapi_doc/discovery/ai-search)
queries to run, resolves location and language names to dictionary IDs, reads the results,
refines what didn't work, and hands back a shortlist with a reason per creator.

Every step is streamed to the UI: the query it wrote, the filters it chose, why it chose them,
the creators that came back, and the credits it just spent.

Once a shortlist exists there is always an **Auto-review & filter shortlist** button, priced by
how many creators still need a report. It pulls the missing audience reports, judges each
creator against the brief, and actually cuts the ones that fail. In a live run against a US
brief it removed all four shortlisted creators — the content matched, but their audiences were
in the UK, Italy and Brazil — and then proposed adding a US location filter.

It finishes each turn by proposing follow-ups as **one-click buttons** — pull audience reports
for the shortlist, run the same brief on TikTok, widen a filter — each labelled with what it
will cost. Clicking one sends the agent its own instruction back, so the conversation continues
without anyone working out what to type.

Every creator card has **like and dislike** buttons. Verdicts steer the next turn: the agent
works out what the liked creators have in common, moves its filters toward it, and will not put
a rejected creator back on the shortlist.

Searches are **saved in the browser**, one per campaign, so a shortlist you paid credits for is
still there tomorrow.

**Stack:** Node.js + [tsx](https://tsx.is), TypeScript, [Express](https://expressjs.com),
[Vercel AI SDK](https://ai-sdk.dev), React + Vite, [Tailwind CSS](https://tailwindcss.com),
[TanStack Query](https://tanstack.com/query).

---

## Run it in 60 seconds (no API token needed)

```bash
cd projects/agentic-influencer-search
npm install
cp .env.example .env
# add OPENAI_API_KEY or ANTHROPIC_API_KEY to .env
npm run dev
```

Open <http://localhost:5173>.

With no `MODASH_API_TOKEN` set, the app runs in **mock mode** against a small synthetic
dataset. Nothing hits the Modash API, no credits are spent, and the UI shows a `mock data`
badge so you can't confuse it with the real thing. The mock handles are invented — this is a
public repo and no real creator data is committed to it.

Mock mode exists so you can read the code, see the agent loop work, and judge whether this
shape of integration fits your product *before* you have API access. When you want real data,
[request an intro to the API](https://www.modash.io/influencer-marketing-api?utm_source=github&utm_campaign=api_cookbook).

## Run it against real Modash data

1. Get a token from [marketer.modash.io/developer](https://marketer.modash.io/developer). This
   needs [Discovery API](https://www.modash.io/influencer-marketing-api/discovery) access — see
   the [root README](../../README.md#getting-set-up) if you don't have it yet.
2. Put it in `.env`:

   ```bash
   MODASH_API_TOKEN=your-token
   MODASH_CREDIT_BUDGET=5     # hard cap per chat session
   ```

3. Confirm the token works, using only free endpoints:

   ```bash
   npm run check-token
   ```

   ```
   Token accepted.
     credits remaining:  3000
     discovery rate limit: 500 req/min
     dictionary lookup:  4 location(s) for "berlin" (free)
   ```

4. `npm run dev` again. The badge disappears and results are real creators.

## What it costs

AI Search bills **0.025 credits per returned profile**. A search returning 10 profiles costs
0.25 credits; a conversation where the agent runs three searches of 10 costs about 0.75.

Two guardrails are built in, and both are worth copying into your own integration:

- **`MODASH_CREDIT_BUDGET`** — a hard per-session cap, checked *before* each paid request with
  the worst-case cost. When it's hit, the tool returns an error the agent can read and react
  to ("ask the user before spending more") instead of throwing.
- **`MODASH_MAX_PAGE_SIZE`** — an upper bound on `pageSize`, so a confused model can't ask for
  50 profiles per search.

The credit meter in the header shows session spend against the budget, streamed from the
server as it happens. Dictionary lookups and `/user/info` are free and are not metered.

## Other ways to run it

```bash
npm run search -- "German-speaking gut health creators, mid-tier, posting weekly"
```

The same agent in the terminal. Handy for tuning the prompt and for finding out what a brief
costs before wiring it into a product.

```bash
npm test          # agent loop, HTTP stream, and UI rendering — no token, no credits
npm run typecheck
npm run build     # production bundle; `npm start` then serves API + UI on one port
```

---

## How it works

```
browser (React + useChat + TanStack Query)
   │  GET  /api/config ← session budget / mock badge (TanStack Query)
   │  POST /api/chat   ← UI message stream (SSE via useChat)
   ▼
Express  src/server/routes/chat.ts
   │
   ▼
Agent    src/server/agent/         streamText + tools + stopWhen
   │                               ├─ instructions:  how AI Search actually behaves
   │                               └─ tools:         search, lookalikes, dictionaries, shortlist
   ▼
Modash   src/server/modash/        rate limiting · retries · credit ledger · Zod validation
   │
   ▼
api.modash.io/v1
```

The Modash token never leaves the server. The browser only talks to `/api/*`. Chat
streaming stays on `useChat`; TanStack Query is used for ordinary request/response
fetches such as `/api/config`.

### The agent's tools

| Tool | Endpoint | Cost |
| --- | --- | --- |
| `searchCreators` | `POST /ai/{platform}/text-search` | 0.025 / profile |
| `findLookalikes` | `POST /ai/{platform}/lookalikes` | 0.025 / profile |
| `resolveLocations` | `GET /{platform}/locations` | free |
| `resolveLanguage` | `GET /{platform}/languages` | free |
| `resolveBrands` | `GET /ai/brands` | free |
| `resolveTextTags` | `GET /ai/hashtags`, `GET /ai/mentions` | free |
| `getAudienceReports` | `GET /{platform}/profile/{userId}/report` | **1 credit each** |
| `checkCredits` | `GET /user/info` | free |
| `shortlistCreators` | — (local state) | free |
| `removeFromShortlist` | — (local state) | free |
| `proposeNextSteps` | — (renders the follow-up buttons) | free |

### The part that actually matters

The interesting engineering here isn't the model, it's teaching the model how the endpoint
behaves. Four rules from the
[AI Search reference](https://docs.modash.io/products/discovery_api/openapi_doc/discovery/ai-search)
are the difference between a demo and something usable, and they're all encoded in
[`src/server/agent/prompt.ts`](./src/server/agent/prompt.ts):

1. **`query` is semantic, `filters` are not.** `query` is matched against what appears in
   creators' photos and videos. Putting *"German, based in Berlin, over 50k followers"* in the
   query wastes the vector search on things that have exact filters. The prompt forbids it and
   the tool schema documents each filter inline so the model picks the right one.
2. **Negation doesn't work.** "no politics" makes politics *more* likely, because the
   embedding has no concept of "not". The prompt says describe only what you want; to exclude,
   use a filter or `textTags` with `mode: "exclude"`.
3. **Dictionary IDs must be looked up.** A model asked for a Berlin location ID will
   confidently invent one, and the API will silently return the wrong city's creators. The
   free `resolveLocations` / `resolveLanguage` / `resolveBrands` tools exist so it can't.
4. **English queries usually match best**, even for non-English markets — set the market with
   `language` and `locations` instead.

### Why search and reports are two separate steps

AI Search matches on *content* — what appears in a creator's photos and videos. It tells you
nothing about who is watching. A full profile report does, and it costs 1 credit against
0.025 for a search result, which is the entire reason the workflow is search broadly, then
report only the finalists.

The gap is not theoretical. A live run against three creators the search ranked as strong
matches for a US sleep-supplement brief:

| Creator | Audience credibility | Top audience country |
| --- | --- | --- |
| first | 75% | United States, 75% |
| second | 18% | India, 32% |
| third | 15% | Brazil, 22% |

All three post the right content. Two have audiences that are mostly inauthentic and in the
wrong market, and no amount of search filtering would have revealed that — the follower counts
and engagement rates looked fine. That's what the credit buys.

Three more choices worth stealing:

- **The agent proposes its own follow-ups.** `proposeNextSteps` is a free tool the agent calls
  last, and each step becomes a button whose `instruction` is sent back verbatim on click. The
  prompt constrains it to actions the agent can actually perform, so a button never promises
  something it can't do.
- **User feedback is a live set, not a transcript entry.** Likes and dislikes are the one thing
  that does *not* live in the message history: they are the user's current opinion, and clicking
  the same button four times shouldn't leave four contradictory records for the model to
  reconcile. They ride along with each request and land in the instructions, so the agent always
  sees the current set. In a live run, disliking one brand account was enough for the agent to
  add an `accountType: individual_creator` filter and narrow the follower range toward the liked
  creator, unprompted.
- **Everything worth keeping is a data part, so persistence is nearly free.** Shortlists,
  searches and reports all live in the message history rather than in separate state, which
  means saving conversations to `localStorage` saves all of them, and restoring one rebuilds
  the whole UI with no server involvement. `src/web/storage/` is about a hundred lines, most of
  it handling the 5MB quota — transcripts carry avatars and thumbnails, so the writer evicts
  oldest-first rather than throwing.
- **Tool results are kept small.** The model gets a compact per-creator summary (handle,
  followers, engagement, category, matched-post count). The rich payload the UI renders —
  avatars, post thumbnails, per-post stats — is streamed separately as a typed
  [data part](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data). Thumbnail URLs are long and
  useless to a language model; sending them through the conversation would burn tokens on
  every subsequent turn.
- **The agent can only claim what it can see.** AI Search returns no bios and no captions, so
  the prompt says so explicitly. Without that, models happily invent "her audience is mostly
  young mothers in Germany" from a follower count.

### Rate limiting and retries

AI Search is limited to **1 request per second** by default (higher on request). Rather than
hope, [`src/server/modash/client.ts`](./src/server/modash/client.ts) serialises every request
through a queue with a minimum interval, and retries `429`/`5xx` with exponential backoff.
Failed requests aren't billed, so retrying them is free.

## Where to take it next

The obvious extensions, in rough order of value:

- **Image search** (`POST /ai/{platform}/image-search`) — let the user drop a mood board and
  find creators whose content matches the aesthetic. Same filter object, `base64Image` instead
  of `query`.
- **[Collaborations](https://www.modash.io/influencer-marketing-api/collaborations-api)**
  (`POST /collaborations/posts`, 0.2 credits) — check whether a shortlisted creator has already
  worked with a competitor.
- **Approvals** — the AI SDK supports
  [tool approval](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage#tool-execution-approval),
  so a paid search can require an explicit click before it spends credits.
- **Persistence** — the shortlist currently lives in the message history. Storing it means
  users can come back to it, and you avoid re-searching.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `No model provider key found` | Add `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` to `.env`. |
| `mock data` badge won't go away | `MODASH_API_TOKEN` is empty, or `MODASH_MOCK=true` is set explicitly. |
| `Modash API error (api_token_invalid)` | Token is wrong or revoked. Re-copy it from [marketer.modash.io/developer](https://marketer.modash.io/developer). |
| `Modash API error (feature_not_available)` | The account doesn't have AI Search. It's part of the [Discovery API](https://www.modash.io/influencer-marketing-api/discovery) — talk to your Modash contact, or [request access](https://www.modash.io/influencer-marketing-api?utm_source=github&utm_campaign=api_cookbook). |
| `Modash API error (not_enough_credits)` | Account is out of credits for the month. |
| Agent stops mid-search saying it's out of budget | Working as intended. Raise `MODASH_CREDIT_BUDGET`. |
| Searches feel slow | Deliberate: requests are serialised to respect the 1 RPS AI Search limit. |

## Files worth reading first

| File | Why |
| --- | --- |
| [`src/server/agent/prompt.ts`](./src/server/agent/prompt.ts) | How the agent is taught to use AI Search |
| [`src/server/agent/tools.ts`](./src/server/agent/tools.ts) | Tool definitions, credit metering, UI streaming |
| [`src/server/modash/client.ts`](./src/server/modash/client.ts) | Auth, rate limiting, retries, error mapping |
| [`src/server/modash/schemas.ts`](./src/server/modash/schemas.ts) | The full AI Search filter set, documented inline |
| [`src/server/modash/credits.ts`](./src/server/modash/credits.ts) | The credit ledger and budget cap |
