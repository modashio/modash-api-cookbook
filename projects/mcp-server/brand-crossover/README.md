# Brand crossover

Ask Claude whether creators who promote brand A also promote brand B, using real Modash data.

[![Download for Claude Desktop](https://img.shields.io/badge/Download%20for%20Claude%20Desktop-2563EB?style=for-the-badge)](https://github.com/modashio/modash-api-cookbook/releases/download/mcp-server-v1.0.2/modash-api-mcp-1.0.2.mcpb)

Needs [Claude Desktop](https://claude.ai/download). The file is the Modash connector (an MCP) Claude uses to look up creator posts.

1. Click the button to download.
2. Double-click the file. Claude Desktop opens and shows Install. Click it.
3. Paste your Modash API token, set Credit budget per session to 200 (it starts at 5, which is too low for this), and leave Enable RAW API tools and RAW request budget per session as they are.

Get the token from [marketer.modash.io/developer](https://marketer.modash.io/developer). New to the API? [Request access](https://www.modash.io/influencer-marketing-api?utm_source=github&utm_campaign=api_cookbook) first.

Without a token it runs on demo data, so the results will not be real.

## Then just ask Claude

Swap in your own brands.

```text
Do creators who promote <brand A> also promote <brand B>? Check Instagram for the last 3 months.
```

```text
How many credits would that cost?
```

```text
Use their websites, <brand-a.com> and <brand-b.com>, and compare them with two unrelated brands, <brand C> and <brand D>.
```

```text
Same check, only creators in the United States with at least 10,000 followers.
```

## What it costs

Asking what it would cost is free. A run above 20 credits asks you to confirm, and nothing can spend past the credit budget you set.

**Using Claude Code instead?**

```text
/plugin marketplace add modashio/modash-api-cookbook
/plugin install modash-api-mcp@modash-api-cookbook
```
