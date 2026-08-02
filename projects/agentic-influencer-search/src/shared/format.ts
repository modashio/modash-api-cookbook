export function formatCount(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—';
  if (value < 0) return 'hidden';
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trim(value / 1_000)}K`;
  return String(value);
}

/**
 * Engagement rates are usually a few percent, but the API does return the odd
 * viral outlier in the thousands — real data, not a bug. Drop the decimal once
 * the number is big enough that it stops being useful.
 */
export function formatPercent(fraction: number | undefined, digits?: number): string {
  if (fraction === undefined || Number.isNaN(fraction)) return '—';
  const percent = fraction * 100;
  return `${percent.toFixed(digits ?? (Math.abs(percent) < 10 ? 1 : 0))}%`;
}

export function formatCredits(credits: number): string {
  return credits.toFixed(3).replace(/\.?0+$/, '');
}

function trim(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}
