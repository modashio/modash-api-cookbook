import { useCallback, useEffect, useRef, useState } from 'react';
import type { VerdictMap } from '../../shared/feedback';
import type { ChatMessage } from '../../shared/messages';
import { createChat, loadChats, saveChats, titleFor, type SavedChat } from './chat-store';

export interface SavedChatsApi {
  chats: SavedChat[];
  activeId: string;
  activeChat: SavedChat | undefined;
  /** True once localStorage has been read, so the UI doesn't flash an empty list. */
  ready: boolean;
  select: (id: string) => void;
  startNew: () => void;
  remove: (id: string) => void;
  /** Called by the conversation when a turn settles. */
  persistMessages: (id: string, messages: ChatMessage[]) => void;
  persistVerdicts: (id: string, update: (current: VerdictMap) => VerdictMap) => void;
}

/**
 * Good enough to tell "same transcript" from "a turn happened": messages are
 * append-only within a chat, and the last one grows parts as it streams.
 */
function isSameHistory(a: ChatMessage[], b: ChatMessage[]): boolean {
  return (
    a.length === b.length &&
    a.at(-1)?.id === b.at(-1)?.id &&
    (a.at(-1)?.parts.length ?? 0) === (b.at(-1)?.parts.length ?? 0)
  );
}

export function useSavedChats(): SavedChatsApi {
  const [chats, setChats] = useState<SavedChat[]>([]);
  const [activeId, setActiveId] = useState('');
  const [ready, setReady] = useState(false);

  /**
   * Mutations read the list from here rather than from `chats`.
   *
   * React state is a snapshot per render, so two mutations in the same tick — two
   * verdict buttons clicked in quick succession, say — would both start from the
   * same value and the second would silently discard the first. The ref is updated
   * synchronously on every write, so each mutation builds on the last.
   */
  const chatsRef = useRef<SavedChat[]>([]);

  // localStorage is only touched in an effect so the module stays safe to import
  // from a server-side render.
  useEffect(() => {
    const stored = loadChats();
    const initial = stored.length > 0 ? stored : [createChat()];
    chatsRef.current = initial;
    setChats(initial);
    setActiveId(initial[0]!.id);
    setReady(true);
  }, []);

  /**
   * Never do this work inside a `setChats` updater: React re-runs updaters, and
   * `createChat()` and `saveChats()` are both side effects.
   *
   * `saveChats` returns what it managed to write, which may be less than it was
   * given once the quota bites, so that — not the requested list — becomes state.
   */
  const commit = useCallback((next: SavedChat[]): SavedChat[] => {
    const written = saveChats(next);
    chatsRef.current = written;
    setChats(written);
    return written;
  }, []);

  const persistMessages = useCallback(
    (id: string, messages: ChatMessage[]) => {
      const existing = chatsRef.current.find((chat) => chat.id === id);
      if (!existing) return;

      // Restoring a saved chat settles immediately, which would otherwise write it
      // straight back and bump `updatedAt` — reordering the sidebar by last viewed
      // rather than last changed.
      if (isSameHistory(existing.messages, messages)) return;

      commit(
        chatsRef.current.map((chat) =>
          chat.id === id
            ? { ...chat, messages, title: titleFor(messages, chat.title), updatedAt: Date.now() }
            : chat,
        ),
      );
    },
    [commit],
  );

  const persistVerdicts = useCallback(
    (id: string, update: (current: VerdictMap) => VerdictMap) => {
      const existing = chatsRef.current.find((chat) => chat.id === id);
      if (!existing) return;

      // A verdict is a preference, not activity, so it doesn't touch `updatedAt`.
      commit(
        chatsRef.current.map((chat) =>
          chat.id === id ? { ...chat, verdicts: update(chat.verdicts ?? {}) } : chat,
        ),
      );
    },
    [commit],
  );

  const startNew = useCallback(() => {
    // Reuse an untouched blank rather than stacking up empties.
    const blank = chatsRef.current.find((chat) => chat.messages.length === 0);
    if (blank) {
      setActiveId(blank.id);
      return;
    }

    const chat = createChat();
    commit([chat, ...chatsRef.current]);
    setActiveId(chat.id);
  }, [commit]);

  const remove = useCallback(
    (id: string) => {
      const remaining = chatsRef.current.filter((chat) => chat.id !== id);
      const written = commit(remaining.length > 0 ? remaining : [createChat()]);
      setActiveId((current) => (current === id ? (written[0]?.id ?? '') : current));
    },
    [commit],
  );

  return {
    chats,
    activeId,
    activeChat: chats.find((chat) => chat.id === activeId),
    ready,
    select: setActiveId,
    startNew,
    remove,
    persistMessages,
    persistVerdicts,
  };
}
