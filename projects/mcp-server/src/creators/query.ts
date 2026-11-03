import type { CreatorRow } from './dataset.js';

export const MAX_ROWS = 5;

export const SORT_COLUMNS = [
  'max_followers',
  'total_views_sep26',
  'total_likes_sep26',
  'total_posts_sep26',
] as const;

export type SortColumn = (typeof SORT_COLUMNS)[number];

export const PLATFORMS = ['instagram', 'tiktok', 'youtube'] as const;

export type CreatorPlatform = (typeof PLATFORMS)[number];

export interface CreatorFilters {
  country?: string | undefined;
  audience_country?: string | undefined;
  platform?: CreatorPlatform | undefined;
  min_followers?: number | undefined;
  has_email?: boolean | undefined;
  min_platforms?: number | undefined;
  sort_by?: SortColumn | undefined;
  limit?: number | undefined;
}

export const NOTE =
  'Sep-2026 sums (columns ending _sep26) count posts dated in September 2026 and are lower ' +
  'bounds. has_email means Modash holds an email for the creator; the address itself is not in ' +
  `the dataset. At most ${MAX_ROWS} rows are returned per call.`;

const text = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase() : '');

const normalise = (value: string): string => value.trim().toLowerCase();

const HANDLE_COLUMNS = ['ig_handle', 'tt_handle', 'yt_handle'] as const;

const stripAt = (value: string): string => normalise(value).replace(/^@/, '');

export function lookupCreators(rows: readonly CreatorRow[], query: string): CreatorRow[] {
  const needle = normalise(query);
  const handle = stripAt(query);

  const byHandle = rows.filter((row) =>
    HANDLE_COLUMNS.some((column) => text(row[column]).replace(/^@/, '') === handle),
  );
  const byExactName = rows.filter((row) => text(row.name) === needle);
  const byNameContains = rows.filter((row) => text(row.name).includes(needle));

  const seen = new Set<CreatorRow>();
  const ordered: CreatorRow[] = [];
  for (const row of [...byHandle, ...byExactName, ...byNameContains]) {
    if (seen.has(row)) continue;
    seen.add(row);
    ordered.push(row);
  }

  return ordered.slice(0, MAX_ROWS);
}

const PLATFORM_COLUMNS = {
  instagram: ['ig_handle', 'ig_followers'],
  tiktok: ['tt_handle', 'tt_followers'],
  youtube: ['yt_handle', 'yt_followers'],
} as const;

const hasPlatform = (row: CreatorRow, platform: CreatorPlatform): boolean =>
  PLATFORM_COLUMNS[platform].some((column) => row[column] !== null);

export function hasAnyFilter(filters: CreatorFilters): boolean {
  return (
    filters.country !== undefined ||
    filters.audience_country !== undefined ||
    filters.platform !== undefined ||
    filters.min_followers !== undefined ||
    filters.has_email !== undefined ||
    filters.min_platforms !== undefined
  );
}

function matches(row: CreatorRow, filters: CreatorFilters): boolean {
  if (filters.country !== undefined) {
    const country = normalise(filters.country);
    if (text(row.creator_country) !== country && text(row.creator_country_code) !== country) {
      return false;
    }
  }

  if (filters.audience_country !== undefined) {
    const country = normalise(filters.audience_country);
    if (
      text(row.audience_top_country) !== country &&
      text(row.audience_top_country_code) !== country
    ) {
      return false;
    }
  }

  if (filters.platform !== undefined && !hasPlatform(row, filters.platform)) return false;

  if (filters.min_followers !== undefined) {
    if (typeof row.max_followers !== 'number' || row.max_followers < filters.min_followers) {
      return false;
    }
  }

  if (filters.has_email !== undefined && row.has_email !== filters.has_email) return false;

  if (filters.min_platforms !== undefined) {
    if (typeof row.n_platforms !== 'number' || row.n_platforms < filters.min_platforms) {
      return false;
    }
  }

  return true;
}

export function searchCreators(
  rows: readonly CreatorRow[],
  filters: CreatorFilters,
): { rows: CreatorRow[]; moreMatchesExist: boolean } {
  const sortBy = filters.sort_by ?? 'max_followers';
  const limit = Math.min(filters.limit ?? MAX_ROWS, MAX_ROWS);

  const value = (row: CreatorRow): number => {
    const cell = row[sortBy];
    return typeof cell === 'number' ? cell : Number.NEGATIVE_INFINITY;
  };

  const matched = rows.filter((row) => matches(row, filters)).sort((a, b) => value(b) - value(a));

  return { rows: matched.slice(0, limit), moreMatchesExist: matched.length > limit };
}
