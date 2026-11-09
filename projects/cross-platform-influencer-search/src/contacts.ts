import type { ReportProfile, UserRow } from './modash/responses.js';

export const PLATFORMS = ['instagram', 'tiktok', 'youtube'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const isPlatform = (value: string): value is Platform => (PLATFORMS as readonly string[]).includes(value);

const HANDLE_OK: Record<Platform, RegExp> = {
  instagram: /^[A-Za-z0-9._]{1,30}$/,
  tiktok: /^[A-Za-z0-9._]{2,24}$/,
  youtube: /^[\p{L}\p{N}_.-]{3,30}$/u,
};

const OWN_SITE: Record<Platform, RegExp> = {
  instagram: /^(www\.|m\.)?instagram\.com$/i,
  tiktok: /^(www\.|m\.)?tiktok\.com$/i,
  youtube: /^(www\.|m\.)?youtube\.com$/i,
};

const NOT_A_PROFILE = new Set([
  'p', 'reel', 'reels', 'stories', 'explore', 'tv', 'watch', 'shorts', 'playlist', 'results',
  'channel', 'share', 'video', 'tag', 'music', 'discover', 'accounts', 'direct', '_u', 'about',
]);

/** A profile link that carries an account id the report endpoint takes, so no lookup is needed. */
export function idFrom(platform: Platform, value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match =
    platform === 'youtube'
      ? /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{20,})/i.exec(value)
      : platform === 'tiktok'
        ? /tiktok\.com\/share\/user\/(\d+)/i.exec(value)
        : null;
  return match?.[1];
}

/** The handle in a contact, or undefined when it carries an id, points elsewhere, or is a post or tab. */
export function handleFrom(platform: Platform, value: string | null | undefined): string | undefined {
  if (!value || idFrom(platform, value)) return undefined;
  const trimmed = value.trim();
  const hadScheme = /^https?:\/\//i.test(trimmed);
  const path = trimmed.replace(/^https?:\/\//i, '').split(/[?#]/)[0] ?? '';
  let parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return undefined;

  const ownSite = OWN_SITE[platform];
  // A bare value like john.doe is a handle; anything with a scheme or a path after a dotted host is a URL.
  if (ownSite.test(parts[0]!) || hadScheme || (parts.length > 1 && parts[0]!.includes('.'))) {
    if (!ownSite.test(parts[0]!)) return undefined;
    parts = parts.slice(1);
    if (platform === 'youtube' && parts.length > 1 && ['c', 'user'].includes(parts[0]!.toLowerCase())) {
      parts = parts.slice(1);
    }
  } else if (parts.length > 1) {
    return undefined;
  }

  const first = parts[0];
  if (!first || NOT_A_PROFILE.has(first.toLowerCase())) return undefined;
  const handle = first.startsWith('@') ? first.slice(1) : first;
  if (!HANDLE_OK[platform].test(handle) || !/[\p{L}\p{N}]/u.test(handle)) return undefined;
  return handle;
}

/** YouTube rows carry the current handle in `handle`; `username` there can be an older name. */
export function nameOf(row: UserRow | null | undefined): string | null {
  const name = (row?.handle || row?.username || '').replace(/^@/, '');
  return name || null;
}

export function namesOf(row: UserRow | null | undefined): Set<string> {
  const names = new Set<string>();
  if (row?.username) names.add(row.username.toLowerCase());
  if (row?.handle) names.add(row.handle.replace(/^@/, '').toLowerCase());
  return names;
}

export function emailsIn(report: ReportProfile | null | undefined): Set<string> {
  const emails = new Set<string>();
  for (const contact of report?.contacts ?? []) {
    if (contact.type === 'email' && contact.value) emails.add(contact.value.trim().toLowerCase());
  }
  return emails;
}
