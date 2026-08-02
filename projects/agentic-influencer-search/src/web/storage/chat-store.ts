/**
 * Saved conversations, in localStorage.
 *
 * Shortlists are not stored separately: they live in the message history as
 * `data-shortlist` parts, so persisting the messages persists the shortlist too,
 * and there is only one thing that can go stale.
 *
 * Two things make this more than a JSON.stringify wrapper:
 *
 *  - **Quota.** Transcripts carry creator avatars and post thumbnails, and in
 *    mock mode those are inline data URIs. A few searches will pass 5MB. Writes
 *    evict the oldest conversations and retry rather than throwing.
 *  - **Versioning.** The stored shape is tied to `ChatMessage`, which changes
 *    whenever a data part is added. A version stamp means an old payload is
 *    dropped cleanly instead of crashing the app on load.
 */

import type { VerdictMap } from '../../shared/feedback';
import type { ChatMessage } from '../../shared/messages';

const STORAGE_KEY = 'modash-cookbook.chats';

/** Bump when the persisted shape changes; anything older is discarded on read. */
const STORAGE_VERSION = 1;

/** Enough for a few campaigns' worth of history without hogging the origin's quota. */
const MAX_CHATS = 20;

export interface SavedChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** Optional: chats saved before verdicts existed simply have none. */
  verdicts?: VerdictMap;
}

interface StoredPayload {
  version: number;
  chats: SavedChat[];
}

function storage(): Storage | undefined {
  // Absent during server-side rendering, and throws outright when cookies are
  // blocked, so every access is guarded rather than feature-detected once.
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadChats(): SavedChat[] {
  const store = storage();
  if (!store) return [];

  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as StoredPayload;
    if (parsed?.version !== STORAGE_VERSION || !Array.isArray(parsed.chats)) {
      store.removeItem(STORAGE_KEY);
      return [];
    }

    return parsed.chats
      .filter((chat) => typeof chat?.id === 'string' && Array.isArray(chat.messages))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    // Corrupt payload is not worth recovering; a lost transcript beats a blank app.
    store.removeItem(STORAGE_KEY);
    return [];
  }
}

/**
 * Returns the chats actually written, which may be fewer than asked for when the
 * quota forces eviction. Callers should adopt the return value as their state so
 * the UI never lists a conversation that is no longer on disk.
 */
export function saveChats(chats: SavedChat[]): SavedChat[] {
  const store = storage();
  if (!store) return chats;

  let candidates = [...chats].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS);

  while (candidates.length > 0) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, chats: candidates }));
      return candidates;
    } catch {
      // Almost certainly QuotaExceededError. Drop the oldest and try again.
      candidates = candidates.slice(0, -1);
    }
  }

  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Nothing further to do; the app still works, it just won't remember.
  }
  return [];
}

export function createChat(): SavedChat {
  const now = Date.now();
  return { id: crypto.randomUUID(), title: 'New search', createdAt: now, updatedAt: now, messages: [], verdicts: {} };
}

/** First user message, trimmed to something that fits a sidebar row. */
export function titleFor(messages: ChatMessage[], fallback: string): string {
  const firstUserText = messages
    .find((message) => message.role === 'user')
    ?.parts.find((part) => part.type === 'text')?.text;

  if (!firstUserText) return fallback;

  const oneLine = firstUserText.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

/** How many creators the chat's latest shortlist holds, for the sidebar badge. */
export function shortlistSize(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (part?.type === 'data-shortlist') return part.data.entries.length;
    }
  }
  return 0;
}
