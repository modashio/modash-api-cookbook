import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

import {
  CONFIRM_THRESHOLD_CREDITS,
  type CrossoverOptions,
  type CrossoverPlan,
  cheaperOptions,
  DEFAULT_WINDOW_DAYS,
  planCrossover,
  runCrossover,
} from '../../analysis/brand-crossover.js';
import { platformSchema } from '../../server/modash/filters.js';
import type { ToolContext } from '../context.js';
import { guard, priced, problem, respond, withCost } from '../result.js';

/**
 * Brand crossover: do creators who post about one brand also post about its rival?
 *
 * Two tools rather than one, because the expensive part is unknowable until it has run. The plan
 * is free and says what the run could cost at most; the run checks the same ceiling against the
 * budget and refuses before sending anything when it does not fit.
 *
 * A run is never silently expensive. Below CONFIRM_THRESHOLD_CREDITS it just runs. Above it, the
 * run refuses and asks for `confirmCredits` instead of spending — it is one more thing for a model
 * to get wrong on its own, so the model is expected to show the user the estimate and only pass
 * `confirmCredits` back once they say yes. Either way, nothing a caller sends can push a run past
 * the remaining session budget (`MODASH_CREDIT_BUDGET`); that check happens first and ignores
 * `confirmCredits` entirely.
 */

const brandInput = z
  .string()
  .min(1)
  .describe('Brand website domain (best, e.g. "example.com"), brand name, or a brandId from the plan');

const inputShape = {
  brandA: brandInput,
  brandB: brandInput,
  baseline: z
    .tuple([brandInput, brandInput])
    .optional()
    .describe(
      'Two brands from categories unrelated to the rivals and to each other, ideally of similar ' +
        'size, e.g. a soda brand and a games console brand. Doubles the posts cost but is what ' +
        'makes the answer meaningful. If the user did not name any, pick two well-known ones and ' +
        'say which.',
    ),
  platform: platformSchema.default('instagram'),
  windowDays: z
    .number()
    .int()
    .min(7)
    .max(365)
    .default(DEFAULT_WINDOW_DAYS)
    .describe(
      `How far back from endDate to look. Defaults to ${DEFAULT_WINDOW_DAYS} days (the last ~3 ` +
        "months), so a default run finishes before a client's tool-call timeout, typically 60 " +
        'seconds. A longer window costs more and, like anything else over the confirmation ' +
        'limit, needs confirmCredits.',
    ),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('YYYY-MM-DD, exclusive. Defaults to today (UTC)'),
  sampleWeeks: z
    .number()
    .int()
    .min(1)
    .max(53)
    .default(6)
    .describe(
      'How many 7-day weeks to pull, spread evenly over the window. 53 pulls every week of a ' +
        'year. Fewer weeks is cheaper, but undercounts creators who posted about the two brands ' +
        'in different weeks, so compare against a baseline run the same way.',
    ),
  maxPagesPerWeek: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(3)
    .describe('Cap on 30-post pages per brand per week, 0.2 credits each. Big brands fill many pages.'),
  location: z
    .string()
    .optional()
    .describe('Only count creators in this place, e.g. "United States". Adds an AI Search lookup step'),
  minFollowers: z
    .number()
    .int()
    .min(1_000)
    .optional()
    .describe('Only count creators with at least this many followers. Adds the same lookup step'),
  maxCrossoverLookups: z
    .number()
    .int()
    .min(1)
    .max(700)
    .default(150)
    .describe('Most crossover creators to look up per pair; more are sampled'),
  baseSampleSize: z
    .number()
    .int()
    .min(1)
    .max(700)
    .default(150)
    .describe('Creators sampled from the rest of the base per pair, to estimate the filtered base'),
  seed: z.number().int().default(1).describe('Seed for the samples, so a run can be repeated'),
  confirmCredits: z
    .number()
    .min(0)
    .optional()
    .describe(
      `Confirms a spend above the ${CONFIRM_THRESHOLD_CREDITS}-credit default limit for a single ` +
        'run. Leave unset the first time. Set it only after telling the user the estimated cost ' +
        '(the ceiling below, or from modash_plan_brand_crossover) and getting their explicit ' +
        'go-ahead — never set it on your own initiative or because a previous call asked for it. ' +
        'Set it to at least the ceiling credits named in that ask. A run still refuses, confirmed ' +
        'or not, if the ceiling is above what is left of the session budget.',
    ),
};

const resolvedBrandSchema = z.object({
  input: z.string(),
  brandId: z.string(),
  name: z.string(),
  matchedBy: z.enum(['domain', 'brandId', 'name']),
  alternatives: z.array(z.object({ brandId: z.string(), name: z.string() })),
});

const ceilingSchema = z.object({
  postsCredits: z.number(),
  lookupCredits: z.number(),
  totalCredits: z.number(),
  paidCalls: z.number(),
  worstCaseSeconds: z.number(),
});

const planShape = {
  platform: platformSchema,
  window: z.object({ from: z.string(), to: z.string(), days: z.number() }),
  sampling: z.object({
    weeksInWindow: z.number(),
    weeksPulled: z.number(),
    maxPagesPerWeek: z.number(),
    fullPull: z.boolean(),
  }),
  brands: z.array(resolvedBrandSchema),
  creatorFilter: z
    .object({
      locationId: z.number().optional(),
      locationTitle: z.string().optional(),
      minFollowers: z.number().optional(),
    })
    .optional(),
  ceiling: ceilingSchema,
};

const pairSchema = z.object({
  brands: z.tuple([z.string(), z.string()]),
  creatorsA: z.number(),
  creatorsB: z.number(),
  either: z.number(),
  both: z.number(),
  crossoverShare: z.number(),
  shareOfAAlsoB: z.number(),
  shareOfBAlsoA: z.number(),
  exampleCrossoverCreators: z.array(
    z.object({ username: z.string(), postsAboutA: z.number(), postsAboutB: z.number() }),
  ),
});

const filteredSchema = z.object({
  crossoverLookedUp: z.number(),
  crossoverMatched: z.number(),
  baseSampled: z.number(),
  baseSampleMatched: z.number(),
  estimatedBothMatching: z.number(),
  estimatedEitherMatching: z.number(),
  crossoverShare: z.number(),
});

const BUDGET_HINT =
  'Raise the session budget with MODASH_CREDIT_BUDGET (200 is a sensible ceiling for this ' +
  'analysis). In Claude Desktop that is the extension setting "Credit budget per session"; the ' +
  'server picks it up after the extension restarts.';

const CONFIRM_HINT =
  'Ask the user to confirm this spend before calling again — do not decide on their behalf. If ' +
  'they agree, call modash_brand_crossover again with confirmCredits set to at least the ceiling ' +
  'above, and the same other arguments.';

/** `confirmCredits` is a tool-layer gate; the analysis functions never see it. */
type CrossoverArgs = CrossoverOptions & { confirmCredits?: number | undefined };

const planPayload = (plan: CrossoverPlan) => ({
  platform: plan.platform,
  window: plan.window,
  sampling: plan.sampling,
  brands: plan.brands,
  ...(plan.creatorFilter === undefined
    ? {}
    : {
        creatorFilter: Object.fromEntries(
          Object.entries(plan.creatorFilter).filter(([, value]) => value !== undefined),
        ),
      }),
  ceiling: plan.ceiling,
});

const caveatsFor = (plan: CrossoverPlan, truncated: boolean): string[] => [
  ...(plan.sampling.fullPull
    ? []
    : [
        `Only ${plan.sampling.weeksPulled} of ${plan.sampling.weeksInWindow} weeks were pulled. A ` +
          'creator who posted about the two brands in different weeks is missed, so absolute ' +
          'shares are low. The rival and baseline pairs are sampled the same way, so read the ' +
          'comparison, not the absolute numbers.',
      ]),
  ...(truncated
    ? [
        'Some brand-weeks had more posts than maxPagesPerWeek allows and were cut short. The API ' +
          'does not document the order posts come back in, so treat those weeks as a sample.',
      ]
    : []),
  'Counts are of posts Modash has classified as being about each brand (sponsored, gifted, ' +
    'affiliate, or an unclear mention), not of every post that names the brand.',
];

export function registerCrossoverTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'modash_plan_brand_crossover',
    {
      title: 'Plan a brand crossover analysis',
      description:
        'Free: costs no credits. Call this before modash_brand_crossover. Resolves the brands ' +
        '(showing alternatives when a domain or name matches more than one brand identity), lays ' +
        'out which weeks would be pulled, and works out the most the analysis could cost against ' +
        'the remaining session budget, with cheaper settings to offer the user if it does not fit. ' +
        'Takes exactly the same arguments as modash_brand_crossover.',
      inputSchema: z.object(inputShape),
      outputSchema: z.object({
        ...planShape,
        budget: z.object({ budget: z.number(), spent: z.number(), remaining: z.number() }),
        fits: z.boolean(),
        confirmThresholdCredits: z.number(),
        needsConfirmation: z.boolean(),
        cheaperOptions: z.array(z.object({ change: z.string(), ceilingCredits: z.number() })),
        notes: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const { confirmCredits: _ignored, ...options } = args as CrossoverArgs;
      const plan = await planCrossover(ctx.client, options);
      const remaining = ctx.ledger.remaining;
      const fits = plan.ceiling.totalCredits <= remaining;
      const needsConfirmation = plan.ceiling.totalCredits > CONFIRM_THRESHOLD_CREDITS;

      return respond({
        ...planPayload(plan),
        budget: { budget: ctx.ledger.budget, spent: ctx.ledger.spent, remaining },
        fits,
        confirmThresholdCredits: CONFIRM_THRESHOLD_CREDITS,
        needsConfirmation,
        cheaperOptions: cheaperOptions(options, plan.sampling.weeksInWindow, remaining),
        notes: [
          'The ceiling assumes every sampled week fills maxPagesPerWeek pages. Smaller brands ' +
            'stop early and empty weeks are free, so a real run usually costs less.',
          'Every week of a year is 53 weeks; at 10 pages a week that is 53 × 10 × 0.2 = 106 ' +
            'credits per brand. Sampling weeks is how to keep a first look cheap.',
          ...(plan.brands.some((brand) => brand.alternatives.length > 0)
            ? ['Some inputs matched several brand identities. Check the names; pass a brandId to pick another.']
            : []),
          ...(fits ? [] : [BUDGET_HINT]),
          ...(needsConfirmation && fits
            ? [
                `This is above the default ${CONFIRM_THRESHOLD_CREDITS}-credit confirmation limit. ` +
                  'modash_brand_crossover will refuse and ask for confirmCredits rather than run it ' +
                  'automatically — show this estimate to the user and ask before confirming.',
              ]
            : []),
        ],
      });
    }),
  );

  server.registerTool(
    'modash_brand_crossover',
    {
      title: 'Do creators pick a side between rival brands?',
      description:
        'Answers questions like "do creators who post about brand A also post about rival brand ' +
        'B?". Pulls the posts Modash has attributed to each brand over a time window, counts the ' +
        'creators who posted about both (the crossover) against those who posted about either ' +
        '(the base), and runs two unrelated brands the same way as a baseline. Optionally ' +
        'restricts the answer to creators in a location and/or above a follower count. Costs ' +
        'credits: 0.2 per page of 30 posts per brand-week, plus 0.025 per creator returned by ' +
        'the optional lookup. Before sending anything it works out the most the run could cost. ' +
        `Above ${CONFIRM_THRESHOLD_CREDITS} credits it refuses and asks for confirmCredits instead ` +
        'of running — show the user the estimate and get their explicit go-ahead before setting ' +
        'that argument yourself; do not confirm on the user\'s behalf. It also refuses outright, ' +
        'confirmed or not, if the estimate is above the remaining session budget. The defaults ' +
        `are a cheap sample over the last ${DEFAULT_WINDOW_DAYS} days (6 weeks, 3 pages a week); ` +
        'call modash_plan_brand_crossover first to see the cost and cheaper or fuller settings. ' +
        'A run can take a minute or more.',
      inputSchema: z.object(inputShape),
      outputSchema: withCost({
        ...planShape,
        brandPulls: z.array(
          z.object({
            name: z.string(),
            creators: z.number(),
            posts: z.number(),
            otherPlatformPostsSkipped: z.number(),
            pages: z.number(),
            weeksWithPosts: z.number(),
            truncatedWeeks: z.number(),
          }),
        ),
        rival: pairSchema,
        baseline: pairSchema.optional(),
        filtered: z.object({ rival: filteredSchema, baseline: filteredSchema.optional() }).optional(),
        comparison: z.object({
          rivalShare: z.number(),
          baselineShare: z.number().optional(),
          ratio: z.number().optional(),
          reading: z.string(),
        }),
        caveats: z.array(z.string()),
        cheaperOptions: z.array(z.object({ change: z.string(), ceilingCredits: z.number() })),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guard(async (args) => {
      const { confirmCredits, ...options } = args as CrossoverArgs;
      const plan = await planCrossover(ctx.client, options);
      const remaining = ctx.ledger.remaining;
      const ceiling = plan.ceiling.totalCredits;

      // The session budget is a hard ceiling. Nothing a caller sends, confirmed or not, moves it.
      if (ceiling > remaining) {
        const suggestions = cheaperOptions(options, plan.sampling.weeksInWindow, remaining)
          .filter((option) => option.ceilingCredits <= remaining)
          .map((option) => `  - ${option.change}: at most ${option.ceilingCredits} credits`)
          .join('\n');
        return problem(
          `Budget stop: this analysis could cost up to ${ceiling} credits ` +
            `(${plan.ceiling.postsCredits} for posts, ${plan.ceiling.lookupCredits} for lookups), ` +
            `but only ${remaining} of the ${ctx.ledger.budget}-credit session budget is left. ` +
            `No paid call was made.\n\n` +
            (suggestions ? `Settings that fit:\n${suggestions}` : 'No cheaper setting fits what is left.') +
            `\n\n${BUDGET_HINT}`,
        );
      }

      // A run that fits the budget but is still expensive needs a human's explicit go-ahead.
      if (ceiling > CONFIRM_THRESHOLD_CREDITS && (confirmCredits === undefined || confirmCredits < ceiling)) {
        const suggestions = cheaperOptions(options, plan.sampling.weeksInWindow, remaining)
          .filter((option) => option.ceilingCredits <= remaining)
          .map((option) => `  - ${option.change}: at most ${option.ceilingCredits} credits`)
          .join('\n');
        return problem(
          `Confirm before running: this analysis could cost up to ${ceiling} credits ` +
            `(${plan.ceiling.postsCredits} for posts, ${plan.ceiling.lookupCredits} for lookups), ` +
            `above the default ${CONFIRM_THRESHOLD_CREDITS}-credit limit for a single run. No ` +
            `paid call was made.\n\n${CONFIRM_HINT}\n\n` +
            (suggestions
              ? `Cheaper settings, if the user would rather not spend that much:\n${suggestions}`
              : ''),
        );
      }

      const { data, cost } = await priced(ctx.ledger, () => runCrossover(ctx.client, options, plan));
      const truncated = data.pulls.some((pull) => pull.truncatedWeeks > 0);

      return respond({
        ...planPayload(plan),
        brandPulls: data.pulls.map((pull) => ({
          name: pull.brand.name,
          creators: pull.creators.size,
          posts: pull.posts,
          otherPlatformPostsSkipped: pull.otherPlatformPosts,
          pages: pull.pages,
          weeksWithPosts: pull.weeksWithPosts,
          truncatedWeeks: pull.truncatedWeeks,
        })),
        rival: data.rival,
        ...(data.baseline ? { baseline: data.baseline } : {}),
        ...(data.filtered
          ? {
              filtered: {
                rival: data.filtered.rival,
                ...(data.filtered.baseline ? { baseline: data.filtered.baseline } : {}),
              },
            }
          : {}),
        comparison: Object.fromEntries(
          Object.entries(data.comparison).filter(([, value]) => value !== undefined),
        ) as { rivalShare: number; reading: string },
        caveats: [
          ...caveatsFor(plan, truncated),
          ...(data.filtered
            ? [
                'The location and follower filter comes from AI Search. A creator AI Search does ' +
                  'not return counts as not matching. The filtered base is estimated from a ' +
                  'random sample, scaled up.',
              ]
            : []),
        ],
        cheaperOptions: cheaperOptions(options, plan.sampling.weeksInWindow, ctx.ledger.remaining),
        cost,
      });
    }),
  );
}
