/**
 * The agent's tools.
 *
 * Each tool returns a *compact* result for the model and, where it's useful,
 * writes a rich typed data part for the UI. Tool failures are returned as data
 * rather than thrown: a credit-budget stop or a `no_result` is information the
 * agent should react to, not a reason to kill the stream.
 */

import { tool, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';
import type { AudienceReport, Creator } from '../../shared/creators';
import { formatCount } from '../../shared/format';
import type { ChatMessage, SearchDataPart, ShortlistEntry } from '../../shared/messages';
import type { ModashApi } from '../modash/api';
import { ModashApiError } from '../modash/client';
import {
  aiSearchCost,
  CREDITS_PER_REPORT,
  CreditBudgetExceededError,
  type CreditLedger,
} from '../modash/credits';
import { aiSearchFiltersSchema, platformSchema, type AiSearchFilters } from '../modash/schemas';

export interface AgentContext {
  api: ModashApi;
  ledger: CreditLedger;
  writer: UIMessageStreamWriter<ChatMessage>;
  maxPageSize: number;
  /** Every creator the agent has seen this turn, so shortlisting only needs a handle. */
  seen: Map<string, Creator>;
  shortlist: Map<string, ShortlistEntry>;
  /** Reports already bought, so the same creator is never paid for twice. */
  reports: Map<string, AudienceReport>;
  /** Creators the user gave a thumbs down; they must not come back. */
  disliked: Set<string>;
}

export function createAgentTools(ctx: AgentContext) {
  const publishUsage = (accountCredits?: number) => {
    ctx.writer.write({
      type: 'data-usage',
      id: 'usage',
      data: {
        creditsSpent: Number(ctx.ledger.spent.toFixed(4)),
        creditsBudget: ctx.ledger.budget,
        paidCalls: ctx.ledger.calls,
        mock: ctx.api.isMock,
        ...(accountCredits === undefined ? {} : { accountCredits }),
      },
    });
  };

  const notify = (level: 'info' | 'warning' | 'error', message: string) => {
    ctx.writer.write({ type: 'data-notice', data: { level, message }, transient: true });
  };

  const remember = (creators: Creator[]) => {
    for (const creator of creators) ctx.seen.set(key(creator.platform, creator.username), creator);
  };

  return {
    resolveLocations: tool({
      description:
        'Look up Modash location IDs by name. Free. Required before using the `locations` filter — IDs cannot be guessed.',
      inputSchema: z.object({
        platform: platformSchema,
        query: z.string().describe('City, region or country name, e.g. "berlin" or "united kingdom".'),
      }),
      execute: async ({ platform, query }) => {
        try {
          const hits = await ctx.api.locations(platform, query);
          return hits.length ? { locations: hits } : { locations: [], note: `No location matched "${query}".` };
        } catch (error) {
          return { error: toToolError(error) };
        }
      },
    }),

    resolveLanguage: tool({
      description: 'Look up Modash language codes by name. Free. Required before using the `language` filter.',
      inputSchema: z.object({
        platform: platformSchema,
        query: z.string().describe('Language name, e.g. "german".'),
      }),
      execute: async ({ platform, query }) => {
        try {
          return { languages: await ctx.api.languages(platform, query) };
        } catch (error) {
          return { error: toToolError(error) };
        }
      },
    }),

    resolveBrands: tool({
      description:
        'Look up brand names valid for the AI Search `brands` filter, which finds creators who have posted about a brand. Free.',
      inputSchema: z.object({
        query: z.string().describe('Brand name, e.g. "on running".'),
        platform: platformSchema.optional(),
      }),
      execute: async ({ query, platform }) => {
        try {
          return { brands: await ctx.api.brands(query, platform) };
        } catch (error) {
          return { error: toToolError(error) };
        }
      },
    }),

    resolveTextTags: tool({
      description:
        'Look up popular hashtags or @mentions by prefix, for the `textTags` filter. Free. Mentions are not available on YouTube.',
      inputSchema: z.object({
        platform: platformSchema,
        type: z.enum(['hashtag', 'mention']),
        query: z.string().describe('Prefix without # or @.'),
      }),
      execute: async ({ platform, type, query }) => {
        try {
          return { tags: await ctx.api.textTags(platform, type, query) };
        } catch (error) {
          return { error: toToolError(error) };
        }
      },
    }),

    searchCreators: tool({
      description: [
        'Run a Modash AI Search: semantic search over creators’ post content, combined with hard filters.',
        'Costs 0.025 credits per returned profile, so keep pageSize small until a query direction is working.',
        'Put content semantics in `query` and everything measurable in `filters`. Negation does not work.',
      ].join(' '),
      inputSchema: z.object({
        platform: platformSchema,
        query: z
          .string()
          .max(4_000)
          .optional()
          .describe(
            'Natural-language description of the creator and their content. Omit to sort purely by follower count.',
          ),
        filters: aiSearchFiltersSchema.optional(),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Profiles to return. Each one costs 0.025 credits. Start at 10.'),
        page: z.number().int().min(0).max(29).optional().describe('0-indexed page. Only paginate on request.'),
        rationale: z
          .string()
          .describe('One sentence on what this specific search is testing. Shown to the user.'),
      }),
      execute: async ({ platform, query, filters, pageSize, page = 0, rationale }, { abortSignal }) => {
        const size = Math.min(pageSize ?? 10, ctx.maxPageSize);
        const partId = `search-${crypto.randomUUID()}`;
        const base: SearchDataPart = {
          kind: 'text-search',
          status: 'running',
          platform,
          query: query ?? '(no semantic query — sorted by followers)',
          filterSummary: summariseFilters(filters),
          rationale,
        };

        ctx.writer.write({ type: 'data-search', id: partId, data: base });

        try {
          ctx.ledger.assertCanSpend(aiSearchCost(size));

          const result = await ctx.api.textSearch({
            platform,
            ...(query ? { query } : {}),
            filters,
            page,
            pageSize: size,
            ...(abortSignal ? { signal: abortSignal } : {}),
          });

          const credits = aiSearchCost(result.creators.length);
          ctx.ledger.record(`${platform} text-search`, credits);
          remember(result.creators);

          ctx.writer.write({
            type: 'data-search',
            id: partId,
            data: { ...base, status: 'complete', total: result.total, creators: result.creators, creditsSpent: credits },
          });
          publishUsage();

          return {
            totalAvailable: result.total,
            returned: result.creators.length,
            creditsSpent: credits,
            creditsRemainingInBudget: Number(ctx.ledger.remaining.toFixed(3)),
            creators: result.creators.map(summariseCreator),
          };
        } catch (error) {
          const message = toToolError(error);
          ctx.writer.write({ type: 'data-search', id: partId, data: { ...base, status: 'error', error: message } });
          notify(error instanceof CreditBudgetExceededError ? 'warning' : 'error', message);
          return { error: message };
        }
      },
    }),

    findLookalikes: tool({
      description: [
        'Find creators semantically similar to 1–5 creators you already like.',
        'Can cross platforms: source creators on Instagram, results on TikTok, for example.',
        'Costs 0.025 credits per returned profile. Use this when the user names reference creators, or to expand a promising result.',
      ].join(' '),
      inputSchema: z.object({
        sourcePlatform: platformSchema.describe('Platform the reference creators are on.'),
        usernames: z
          .array(z.string())
          .min(1)
          .max(5)
          .describe('Usernames or user IDs of the reference creators, without @.'),
        targetPlatform: platformSchema.describe('Platform to find similar creators on. May equal sourcePlatform.'),
        filters: aiSearchFiltersSchema.optional(),
        pageSize: z.number().int().min(1).max(50).optional(),
        rationale: z.string().describe('One sentence on why these references. Shown to the user.'),
      }),
      execute: async (
        { sourcePlatform, usernames, targetPlatform, filters, pageSize, rationale },
        { abortSignal },
      ) => {
        const size = Math.min(pageSize ?? 10, ctx.maxPageSize);
        const partId = `lookalikes-${crypto.randomUUID()}`;
        const base: SearchDataPart = {
          kind: 'lookalikes',
          status: 'running',
          platform: targetPlatform,
          query: usernames.map((name) => `@${name}`).join(', '),
          filterSummary: summariseFilters(filters),
          rationale,
        };

        ctx.writer.write({ type: 'data-search', id: partId, data: base });

        try {
          ctx.ledger.assertCanSpend(aiSearchCost(size));

          const result = await ctx.api.lookalikes({
            sourcePlatform,
            userIds: usernames.map((name) => name.replace(/^@/, '')),
            targetPlatform,
            filters,
            pageSize: size,
            ...(abortSignal ? { signal: abortSignal } : {}),
          });

          const credits = aiSearchCost(result.creators.length);
          ctx.ledger.record(`${sourcePlatform} → ${targetPlatform} lookalikes`, credits);
          remember(result.creators);

          ctx.writer.write({
            type: 'data-search',
            id: partId,
            data: { ...base, status: 'complete', total: result.total, creators: result.creators, creditsSpent: credits },
          });
          publishUsage();

          return {
            sources: result.sources.map(summariseCreator),
            totalAvailable: result.total,
            returned: result.creators.length,
            creditsSpent: credits,
            creditsRemainingInBudget: Number(ctx.ledger.remaining.toFixed(3)),
            creators: result.creators.map(summariseCreator),
          };
        } catch (error) {
          const message = toToolError(error);
          ctx.writer.write({ type: 'data-search', id: partId, data: { ...base, status: 'error', error: message } });
          notify(error instanceof CreditBudgetExceededError ? 'warning' : 'error', message);
          return { error: message };
        }
      },
    }),

    shortlistCreators: tool({
      description:
        'Add creators from earlier search results to the shortlist panel. Free. Only use handles that appeared in a search result.',
      inputSchema: z.object({
        creators: z
          .array(
            z.object({
              platform: platformSchema,
              username: z.string(),
              reason: z.string().describe('One specific sentence on why this creator fits the brief.'),
              fit: z.enum(['strong', 'possible']),
            }),
          )
          .min(1),
      }),
      execute: async ({ creators }) => {
        const added: string[] = [];
        const unknown: string[] = [];
        const rejected: string[] = [];

        for (const item of creators) {
          const handle = item.username.replace(/^@/, '');

          // A thumbs down is not a suggestion. Enforce it here so a lapse in
          // instruction-following can't put a rejected creator back on the list.
          if (ctx.disliked.has(key(item.platform, handle))) {
            rejected.push(handle);
            continue;
          }

          const creator = ctx.seen.get(key(item.platform, handle));
          if (!creator) {
            unknown.push(item.username);
            continue;
          }
          ctx.shortlist.set(key(creator.platform, creator.username), {
            creator,
            reason: item.reason,
            fit: item.fit,
          });
          added.push(creator.username);
        }

        for (const entryKey of ctx.shortlist.keys()) {
          if (ctx.disliked.has(entryKey)) ctx.shortlist.delete(entryKey);
        }

        ctx.writer.write({
          type: 'data-shortlist',
          id: 'shortlist',
          data: { entries: [...ctx.shortlist.values()] },
        });

        return {
          added,
          shortlistSize: ctx.shortlist.size,
          ...(unknown.length
            ? { skipped: unknown, note: 'These handles were not in any search result, so they were skipped.' }
            : {}),
          ...(rejected.length
            ? {
                rejected,
                rejectedNote:
                  'The user marked these as not wanted, so they were not added. Do not propose them again.',
              }
            : {}),
        };
      },
    }),

    getAudienceReports: tool({
      description: [
        'Pull full profile reports for creators already on the shortlist: audience credibility, country split, gender split, age brackets, and public contact details.',
        'This is the expensive call — 1 credit per creator, forty times an AI Search profile — so only run it on finalists the user is likely to contact, never on a whole result set.',
      ].join(' '),
      inputSchema: z.object({
        creators: z
          .array(z.object({ platform: platformSchema, username: z.string() }))
          .min(1)
          .max(5)
          .describe('Creators to report on. Keep this short; each one costs a full credit.'),
      }),
      execute: async ({ creators }, { abortSignal }) => {
        const partId = `reports-${crypto.randomUUID()}`;

        // A report costs a full credit, so never buy one for a creator the user
        // has already rejected — a stale "pull reports for the shortlist" button
        // can otherwise fire after a thumbs-down.
        const wanted = creators.filter(
          (creator) => !ctx.disliked.has(key(creator.platform, creator.username.replace(/^@/, ''))),
        );
        const vetoed = creators
          .filter((creator) => !wanted.includes(creator))
          .map((creator) => creator.username.replace(/^@/, ''));
        const usernames = wanted.map((creator) => creator.username.replace(/^@/, ''));

        if (wanted.length === 0) {
          return {
            reports: [],
            skipped: vetoed,
            note: 'Every creator here is marked not wanted, so nothing was bought.',
          };
        }

        ctx.writer.write({ type: 'data-reports', id: partId, data: { status: 'running', usernames } });

        // Declared outside the try so a failure part-way through can still report
        // what was already paid for.
        const reports: AudienceReport[] = [];
        let credits = 0;

        try {
          const unpaid = wanted.filter(
            (creator) => !ctx.reports.has(key(creator.platform, creator.username.replace(/^@/, ''))),
          );
          ctx.ledger.assertCanSpend(unpaid.length * CREDITS_PER_REPORT);

          for (const creator of wanted) {
            const username = creator.username.replace(/^@/, '');
            const cached = ctx.reports.get(key(creator.platform, username));
            if (cached) {
              reports.push(cached);
              continue;
            }

            // Billed individually, so record each one as it lands rather than
            // after the loop — a failure halfway through should still account
            // for what was already spent.
            const report = await ctx.api.profileReport(creator.platform, username, abortSignal);
            ctx.ledger.record(`${creator.platform} profile report`, CREDITS_PER_REPORT);
            credits += CREDITS_PER_REPORT;
            reports.push(report);
            ctx.reports.set(key(creator.platform, username), report);
          }

          ctx.writer.write({
            type: 'data-reports',
            id: partId,
            data: { status: 'complete', usernames, reports, creditsSpent: credits },
          });
          publishUsage();

          return {
            creditsSpent: credits,
            creditsRemainingInBudget: Number(ctx.ledger.remaining.toFixed(3)),
            ...(vetoed.length ? { skipped: vetoed, note: 'Marked not wanted, so not bought.' } : {}),
            reports: reports.map(summariseReport),
          };
        } catch (error) {
          const message = toToolError(error);

          // Reports are billed one at a time. If the third of five fails, the
          // first two are already paid for — emit them anyway, or the next turn
          // rehydrates without them and buys them again.
          ctx.writer.write({
            type: 'data-reports',
            id: partId,
            data: {
              status: 'error',
              usernames,
              error: message,
              ...(reports.length ? { reports, creditsSpent: credits } : {}),
            },
          });
          publishUsage();
          notify(error instanceof CreditBudgetExceededError ? 'warning' : 'error', message);

          return {
            error: message,
            ...(reports.length
              ? {
                  creditsSpent: credits,
                  note: 'These reports were bought before the failure and are already paid for.',
                  reports: reports.map(summariseReport),
                }
              : {}),
          };
        }
      },
    }),

    proposeNextSteps: tool({
      description: [
        'Offer the user one-click follow-ups. Free. Call this once, as the last thing you do in a turn.',
        'Each step becomes a button in the UI, and `instruction` is sent back to you verbatim when clicked — so write it as a direct instruction, not a description.',
        'Only propose things you can actually carry out with your own tools.',
      ].join(' '),
      inputSchema: z.object({
        steps: z
          .array(
            z.object({
              label: z
                .string()
                .max(60)
                .describe('Button text. Short and concrete, e.g. "Pull audience reports for the top 3".'),
              instruction: z
                .string()
                .describe(
                  'The message to send you when clicked, written as an order: "Pull audience reports for @a, @b and @c."',
                ),
              estimatedCredits: z
                .number()
                .min(0)
                .optional()
                .describe('Rough cost, so the user is not spending blind. Omit for free actions.'),
            }),
          )
          .min(1)
          .max(3),
      }),
      execute: async ({ steps }) => {
        ctx.writer.write({ type: 'data-nextSteps', id: 'next-steps', data: { steps } });
        return { proposed: steps.length };
      },
    }),

    removeFromShortlist: tool({
      description:
        'Take creators off the shortlist. Free. Use this after reviewing them — a shortlist is only useful if you are willing to cut from it.',
      inputSchema: z.object({
        creators: z
          .array(
            z.object({
              platform: platformSchema,
              username: z.string(),
              reason: z.string().describe('One specific sentence on why this creator is out.'),
            }),
          )
          .min(1),
      }),
      execute: async ({ creators }) => {
        const removed: string[] = [];

        for (const item of creators) {
          const handle = item.username.replace(/^@/, '');
          if (ctx.shortlist.delete(key(item.platform, handle))) removed.push(handle);
        }

        ctx.writer.write({
          type: 'data-shortlist',
          id: 'shortlist',
          data: { entries: [...ctx.shortlist.values()] },
        });

        return { removed, shortlistSize: ctx.shortlist.size };
      },
    }),

    checkCredits: tool({
      description:
        "Report this session's credit spend and, from GET /user/info, the account balance. Free.",
      inputSchema: z.object({}),
      execute: async () => {
        let accountCredits: number | undefined;
        try {
          accountCredits = (await ctx.api.accountInfo()).credits;
        } catch {
          // /user/info is a nice-to-have here; a failure shouldn't derail the turn.
        }
        publishUsage(accountCredits);
        return {
          sessionCreditsSpent: Number(ctx.ledger.spent.toFixed(4)),
          sessionBudget: ctx.ledger.budget,
          sessionCreditsRemaining: Number(ctx.ledger.remaining.toFixed(4)),
          ...(accountCredits === undefined ? {} : { accountCreditsRemaining: accountCredits }),
        };
      },
    }),
  };
}

/**
 * What the model sees per creator. AI Search returns no bio or captions, so this
 * is genuinely all the information available — keeping the shape honest stops the
 * model from inventing qualitative claims.
 */
/** What the model needs from a report; the full payload goes to the UI instead. */
function summariseReport(report: AudienceReport) {
  return {
    username: report.username,
    credibility: report.credibility,
    topCountries: report.topCountries,
    genders: report.genders,
    ageBrackets: report.ageBrackets,
    hasEmail: report.contacts.some((contact) => contact.type === 'email'),
  };
}

function summariseCreator(creator: Creator) {
  return {
    username: creator.username,
    platform: creator.platform,
    fullName: creator.fullName,
    followers: creator.followers,
    engagementRate: creator.engagementRate,
    postsPerMonth: creator.postsPerMonth,
    medianViews: creator.medianViews,
    accountCategory: creator.accountCategory,
    matchedPostCount: creator.matchedPosts.length,
  };
}

function summariseFilters(filters: AiSearchFilters | undefined): string[] {
  if (!filters) return [];
  const parts: string[] = [];

  const { followersCount, viewsCount, engagementRate, postingFrequency } = filters;
  if (followersCount?.min || followersCount?.max) {
    parts.push(`followers ${formatCount(followersCount.min)}–${formatCount(followersCount.max)}`);
  }
  if (engagementRate?.min) parts.push(`ER ≥ ${(engagementRate.min * 100).toFixed(1)}%`);
  if (viewsCount?.min) parts.push(`${viewsCount.calculationMethod ?? 'median'} views ≥ ${formatCount(viewsCount.min)}`);
  if (postingFrequency?.min || postingFrequency?.max) {
    parts.push(`${postingFrequency.min ?? 0}–${postingFrequency.max ?? '∞'} posts/mo`);
  }
  if (filters.language) parts.push(`language ${filters.language}`);
  if (filters.locations?.length) parts.push(`${filters.locations.length} location filter(s)`);
  if (filters.gender) parts.push(`gender ${filters.gender.toLowerCase()}`);
  if (filters.age?.min || filters.age?.max) parts.push(`age ${filters.age.min ?? ''}–${filters.age.max ?? ''}`);
  if (filters.accountType) parts.push(filters.accountType.replace(/_/g, ' '));
  if (filters.contentType) parts.push(`${filters.contentType} content`);
  if (filters.lastPostedInDays) parts.push(`posted in ${filters.lastPostedInDays}d`);
  if (filters.maxPostAgeMonths) parts.push(`posts < ${filters.maxPostAgeMonths}mo`);
  if (filters.hasEmail) parts.push('has email');
  if (filters.audience?.credibility) parts.push(`credibility ≥ ${filters.audience.credibility}`);
  if (filters.brands?.length) parts.push(`brands: ${filters.brands.join(', ')}`);
  if (filters.textTags?.length) {
    parts.push(
      filters.textTags
        .map((tag) => `${tag.mode === 'exclude' ? '−' : ''}${tag.type === 'hashtag' ? '#' : '@'}${tag.value}`)
        .join(' '),
    );
  }
  if (filters.bio) parts.push(`bio: "${filters.bio}"`);
  if (filters.keywords) parts.push(`captions: "${filters.keywords}"`);

  return parts;
}

function key(platform: string, username: string): string {
  return `${platform}:${username.toLowerCase()}`;
}

function toToolError(error: unknown): string {
  if (error instanceof CreditBudgetExceededError) {
    return `${error.message} Ask the user before spending more, or search with a smaller pageSize.`;
  }
  if (error instanceof ModashApiError) {
    return `Modash API error (${error.code}): ${error.userFacingMessage}`;
  }
  return error instanceof Error ? error.message : String(error);
}
