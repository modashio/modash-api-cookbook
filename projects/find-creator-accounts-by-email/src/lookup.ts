import { chunk, countBy, groupBy, mapValues, uniqBy } from 'lodash-es';

import { type CreditBudgetExceededError, ModashApiError, NoAnswerError, stopsTheRun } from './modash/errors.js';
import type { MatchedEmail, ModashReads } from './modash/reads.js';
import type { ResultsFile } from './results.js';

const PLATFORMS = ['instagram', 'tiktok', 'youtube'] as const;
type Platform = (typeof PLATFORMS)[number];
const isPlatform = (value: string): value is Platform => (PLATFORMS as readonly string[]).includes(value);

export interface Account {
  platform: Platform;
  userId: string | null;
  username: string | null;
  url: string | null;
  followers: number | null;
  isVerified: boolean | null;
}

/** What the lookup knows about one email. */
export interface EmailResult {
  email: string;
  /** The accounts that list the email. Empty when no creator account lists it. */
  accounts: Account[];
  /** Why a person should look before the match is stored, or null when there is no reason. */
  review: string | null;
}

interface LookupOptions {
  emails: string[];
  reads: ModashReads;
  /** Emails per API call. */
  batchSize: number;
  results: ResultsFile;
  onBatch?: (results: EmailResult[]) => void;
}

export interface LookupOutcome {
  /** Emails already in the results file, so not sent again. */
  skipped: number;
  checked: number;
  matched: number;
  toReview: number;
  /** Emails that were not sent, or whose call failed. A rerun sends them. */
  notChecked: number;
  /** Matched emails the API returned that were not in the call. They are charged, and no result can be written for them. */
  notInCall: number;
  errors: string[];
  stoppedBy?: CreditBudgetExceededError | ModashApiError;
}

/** Checks the emails in list order, one call per batch, and records each batch as its answer comes back. */
export async function lookUp({ emails, reads, batchSize, results, onBatch }: LookupOptions): Promise<LookupOutcome> {
  const todo = emails.filter((email) => !results.checked.has(email));
  const outcome: LookupOutcome = { skipped: emails.length - todo.length, checked: 0, matched: 0, toReview: 0, notChecked: 0, notInCall: 0, errors: [] };

  for (const batch of chunk(todo, batchSize)) {
    let found: Record<string, Account[]>;
    try {
      found = accountsByEmail(await reads.searchEmails(batch));
    } catch (error) {
      if (stopsTheRun(error)) {
        return { ...outcome, notChecked: todo.length - outcome.checked, stoppedBy: error };
      }
      if (!(error instanceof ModashApiError) && !(error instanceof NoAnswerError)) {
        throw error;
      }
      outcome.notChecked += batch.length;
      outcome.errors.push(error.message);
      continue;
    }
    const batchResults = batch.map((email) => resultOf(email, found[email]));
    results.record(batchResults);
    onBatch?.(batchResults);
    outcome.checked += batchResults.length;
    outcome.matched += batchResults.filter(isMatch).length;
    outcome.toReview += batchResults.filter((result) => result.review !== null).length;
    outcome.notInCall += Object.keys(found).filter((email) => !batch.includes(email)).length;
  }
  return outcome;
}

/** The API matched the email. Its accounts can still be empty: see `reviewOf`. */
export const isMatch = (result: EmailResult): boolean => result.accounts.length > 0 || result.review !== null;

/** The accounts email search returned, by email in lower case. Accounts on another platform are dropped. */
export const accountsByEmail = (matches: MatchedEmail[]): Record<string, Account[]> =>
  mapValues(
    groupBy(
      matches.filter((match) => match.email?.trim()),
      (match) => match.email!.trim().toLowerCase(),
    ),
    (group) =>
      uniqBy(
        group.flatMap((match) => (match.users ?? []).flatMap(accountOf)),
        (account) => `${account.platform}:${account.userId ?? account.username ?? account.url}`,
      ),
  );

function accountOf({ platform, userId, username, url, followers, isVerified }: NonNullable<MatchedEmail['users']>[number]): Account[] {
  const name = platform?.toLowerCase();
  if (!name || !isPlatform(name)) {
    return [];
  }
  return [{ platform: name, userId: userId ?? null, username: username ?? null, url: url ?? null, followers: followers ?? null, isVerified: isVerified ?? null }];
}

/** `accounts` is undefined when the API did not match the email. */
const resultOf = (email: string, accounts: Account[] | undefined): EmailResult => ({
  email,
  accounts: accounts ?? [],
  review: accounts === undefined ? null : reviewOf(accounts),
});

/** Why a person should look at a matched email's accounts before they are stored, or null. */
export function reviewOf(accounts: Account[]): string | null {
  if (accounts.length === 0) {
    return 'the API matched this email, but returned no Instagram, TikTok or YouTube account for it';
  }
  // When two accounts on one platform list the email, the email alone cannot say which account is the customer's.
  const shared = Object.entries(countBy(accounts, 'platform'))
    .filter(([, count]) => count > 1)
    .map(([platform, count]) => `${count} ${platform} accounts`);
  return shared.length > 0 ? `${shared.join(' and ')} list this email` : null;
}
