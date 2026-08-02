/**
 * Starter briefs. Each one is chosen to exercise a different part of the API, so
 * clicking through them is a tour: dictionary lookups, cross-platform lookalikes,
 * the brands filter, view-count filtering, and the paid audience reports.
 *
 * None of them name a specific creator — a handle that exists in mock mode won't
 * exist against the live API, and a dead example is worse than no example.
 */
const EXAMPLES = [
  {
    title: 'Sleep supplement launch',
    summary: 'US market, mid-tier, contactable',
    prompt:
      "We're launching a magnesium sleep supplement in the US. Find Instagram creators who talk about evening routines and sleep quality, 20k–200k followers, engagement above 3%, and who publish a contact email.",
  },
  {
    title: 'Vet the audience, not the content',
    summary: 'Search, then pay for reports on the finalists',
    prompt:
      'Find Instagram creators posting about home fitness with 30k–150k followers, shortlist the three strongest, then pull audience reports and tell me which ones actually have a US audience and credible followers.',
  },
  {
    title: 'Expand to another platform',
    summary: 'Cross-platform lookalikes',
    prompt:
      'Find Instagram creators making specialty coffee and home espresso content, 25k–200k followers. Then take the best one and find me similar creators on TikTok.',
  },
  {
    title: 'German-market gut health',
    summary: 'Location and language dictionaries',
    prompt:
      'German-speaking creators posting about gut health and family nutrition, based in Germany. Mid-tier only, posting at least twice a month, and skip brand accounts.',
  },
  {
    title: "A competitor's creators",
    summary: 'Brand affinity filter',
    prompt:
      'Which Instagram creators have been posting about Gymshark recently? 50k–500k followers, fitness content, and I want to know who I could approach instead.',
  },
  {
    title: 'YouTube, proven reach',
    summary: 'Filter on median views, not followers',
    prompt:
      'Outdoor and hiking creators on YouTube whose recent videos show real camping trips rather than studio reviews. At least 50k median views per video — I care about views, not subscriber count.',
  },
  {
    title: 'Spend almost nothing',
    summary: 'Tight credit budget',
    prompt:
      'I have about half a credit to spend. Find me the five most promising Instagram creators for a reusable water bottle brand, 20k–100k followers, and do not run more than one search.',
  },
  {
    title: 'Beauty, but authentic',
    summary: 'Engagement and credibility screening',
    prompt:
      'Skincare creators on Instagram doing honest ingredient breakdowns rather than sponsored hauls, 40k–300k followers. Prioritise high engagement, then check the shortlist for fake followers.',
  },
];

export function EmptyState({ onPick, disabled }: { onPick: (prompt: string) => void; disabled: boolean }) {
  return (
    <div className="mx-auto mt-[4vh] max-w-[760px] pb-6">
      <h2 className="m-0 mb-2 text-[22px] tracking-[-0.02em]">Describe a brief, not a filter set.</h2>
      <p className="m-0 mb-6 text-text-dim">
        The agent decides which{' '}
        <a href="https://docs.modash.io/products/discovery_api/openapi_doc/discovery/ai-search">AI Search</a> queries
        and filters to run, resolves location and language IDs against the dictionary endpoints, reads the results, and
        refines. Every paid call is metered against a per-session credit budget.
      </p>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2.5">
        {EXAMPLES.map((example) => (
          <button
            key={example.title}
            type="button"
            className="flex flex-col gap-1 rounded-md border border-border-soft bg-bg-card px-4 py-3 text-left transition-[border-color,transform] hover:-translate-y-px hover:border-accent disabled:cursor-default disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:border-border-soft"
            onClick={() => onPick(example.prompt)}
            disabled={disabled}
            title={example.prompt}
          >
            <span className="text-[13px] font-semibold text-text">{example.title}</span>
            <span className="text-[11.5px] text-text-faint">{example.summary}</span>
          </button>
        ))}
      </div>

      <p className="mt-5 mb-0 text-[11.5px] text-text-faint">
        Or write your own. Vague is fine — the agent will state the assumptions it makes.
      </p>
    </div>
  );
}
