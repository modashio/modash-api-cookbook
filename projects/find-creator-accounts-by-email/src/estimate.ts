import { EMAIL_MATCH_COST } from './modash/reads.js';
import { round2 } from './numbers.js';

interface Estimate {
  calls: number;
  /** What the list costs if every email matches. A list with no matches costs 0. */
  mostCredits: number;
  /** The balance one call needs before it is sent: 0.02 per email in it, matched or not. */
  balancePerCall: number;
}

export const estimate = (emailCount: number, batchSize: number): Estimate => ({
  calls: Math.ceil(emailCount / batchSize),
  mostCredits: round2(emailCount * EMAIL_MATCH_COST),
  balancePerCall: round2(Math.min(emailCount, batchSize) * EMAIL_MATCH_COST),
});

/** The most emails one call can hold under a budget. Works in hundredths of a credit to stay exact. */
export const emailsWithin = (budget: number): number => Math.floor(Math.floor(budget * 100 + 1e-9) / Math.round(EMAIL_MATCH_COST * 100));

interface Projection {
  matches: number;
  credits: number;
}

/** What the emails not yet checked would match and cost if they match at the sample's rate. */
export const projection = (matched: number, checked: number, remaining: number): Projection => {
  const matches = Math.round((matched / checked) * remaining);
  return { matches, credits: round2(matches * EMAIL_MATCH_COST) };
};
