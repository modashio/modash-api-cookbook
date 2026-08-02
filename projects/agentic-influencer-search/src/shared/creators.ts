/**
 * Types shared between the Express server and the React app.
 *
 * These are deliberately *not* the raw Modash response shapes. The server
 * normalises Modash profiles into `Creator` once, so the UI has one shape to
 * render regardless of platform (Instagram reports `playsCount` on posts,
 * YouTube reports `viewsCount`, and only lookalikes echo a profile `url`).
 */

export type Platform = 'instagram' | 'tiktok' | 'youtube';

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

export interface CreatorPost {
  url?: string;
  thumbnail?: string;
  likes?: number;
  comments?: number;
  views?: number;
}

export interface Creator {
  platform: Platform;
  userId?: string;
  username: string;
  fullName?: string;
  profilePicture?: string;
  profileUrl: string;
  followers?: number;
  /** Fraction, e.g. 0.032 for 3.2%. */
  engagementRate?: number;
  postsPerMonth?: number;
  medianViews?: number;
  accountCategory?: string;
  /** Posts the semantic search matched on, most relevant first. */
  matchedPosts: CreatorPost[];
}

/** A slice of a full profile report — the audience data you buy for 1 credit. */
export interface AudienceReport {
  platform: Platform;
  username: string;
  /** Inverse of fake-follower share: 0.75 means roughly 25% look inauthentic. */
  credibility?: number;
  followers?: number;
  engagementRate?: number;
  /** Ordered by weight, largest first. Weights are fractions of the audience. */
  topCountries: Array<{ label: string; weight: number }>;
  genders: Array<{ label: string; weight: number }>;
  ageBrackets: Array<{ label: string; weight: number }>;
  /** Public contact details from the bio, e.g. an outreach email. */
  contacts: Array<{ type: string; value: string }>;
}

export function profileUrl(platform: Platform, username: string): string {
  switch (platform) {
    case 'instagram':
      return `https://www.instagram.com/${username}/`;
    case 'tiktok':
      return `https://www.tiktok.com/@${username}`;
    case 'youtube':
      return `https://www.youtube.com/@${username}`;
  }
}
