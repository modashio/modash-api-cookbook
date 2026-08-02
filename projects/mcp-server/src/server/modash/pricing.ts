/**
 * What each Discovery endpoint costs, in credits.
 *
 * Every number here is quoted from the endpoint's own description in the API reference
 * (https://docs.modash.io). They are duplicated in code rather than looked up at runtime because
 * the whole point of the budget guard is to know the cost *before* making the request.
 *
 * The important distinction is per-request versus per-result. Search endpoints bill per profile
 * they hand back, so their cost is a function of page size, not of how many results you end up
 * using.
 */

/** Credits are fractional floats. Round so a ledger never reads `0.30000000000000004`. */
export const roundCredits = (credits: number): number => Math.round(credits * 1e6) / 1e6;

/** Regular search returns a fixed 15 results per page and there is no way to ask for fewer. */
export const SEARCH_RESULTS_PER_PAGE = 15;

export const CREDITS = {
  /** 0.01 credits per search result, 15 results per page. */
  searchPerResult: 0.01,
  /** 1 credit per successful report request. The most expensive routine call in the API. */
  report: 1,
  /** 1 credit per audience overlap request, regardless of how many creators you compare. */
  audienceOverlap: 1,
  /** 0.2 credits per collaborations request. */
  collaborations: 0.2,
  /** 0.02 credits per *matched* email. We budget against submitted emails, which is the ceiling. */
  emailSearchPerEmail: 0.02,
  /** 0.025 credits per profile returned by any AI Search or lookalikes call. */
  aiSearchPerProfile: 0.025,
} as const;

export const searchCost = (): number =>
  roundCredits(CREDITS.searchPerResult * SEARCH_RESULTS_PER_PAGE);

/**
 * AI Search bills per returned profile, so `pageSize` is the whole cost story. At the maximum
 * pageSize of 50 a single AI search costs 1.25 credits, more than a full profile report.
 */
export const aiSearchCost = (pageSize: number): number =>
  roundCredits(CREDITS.aiSearchPerProfile * pageSize);

/**
 * Worst case: every submitted email matches. Modash only bills matches, but it also refuses the
 * request unless the balance covers every email you submitted, so this is the number to budget.
 */
export const emailSearchCost = (emailCount: number): number =>
  roundCredits(CREDITS.emailSearchPerEmail * emailCount);
