# Cross-platform influencer search via API

Start with a creator's handle on one platform. Get the same person's accounts on the other two, with
the evidence for each link, using the [Modash Discovery API](https://docs.modash.io).

A small command-line tool. It runs on one creator or on a CSV of thousands, and typically costs 1 to 3
credits per creator.

## Try it with no token

```bash
npm install
npm run dev
```

Mock mode needs no token and spends nothing. It answers from two invented creators written in the
shape the API returns (`fixtures/demo-responses.json`), and prints:

```
instagram @example_baker  (3 credits on a live run)
  instagram  @example_baker                    100000  input
  tiktok     @example_baker                    200000  confirmed both ways
  youtube    @ExampleBakerKitchen               50000  confirmed both ways

instagram @example_techreviews  (2.02 credits on a live run)
  instagram  @example_techreviews             5000000  input  + email agrees
  tiktok     not found
  youtube    @exampletechreviewsold          20000000  email (hello@example.com)
  candidate  tiktok @example_techreviews 2000000  same handle, unconfirmed

Results in output/mock-results.jsonl. This was mock mode, so nothing was spent; a live run of the same creators costs 5.02 credits.
```

No API access yet? [Request an intro to the Modash API](https://www.modash.io/influencer-marketing-api?utm_source=github&utm_campaign=api_cookbook).

## Run it live

Node.js 22 or later.

```bash
cp .env.example .env        # then uncomment MODASH_API_TOKEN in .env and set it
npm run match -- instagram example_baker
```

The handle can also be a profile URL, such as `https://www.instagram.com/example_baker/`.

For a list, make a CSV with the columns `platform` and `handle` (see `handles.example.csv`):

```bash
npm run match -- --csv handles.csv --max-credits 500
```

| Variable | What it does |
| --- | --- |
| `MODASH_API_TOKEN` | Your token. Without it the tool runs in mock mode and will not take your own creators. |
| `MODASH_MOCK` | `true` answers from the fixtures even with a token set. |
| `MODASH_CREDIT_BUDGET` | Most credits one run may spend, 50 by default. `--max-credits` overrides it for one run. |

- **Budget.** A run stops before any call that could take it over the budget. A 100-creator CSV needs up to about 300.
- **Results** go to `output/results.jsonl`, one line per creator.
- **Resume.** If a CSV run stops, run the same command again. Creators already finished, including ones not found on their starting platform, are skipped; creators that hit an error are tried again. A single-creator run replaces that creator's line and leaves the rest alone.
- **Saved reports.** Every report is saved in `output/reports/`, so a rerun never pays for the same report twice. They do not expire: delete the folder to pull fresh data.
- **Errors.** An invalid token (`api_token_invalid`) or an empty balance (`not_enough_credits`) stops the run with the API's message. Any other failed call, such as a deleted account, is written to that creator's `errors` and the run goes on.

`npm test` runs the tests offline, with no token and no network.

## What you get

One record per creator. Each account carries `how` it was found, so your product can set a rule for
which matches to accept.

```json
{
  "input": { "platform": "instagram", "handle": "example_baker" },
  "accounts": {
    "instagram": { "userId": "1000000001", "username": "example_baker", "followers": 100000, "how": "input" },
    "tiktok": { "userId": "7000000000000000001", "username": "example_baker", "followers": 200000, "how": "confirmed both ways" },
    "youtube": { "userId": "UCexampleBaker000000001", "username": "ExampleBakerKitchen", "followers": 50000, "how": "confirmed both ways" }
  },
  "candidates": [],
  "missing": [],
  "credits": 3,
  "errors": []
}
```

The kinds of evidence, strongest first:

| `how` | What it means | Suggested rule |
| --- | --- | --- |
| `confirmed both ways` | The starting profile links this account, and this account's own profile links back | Accept |
| `same handle, confirmed by its profile link back` | Same handle, and its profile links to the starting account | Accept |
| `email (...)` or `same handle, confirmed by shared email (...)` | Both accounts list the same public email | Accept when the address is the creator's own |
| `profile link, one way` | The starting profile links this account, and nothing points back | Show it with its evidence, let a person decide |
| `same handle, unconfirmed` (in `candidates`) | An account with the same handle exists and nothing links the two | Never merge on this alone |

`candidates` also holds the accounts the tool would not accept on its own. Their `how` ends in
`, second link` (a second account the profile links on the same platform), `, shared by several accounts`
(an email listed by more than one account on a platform), or reads `same handle, report failed`.
`email_agrees: true` on an account means email search found it too, a second piece of evidence.

## The endpoints

| Call | What it returns | Cost |
| --- | --- | --- |
| `GET /v1/{platform}/users?query=<handle>&limit=10` | Up to 10 accounts whose handle starts with the query, with Modash's id for each | Free |
| `POST /v1/{platform}/search` with `relevance: ["@handle"]` | Only when the lookup finds nothing: accounts matching the handle | 0.01 credits per row returned, up to 0.15 |
| `GET /v1/{platform}/profile/{userId}/report` | The creator's full profile. This tool reads `profile.contacts` | 1 credit |
| `POST /v1/email-search` with `{"emails": [...]}` | Every Instagram, TikTok and YouTube account that lists one of those emails | 0.02 credits per email that matches |

`{platform}` is `instagram`, `tiktok` or `youtube`. Every call takes the header
`Authorization: Bearer <your token>`. All of them live in [`src/match.ts`](./src/match.ts), and every
request goes through [`src/modash/client.ts`](./src/modash/client.ts), which holds the budget, retries
and error handling.

The responses below show the API's real shape, trimmed to the fields this tool reads, for the two
invented creators in the fixtures.

## Step 1: turn the handle into an id

The report endpoint accepts a handle or a user id. This tool works in ids, because the links on a
profile usually carry ids, and the free lookup confirms the account exists before a credit is spent.
The lookup can return several close matches, so keep the row whose handle matches exactly.

```bash
curl "https://api.modash.io/v1/instagram/users?query=example_baker&limit=10" \
  -H "Authorization: Bearer $MODASH_API_TOKEN"
```

```json
{
  "error": false,
  "users": [
    { "userId": "1000000001", "username": "example_baker", "fullname": "Example Baker", "followers": 100000, "isVerified": false }
  ]
}
```

On YouTube the rows carry the current handle in `handle` (with a leading `@`) and an older name, or
nothing, in `username`. Compare both, or a YouTube start misses. In the code that is `namesOf()`.

If the lookup returns nothing, the tool falls back to a search with `relevance: ["@handle"]` and
`hasAudienceData: false`, so creators without audience data are not left out.

## Step 2: read the other accounts off the report

Pull the report for that id. One field, `profile.contacts`, lists the links the creator put on their
own profile, each as a `type` and a `value`.

```bash
curl "https://api.modash.io/v1/instagram/profile/1000000001/report" \
  -H "Authorization: Bearer $MODASH_API_TOKEN"
```

```json
{
  "error": false,
  "profile": {
    "userId": "1000000001",
    "contacts": [
      { "type": "youtube", "value": "https://www.youtube.com/channel/UCexampleBaker000000001" },
      { "type": "tiktok", "value": "https://www.tiktok.com/share/user/7000000000000000001" }
    ]
  }
}
```

When a contact's URL carries the other platform's account id, as both do here, that id goes straight
to the other platform's report endpoint, with no second lookup. `idFrom()` in
[`src/contacts.ts`](./src/contacts.ts) reads the two forms shown above:

```ts
platform === 'youtube'
  ? /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{20,})/i.exec(value)
  : /tiktok\.com\/share\/user\/(\d+)/i.exec(value)
```

A contact can also be a plain handle or a profile URL without an id, such as
`youtube.com/c/ExampleBakerKitchen` or `youtube.com/@ExampleBakerKitchen/videos`. `handleFrom()` reads
the handle from the first part of the path, ignores links to posts and videos, and the tool runs the
free lookup on it.

Contacts that are not another platform (`email`, `twitter`, `linktree`, `twitchtv`) are left alone,
except that emails are kept for step 4.

## Step 3: check each account links back

A link on one profile is the creator's claim. Pull the linked account's report (1 credit) and check
whether its own `contacts` name the account you started from. Yes means `confirmed both ways`; no means
`profile link, one way`.

```bash
curl "https://api.modash.io/v1/youtube/profile/UCexampleBaker000000001/report" \
  -H "Authorization: Bearer $MODASH_API_TOKEN"
```

```json
{
  "error": false,
  "profile": {
    "userId": "UCexampleBaker000000001",
    "profile": { "handle": "@ExampleBakerKitchen", "fullname": "Example Baker", "followers": 50000 },
    "contacts": [{ "type": "instagram", "value": "https://www.instagram.com/example_baker/" }]
  }
}
```

The TikTok report comes back the same shape, with `"username": "example_baker"` under `profile.profile`
and an `instagram` contact of `https://www.instagram.com/example_baker/`. Both name the Instagram we
started from, so both are confirmed both ways.

Read the account id from `profile.userId`, and on YouTube the name from `profile.profile.handle`, which
carries a leading `@`.

A link back can carry a handle or an id. `pointsBack()` compares both, against every name the starting
account answers to, so it works whichever platform you start from, including a renamed YouTube channel.

When a profile links two accounts on one platform, the tool checks both and keeps the one that links
back. The other goes to `candidates`. Each extra link costs one more report, so a creator can cost more
than 3 credits.

## Step 4: search by email when the profile links nothing

If a platform is still missing and any report you pulled held an `email` contact, send the address to
email search. It returns every account on the three platforms that lists it. The account needs at least
0.02 credits per email sent, or the call returns `not_enough_credits`.

`example_techreviews` lists no other account on Instagram, only an email:

```bash
curl -X POST "https://api.modash.io/v1/email-search" \
  -H "Authorization: Bearer $MODASH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"emails": ["hello@example.com"]}'
```

```json
{
  "matchedEmails": [
    {
      "email": "hello@example.com",
      "users": [
        { "platform": "instagram", "userId": "1000000002", "username": "example_techreviews", "followers": 5000000 },
        { "platform": "youtube", "userId": "UCexampleTech0000000003", "username": "exampletechreviewsold", "followers": 20000000 }
      ]
    }
  ],
  "totalMatches": 1,
  "error": false
}
```

The username email search returns can differ from the account's current handle, so the tool compares
ids, not names. When the search also returns the account you started from, the tool marks it
`email_agrees: true`. When several accounts on one platform share the address, none is accepted and
all go to `candidates`.

## Step 5: treat the same handle as a guess

Looking up the same handle on the missing platform is free. Checking what it finds costs 1 credit for
its report. What it finds becomes a match only when its own report links back or shares an email with
the start. Never match on a display name.

`example_techreviews` has a TikTok with the same handle. Its profile links to nothing and lists no
email, so it stays a candidate:

```json
{
  "candidates": [
    { "platform": "tiktok", "userId": "7000000000000000002", "username": "example_techreviews", "followers": 2000000, "how": "same handle, unconfirmed" }
  ],
  "missing": ["tiktok"]
}
```

## What it costs

| Creator | Calls | Credits |
| --- | --- | --- |
| Profile names both other accounts (`example_baker`) | 1 lookup, 3 reports | 3 |
| Profile names nothing, email finds one, same-handle account checked (`example_techreviews`) | 2 lookups, 2 reports, 1 email search | 2.02 |
| Profile names nothing and no same-handle account exists | 3 lookups, 1 report | 1 |

Add up to 0.15 when the first lookup misses and the search fallback runs, and 1 for each extra account
a profile links on the same platform. For 10,000 creators that is roughly 10,000 to 30,000 credits.
A saved report is free to read again.

Calls run one after another, with a short pause to stay under the rate limit, so allow about 3 to 6
seconds per creator: roughly half a day for 10,000.

Follower counts come from the report when the tool has one, because lookup and email search rows can
be a little older.

## What can go wrong

- **The API is busy or rate-limited.** It answers HTTP 429 or a 5xx. The tool waits 3, 6, 9 then 12 seconds and tries again, and does the same after a dropped connection or a timeout. If the call still fails, it goes into that creator's `errors` and a rerun tries again.
- **A deleted or private linked account.** Its report returns an error. The tool records it and the platform stays `missing`.
- **Shared agency emails.** Several creators can list the same management address. The tool only accepts an email match when one account per platform lists it, but an agency address can still join two people. Accept email matches only where the address is the creator's own, or require a second signal.
- **Handles change.** A link to `instagram.com/oldname` points at a renamed account. The lookup then misses, and the platform stays `missing`.

## Files

| Path | What it is |
| --- | --- |
| `src/match.ts` | The method: the five steps above, in `Matcher` |
| `src/contacts.ts` | Reading handles and ids out of profile links |
| `src/modash/` | The HTTP layer: client with budget and retries, response schemas, errors, mock transport |
| `src/run.ts`, `src/cli.ts` | The command line: arguments, CSV, resume, output |
| `fixtures/demo-responses.json` | What mock mode answers from: invented creators, the API's real response shape |
| `sample-output/` | The two records mock mode produces |
| `handles.example.csv` | The CSV format for a batch run |
| `test/` | Offline tests: `npm test` |
