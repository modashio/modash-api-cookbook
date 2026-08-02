# AGENTS.md — agentic influencer search

Project-specific notes. The repo-wide rules in [`../../AGENTS.md`](../../AGENTS.md) apply
first — especially the ones about secrets, real creator data, and never making paid API calls
in automated checks.

## Commands

```bash
npm install
npm run dev         # Express API on :3000 + Vite UI on :5173
npm test            # agent loop, HTTP stream, UI render — no token, no credits
npm run typecheck
npm run build
npm run search -- "<brief>"   # same agent, CLI
npm run check-token           # verify a Modash token using only free endpoints
```

`npm test`, `npm run typecheck` and `npm run build` must all pass with **no environment
variables set at all**. If a change breaks that, the change is wrong.

## Where things live

```
src/shared/     Types crossing the server/browser boundary. No server-only imports here —
                it is bundled into the browser.
src/server/
  env.ts        Config. Mock mode defaults on when there is no token.
  app.ts        Express app factory. Takes an optional model override so tests can
                drive the real HTTP route with a scripted model.
  routes/       HTTP layer only.
  agent/        prompt.ts (instructions), tools.ts (tool defs), agent.ts (streamText loop),
                model.ts (provider selection).
  modash/       Everything that talks to api.modash.io. client.ts is transport only;
                api.ts is the endpoint surface with live + mock implementations.
  testing/      Test-only helpers (scripted model).
src/web/        React app. Talks only to /api/*.
  queries/      TanStack Query hooks for request/response fetches (e.g. /api/config).
                Not named `api/`: Vite serves modules from the dev-server root, so
                that path collides with the /api proxy rule and 404s.
  storage/      Saved conversations in localStorage. chat-store.ts is the pure
                read/write layer; use-saved-chats.ts is the React state around it.
  components/   Presentational UI. Styling is Tailwind utility classes.
  styles.css    Tailwind entry: `@import "tailwindcss"`, `@theme` design tokens, keyframes,
                and a small `@layer base` block for html/body/#root and link defaults.
src/cli/        tsx entrypoints.
```

### Frontend conventions

- **Styling is Tailwind utilities.** Design tokens (colours, radii, fonts, animations) live in
  the `@theme` block in `styles.css`. Prefer utilities on elements over bespoke CSS; keep
  keyframes and genuine base resets in `styles.css` only when they cannot be expressed as
  utilities.
- **Never hide a panel without giving it a way back.** Both sidebars were once plain
  `max-[1080px]:hidden`, so in a narrow window — an IDE's side browser — the shortlist simply
  vanished and creators appeared to go nowhere. Each is now a docked column when there's room
  and a drawer when there isn't, with a header control that stays visible either way. If you
  add a third panel, follow the same shape.
- **Some next steps belong to the UI, not the agent.** The agent proposes follow-ups based on
  what just happened, so anything that stays relevant after the conversation moves on — reviewing
  the shortlist, for instance — is appended by the client instead. See `review-step.ts`. Price
  standing actions from state the client can see, and don't charge for work already done.
- **Verdicts are the exception to the data-part rule.** Likes and dislikes are current state
  rather than a record of events, so they are sent in the request body and injected into the
  instructions instead of being appended to the transcript. Enforce them in the tools as well as
  the prompt — `shortlistCreators` refuses a disliked creator outright, because a prompt is a
  request and this is a rule.
- **Shortlists are never stored separately.** They live in the message history as
  `data-shortlist` parts, so persisting messages persists the shortlist and there is only one
  thing that can go stale. Same for reports and searches. If you add state that has to survive
  a reload, put it in a data part before you reach for another store.
- **`saveChats` can write less than you give it.** Transcripts carry avatars and thumbnails
  and will hit the 5MB localStorage quota; the writer evicts oldest-first and returns what it
  managed to save. Always adopt the return value as state, or the sidebar will list a
  conversation that isn't on disk. Bump `STORAGE_VERSION` whenever `ChatMessage` changes shape.
- **Never do work inside a `setState` updater.** React re-runs them. An earlier version called
  `crypto.randomUUID()` and wrote to localStorage inside one, and under StrictMode the new
  chat's id and the stored chat's id diverged. Compute the next value first, then set it.
- **TanStack Query for request/response fetching, `useChat` for the stream — don't mix them.**
  `/api/config` (and any future ordinary GET/POST) goes through a typed query in
  `src/web/queries/`.
  The chat token stream stays on the Vercel AI SDK's `useChat` hook; routing SSE through
  TanStack Query would break streaming.

## Rules specific to this project

### Mock mode is not optional

`createMockApi()` must implement the full `ModashApi` interface. If you add a tool that hits a
new endpoint, add a mock for it in the same change, or `npm run dev` stops working for anyone
without a token — which is most people reading this repo.

Mock data must stay obviously synthetic: `demo.*` handles, `(demo)` names, locally generated
SVG placeholder images, `(mock)` suffixes on dictionary results. Never paste a real API
response into `mock.ts`.

### Every paid call goes through the ledger

Any new call to a credit-consuming endpoint must:

1. Call `ledger.assertCanSpend(worstCaseCost)` **before** the request.
2. Call `ledger.record(label, actualCost)` **after** it, based on results actually returned.
3. Publish a `data-usage` part so the meter updates.
4. Return budget errors as tool *output*, not thrown exceptions — the agent should read them
   and adapt.

Free endpoints (dictionaries, `/user/info`) must not be metered; pretending they cost
something misleads the reader about the pricing model.

### Keep tool results small, stream rich data separately

Tool return values go into the model's context on every subsequent turn. Return compact
summaries; send anything the model can't use (image URLs, per-post stats, profile pictures) to
the UI as a `data-*` part instead. See `summariseCreator` in `agent/tools.ts`.

### Don't let the agent claim things the API didn't return

AI Search responses contain no bios and no captions. If you add a field to
`summariseCreator`, it must come from an actual API response. If you *remove* the prompt rule
about not inventing qualitative claims, expect fabricated audience descriptions.

### Respect the 1 RPS AI Search limit

All requests are serialised in `ModashClient`. Don't add `Promise.all` over paid endpoints, and
don't lower `minRequestIntervalMs` below ~1100ms without a documented reason.

### Prompt changes

`agent/prompt.ts` encodes documented API behaviour (semantic query vs filters, no negation,
dictionary IDs, English matching best, 10k follower floor). Those rules are load-bearing, not
stylistic — check them against
[the AI Search docs](https://docs.modash.io/products/discovery_api/openapi_doc/discovery/ai-search)
before editing, and keep the reasoning in the comments so the next reader knows why they exist.

## AI SDK version notes

This project targets **AI SDK 7** (`ai@^7`), which changed several names you may remember from
older tutorials:

- `system` → `instructions`
- `stepCountIs` → `isStepCount`
- `onFinish` → `onEnd`, `onStepFinish` → `onStepEnd`
- `result.toUIMessageStream(...)` → the stateless `toUIMessageStream({ stream: result.stream })`
- `convertToModelMessages` is async

AI SDK 7 is ESM-only and requires Node.js 22+.
