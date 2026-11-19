import { groupBy, uniq, uniqBy } from 'lodash-es';

import { isPlatform, type Platform } from './contacts.js';

/** One account that lists one email: from email search, or from a report the tool holds. */
export interface EmailListing {
  email: string;
  platform: Platform;
  userId: string;
}

/** The creator's account per platform, as far as the run has matched them. */
export type Matched = Partial<Record<Platform, { userId: string }>>;

/**
 * What the emails prove about one creator. An address belongs to more than one person when two accounts on one
 * platform list it, or when an account other than the creator's lists it on a platform where the creator is
 * matched. Such an address proves nothing. Every answer takes the matches known at the time it is asked.
 */
export class EmailEvidence {
  readonly #claimed = new Set<string>();
  /** What email search answered; undefined until it answers. */
  #searchHits: EmailListing[] | undefined;

  /** Emails on the starting report and on accounts confirmed both ways: the ones the creator puts their name to. */
  claim(emails: Iterable<string>): void {
    for (const email of emails) this.#claimed.add(email);
  }

  /** The claimed emails, in the order email search is asked for them. */
  get claimed(): string[] {
    return [...this.#claimed].sort();
  }

  /** Records what email search answered, or undefined when the call failed. */
  recordSearch(hits: EmailListing[] | undefined): void {
    this.#searchHits = hits;
  }

  shared(matched: Matched): Set<string> {
    const listedByOthers = (listings: EmailListing[]) =>
      Object.entries(groupBy(listings, 'platform')).some(([platform, group]) => {
        const listers = uniq(group.map((listing) => listing.userId));
        const own = isPlatform(platform) ? matched[platform]?.userId : undefined;
        return listers.length > 1 || (own !== undefined && listers[0] !== own);
      });
    return new Set(
      Object.entries(groupBy(this.#searchHits ?? [], 'email'))
        .filter(([, listings]) => listedByOthers(listings))
        .map(([email]) => email),
    );
  }

  /**
   * The claimed emails that confirm `candidate`: it lists them, and they stay unshared if it were the creator's
   * account. None when email search has not answered, since then nothing is known about who else lists them.
   */
  confirming(candidate: Platform, userId: string, listed: Iterable<string>, matched: Matched): string[] {
    if (this.#searchHits === undefined) return [];
    const shared = this.shared({ ...matched, [candidate]: { userId } });
    return [...listed].filter((email) => this.#claimed.has(email) && !shared.has(email)).sort();
  }

  /** The platforms whose matched account lists an unshared email that a matched account on another platform also lists. */
  agreeing(listings: EmailListing[], matched: Matched): Platform[] {
    const shared = this.shared(matched);
    const groups = Object.values(groupBy(listings.filter((listing) => !shared.has(listing.email)), 'email'));
    return uniq(
      groups.filter((group) => uniqBy(group, 'platform').length > 1).flatMap((group) => group.map((listing) => listing.platform)),
    );
  }
}
