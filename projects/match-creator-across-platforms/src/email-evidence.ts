import { groupBy, partition, uniq, uniqBy } from 'lodash-es';

import { emailsIn, isPlatform, PLATFORMS, type Platform } from './contacts.js';
import type { Candidate } from './creator-match.js';
import type { EmailSearchHit } from './modash/reads.js';
import type { ReportProfile } from './modash/responses.js';

/** One account that lists one email: from email search, or from a report the tool holds. */
export interface EmailListing {
  email: string;
  platform: Platform;
  userId: string;
}

/** The creator's account per platform, as far as the run has matched them. */
export type Matched = Partial<Record<Platform, { userId: string }>>;

/** What email search says about one account: a match to accept, or a candidate to check by hand. */
export interface EmailVerdict {
  accept: boolean;
  candidate: Candidate;
}

/**
 * What the claimed emails prove. An address belongs to more than one person when two accounts on one platform list
 * it, or when an account other than the creator's lists it on a platform where the creator is matched. Such an address
 * proves nothing. Every answer takes the matches known at the time it is asked.
 */
export interface EmailEvidence {
  /** One account per platform across the emails is a match; a shared address or a conflict gives candidates. */
  readonly verdicts: EmailVerdict[];
  /**
   * The claimed emails that confirm `candidate`: it lists them, and they stay unshared if it were the creator's
   * account. None when email search did not answer, since then nothing is known about who else lists them.
   */
  confirming(matched: Matched, candidate: Platform, userId: string, listed: Iterable<string>): string[];
  /** An email that matched accounts on two platforms both list, and no other account is known to list, is a second piece of evidence for both. */
  agreeing(matched: Matched, heldReport: (platform: Platform, userId: string) => ReportProfile | undefined): Platform[];
}

const sharedIn = (hits: EmailListing[], matched: Matched): Set<string> => {
  const listedByOthers = (listings: EmailListing[]) =>
    Object.entries(groupBy(listings, 'platform')).some(([platform, group]) => {
      const listers = uniq(group.map((listing) => listing.userId));
      const own = isPlatform(platform) ? matched[platform]?.userId : undefined;
      return listers.length > 1 || (own !== undefined && listers[0] !== own);
    });
  return new Set(
    Object.entries(groupBy(hits, 'email'))
      .filter(([, listings]) => listedByOthers(listings))
      .map(([email]) => email),
  );
};

const verdictsOf = (hits: EmailSearchHit[], matched: Matched, missing: Platform[]): EmailVerdict[] => {
  const shared = sharedIn(hits, matched);
  const [sharedHits, ownHits] = partition(hits, (hit) => shared.has(hit.email));
  const byPlatform = groupBy(
    ownHits.filter((hit) => missing.includes(hit.platform)),
    'platform',
  );
  const ownVerdicts = Object.values(byPlatform).flatMap((group): EmailVerdict[] => {
    const [first] = group;
    if (first && uniqBy(group, 'userId').length === 1) {
      const { email, ...hit } = first;
      return [{ accept: true, candidate: { ...hit, how: `email (${email})` } }];
    }
    return group.map(({ email, ...hit }) => ({
      accept: false,
      candidate: { ...hit, how: `email (${email}), another email names a different account` },
    }));
  });
  const acceptedPlatforms = new Set(ownVerdicts.filter((verdict) => verdict.accept).map((verdict) => verdict.candidate.platform));
  const sharedVerdicts = sharedHits
    .filter((hit) => !matched[hit.platform] && !acceptedPlatforms.has(hit.platform))
    .map(({ email, ...hit }) => ({ accept: false, candidate: { ...hit, how: `email (${email}), shared by several accounts` } }));
  return [...ownVerdicts, ...sharedVerdicts];
};

const listingsOfMatched = (
  matched: Matched,
  heldReport: (platform: Platform, userId: string) => ReportProfile | undefined,
): EmailListing[] =>
  PLATFORMS.flatMap((platform) => {
    const account = matched[platform];
    const report = account && heldReport(platform, account.userId);
    return report ? [...emailsIn(report)].map((email) => ({ email, platform, userId: account.userId })) : [];
  });

/**
 * Searches the claimed emails: the ones on the starting report and on accounts confirmed both ways, which the creator
 * puts their name to. Searches only when a platform is still missing; `search` returns undefined when the call failed.
 */
export const searchEmailEvidence = async (
  claimed: Iterable<string>,
  matched: Matched,
  search: (emails: string[]) => Promise<EmailSearchHit[] | undefined>,
): Promise<EmailEvidence> => {
  const claimedEmails = new Set(claimed);
  const emails = [...claimedEmails].sort();
  const missing = PLATFORMS.filter((platform) => !matched[platform]);
  const hits = missing.length > 0 && emails.length > 0 ? await search(emails) : undefined;
  return {
    verdicts: verdictsOf(hits ?? [], matched, missing),
    confirming: (now, candidate, userId, listed) => {
      if (hits === undefined) return [];
      const shared = sharedIn(hits, { ...now, [candidate]: { userId } });
      return [...listed].filter((email) => claimedEmails.has(email) && !shared.has(email)).sort();
    },
    agreeing: (now, heldReport) => {
      const shared = sharedIn(hits ?? [], now);
      const listings = listingsOfMatched(now, heldReport).filter((listing) => !shared.has(listing.email));
      const groups = Object.values(groupBy(listings, 'email'));
      return uniq(
        groups.filter((group) => uniqBy(group, 'platform').length > 1).flatMap((group) => group.map((listing) => listing.platform)),
      );
    },
  };
};
