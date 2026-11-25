# Find creator accounts from an email list

Start with a CSV of email addresses, such as a customer file. Get the Instagram, TikTok and YouTube
accounts that list each address, using email search in the [Modash Discovery API](https://docs.modash.io).

A small command-line tool. It prices the file before you send it, checks a sample first, sends the
list in calls of up to 1,000 emails, and marks the matches a person should look at. A match costs
0.02 credits.

## Try it with no token

Node.js 22 or later.

```bash
cd projects/find-creator-accounts-by-email
npm install
npm run lookup-example
```

`lookup-example` needs no token and spends nothing. It checks the invented list in
`emails.example.csv` against invented accounts (`fixtures/demo-accounts.json`), answered in the shape
the API returns, and shows the API call a live run makes and what it costs. It prints:

```
emails.example.csv: 8 rows, 5 emails to check (1 blank, 1 duplicate, 1 not an email address)
  not sent: line 6 "not an email"
call  POST /v1/email-search {"emails":["baker@example.com","dana@example.org","talent@agency.example","sam.lee@example.net","techreviews@example.com"]}  (0.06 credits)
baker@example.com
  instagram  @example_baker                    100000
  tiktok     @example_baker                    200000
talent@agency.example  (check by hand: 2 instagram accounts list this email)
  instagram  @example_runner                   300000
  instagram  @example_chef                      40000
techreviews@example.com
  youtube    @example_techreviews            20000000
Checked 5 emails: 3 matched, 2 with no creator account. 1 match to check by hand.
Results in output/mock-results.jsonl. This was mock mode, so nothing was spent; a live run with these matches costs 0.06 credits.
```

The example list is built to show every case, so most of it matches. Your own list will match at
its own rate: step 3 measures it. The same output is saved in `sample-output/lookup-example.txt`,
with the results file beside it, so you can read it without installing anything.

No API access yet? [Request an intro to the Modash API](https://www.modash.io/influencer-marketing-api?utm_source=github&utm_campaign=api_cookbook).

## Run it on your list

Your file is a comma-separated CSV with a header row and one column of emails. Other columns are ignored.
A token comes from [marketer.modash.io/developer](https://marketer.modash.io/developer).

```bash
npm run estimate -- customers.csv                  # no token: what checking the file can cost
cp .env.example .env                               # then uncomment MODASH_API_TOKEN in .env and set it
npm run lookup -- customers.csv --sample 2000      # check 2,000 emails spread across the file
npm run lookup -- customers.csv --max-credits 100  # check the rest
```

Setting `MODASH_API_TOKEN` in your shell works too.

| Option | What it does |
| --- | --- |
| `--column <name>` | The column that holds the emails, by its header. `email` by default. Upper and lower case are the same. |
| `--sample <n>` | Use `n` emails spread evenly across the file, not the whole file. A file with fewer emails is used whole. |
| `--batch-size <n>` | Emails per API call, 1 to 1,000. 1,000 by default. |
| `--max-credits <n>` | Most credits this run may spend. `MODASH_CREDIT_BUDGET` by default, or 50. Must be above 0. |
| `--mock` | Answer from the invented accounts, with no token and no network. Any other email comes back unmatched. |

- **Checks first.** Before anything is sent, the tool reads the whole file and every option. If the file, the column or an option's value is wrong, the run does not start, and it lists the problems it found together.
- **What is sent.** Each email is trimmed, put in lower case and sent once. A leading `mailto:` is removed. Blank cells are counted and never sent. Values that are not an email address are not sent either; the first five are listed with their line number.
- **Budget.** A call holds 0.02 credits for every email in it until its answer comes back, then gives back what the misses did not cost. A call of 1,000 emails holds 20 credits, so a budget below 20 needs a smaller `--batch-size`. The run stops before any call that could take it over the budget.
- **Results** go to `output/results.jsonl`, one line per email checked, matched or not. Every file you check shares that one results file. `lookup-example` and `--mock` write `output/mock-results.jsonl` and start it over each time.
- **Resume.** Run the same command again on a live run. Emails that already have a line are not sent again, so a full run after a sample only sends the rest. Ctrl-C stops a run at once and prints what it spent. If a call was out at that moment, the tool cannot tell what it cost, so it prints that call's highest cost apart and its emails are sent again on the next run.
- **Keep the output private.** `output/` holds your customers' emails next to creators' accounts, and a live run prints the same in the terminal. `output/` is gitignored. Do not commit, share or screen-record either.
- **Errors.** An invalid token (`api_token_invalid`), a refused one (HTTP 401 or 403), a balance that cannot cover the call (`not_enough_credits`) or an answer the tool cannot read stops the run with the API's message. Any other failed call is listed at the end, its emails get no line, and a rerun sends them again.

`npm test` runs the tests offline, with no token and no network.

## What you get

One record per email, in lower case, so you can join it back to your file on the email.

```json
{
  "email": "baker@example.com",
  "accounts": [
    { "platform": "instagram", "userId": "1000000001", "username": "example_baker", "url": "https://www.instagram.com/example_baker/", "followers": 100000, "isVerified": false },
    { "platform": "tiktok", "userId": "7000000000000000001", "username": "example_baker", "url": "https://www.tiktok.com/@example_baker", "followers": 200000, "isVerified": false }
  ],
  "review": null
}
```

| Record | What it means | Suggested rule |
| --- | --- | --- |
| `accounts` has entries, `review` is `null` | One account per platform lists this email | Store the accounts on the customer. Where a wrong match is costly, compare a second field first (step 5) |
| `review` is `"2 instagram accounts list this email"` | Two or more accounts on one platform list it, so the email alone cannot say which is your customer. It can be a shared address, such as an agency's | Do not store it. Show the accounts to a person |
| `accounts` is empty | No creator account lists this email | Nothing to store. The check cost nothing |

`userId` is the account's id on its platform. Pass it to the other Discovery endpoints, such as the
profile report, when you want more than the account itself.

## The endpoint

| Call | What it returns | Cost |
| --- | --- | --- |
| `POST /v1/email-search` with `{"emails": [...]}` | For each email, the Instagram, TikTok and YouTube accounts that list it in their bio or as their contact information. 1 to 1,000 emails a call | 0.02 credits per matched email |

The call takes the header `Authorization: Bearer <your token>`. The balance must hold at least 0.02
credits for every email in the call, or it returns `not_enough_credits`. The
[API reference](https://docs.modash.io) states that Modash does not store the email addresses you send.

The call and its cost live in [`src/modash/reads.ts`](./src/modash/reads.ts). Every request goes
through [`src/modash/client.ts`](./src/modash/client.ts), which holds the budget, retries and error
handling.

## Step 1: clean the list

A customer file has blank cells, repeats and values that are not emails. `emailList()` in
[`src/emails.ts`](./src/emails.ts) trims each value, puts it in lower case, removes a leading
`mailto:`, drops the blanks and the values that are not one email address, and keeps each email once. Every email in a call counts toward
the balance the call needs, so a repeat is never worth sending.

## Step 2: price the file before you send it

`npm run estimate -- customers.csv` makes no API call. For a file of 100,000 emails it prints:

```
customers.csv: 100,000 rows, 100,000 emails to check
Checking 100,000 emails takes 100 calls of up to 1,000 emails.
It costs 0.02 credits per email that matches: 0 if none match, 2,000 if all do.
Before each call the balance must cover 0.02 credits for every email in it: 20 credits for the largest call here.
```

Two numbers matter. The cost depends on how many emails match, which you do not know yet. The
balance does not: a call of 1,000 emails needs 20 credits in the account even if none of them match.

## Step 3: check a sample first

`--sample 2000` checks 2,000 emails and projects the rest of the file from them:

```
4 of the 2,000 sample emails matched. At that rate the other 98,000 emails would match about 196 and cost about 3.92 credits (1,960 at most).
```

Those numbers are an illustration, not a benchmark. `sampleOf()` takes every n-th email across the
whole file, not the first rows, because a file is often sorted by sign-up date or by region and its
first rows are not like the rest. The sample is the same on every run, so a rerun resumes it.

When matches are rare, a small sample can come back with none. The tool says so and does not call
the file empty: check a larger sample before you decide.

## Step 4: send the list

```bash
curl -X POST "https://api.modash.io/v1/email-search" \
  -H "Authorization: Bearer $MODASH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"emails": ["baker@example.com", "dana@example.org"]}'
```

```json
{
  "error": false,
  "matchedEmails": [
    {
      "email": "baker@example.com",
      "users": [
        { "platform": "instagram", "userId": "1000000001", "url": "https://www.instagram.com/example_baker/", "username": "example_baker", "followers": 100000, "isVerified": false },
        { "platform": "tiktok", "userId": "7000000000000000001", "url": "https://www.tiktok.com/@example_baker", "username": "example_baker", "followers": 200000, "isVerified": false }
      ]
    }
  ],
  "notMatchedEmails": ["dana@example.org"],
  "totalMatches": 1
}
```

The response above is for two invented emails, with fewer fields per account than a real one. The
tool reads `matchedEmails` and `totalMatches`. One email
can return one or more accounts on Instagram, YouTube or TikTok.

`lookUp()` in
[`src/lookup.ts`](./src/lookup.ts) sends the list one call after another, and writes each call's
emails to the results file as soon as its answer is back, so a stopped run loses nothing it paid for.

## Step 5: check each match before you store it

An email in a creator's bio is not always the creator's own. An agency or a manager can put one
address on several creators' profiles. When two accounts on one platform list the email, the email
alone cannot say which one is your customer, so `reviewOf()` marks the record:

```json
{
  "email": "talent@agency.example",
  "accounts": [
    { "platform": "instagram", "userId": "1000000004", "username": "example_runner", "url": "https://www.instagram.com/example_runner/", "followers": 300000, "isVerified": false },
    { "platform": "instagram", "userId": "1000000005", "username": "example_chef", "url": "https://www.instagram.com/example_chef/", "followers": 40000, "isVerified": false }
  ],
  "review": "2 instagram accounts list this email"
}
```

The check catches a shared address only when two of the accounts that list it are on the same
platform. An agency address that one account lists looks like any other match. If a wrong match is
costly in your product, compare a second field you hold, such as the customer's name, with the
account before you store it.

## What it costs

| List | Calls | Credits |
| --- | --- | --- |
| The example list: 5 emails, 3 match | 1 | 0.06 |
| 2,000 emails, 4 match | 2 | 0.08 |
| 100,000 emails, none match | 100 | 0 |
| 100,000 emails, all match | 100 | 2,000 |

An email that matches costs 0.02 credits however many accounts it returns. Calls run one after
another, and each successful call is followed by a 0.6 second pause to space them out.

## What can go wrong

- **`not_enough_credits` on a list that would cost almost nothing.** The balance has to cover 0.02 credits for every email in the call, matched or not. Add credits, or lower `--batch-size`: a call of 100 emails needs 2 credits.
- **HTTP 429.** The tool treats it as a call that was refused, waits 3, 6, 9 then 12 seconds and tries again. If the call still fails, its emails get no line and a rerun sends them again.
- **A server error, a timeout or a dropped connection.** The tool cannot tell whether the call ran, so it does not send it again in that run. Its emails get no line, and its highest possible cost stays counted against the budget.
- **`up to Y more for calls that got no clear answer`.** The run ends with this when a call above happened. Check your balance, then run again to send those emails.
- **A match with no account.** When the API matches an email and returns no Instagram, TikTok or YouTube account for it, the record says so in `review`. A matched email that was not in the call is counted in the summary and gets no record.
- **A results line the tool cannot read.** A line cut off by a crash, or edited by hand, stays in the file and is ignored. Its email is sent again.
- **A run stopped partway.** Every answered call is already in `output/results.jsonl`. Run the same command again to carry on. Each run starts with the full budget.
- **Shared addresses.** See step 5. The `review` field catches only the case where two accounts on one platform list the email.
- **Old results.** The results file does not expire, and a creator can change the email on their profile. Delete `output/results.jsonl` to check a list again from the start.

## Files

| Path | What it is |
| --- | --- |
| `src/lookup.ts` | The method: send the list call by call, join each answer to its email, mark shared addresses |
| `src/emails.ts` | Cleaning the list, and taking a sample spread across it |
| `src/estimate.ts` | The arithmetic: calls, highest cost, balance per call, and the projection from a sample |
| `src/csv.ts` | Reading one column of a CSV |
| `src/modash/reads.ts` | The one Modash call the method makes, with its cost |
| `src/modash/` | The HTTP layer: client with budget and retries, response schema, errors, mock transport |
| `src/run.ts`, `src/cli.ts` | The command line: arguments, checks, output |
| `src/results.ts` | The results file: which emails are checked, resume, one line per email |
| `src/config.ts` | The environment variables: token, credit budget |
| `src/numbers.ts` | Rounding credits to two decimals |
| `fixtures/demo-accounts.json` | What `lookup-example` and `--mock` answer from: invented accounts, keyed by the email they list |
| `emails.example.csv` | The invented list `lookup-example` checks, and the CSV format |
| `sample-output/` | What `lookup-example` prints, and the results file it writes |
| `test/` | Offline tests: `npm test` |
