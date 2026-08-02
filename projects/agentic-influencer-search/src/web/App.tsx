import { useCallback, useRef, useState } from 'react';
import type { VerdictMap } from '../shared/feedback';
import type { ChatMessage, ShortlistEntry, UsageDataPart } from '../shared/messages';
import { ChatList } from './components/ChatList';
import { Conversation } from './components/Conversation';
import { CreditMeter } from './components/CreditMeter';
import { Notices, type Notice } from './components/Notices';
import { ShortlistPanel } from './components/ShortlistPanel';
import { CreatorFeedbackProvider } from './feedback';
import { useServerConfig } from './queries/server-config';
import { useSavedChats } from './storage/use-saved-chats';

/** Below this the sidebars stop fitting and the shortlist becomes a drawer. */
const WIDE = '(min-width: 1081px)';

export function App() {
  const { data: serverConfig } = useServerConfig();
  const savedChats = useSavedChats();
  const [streamedUsage, setStreamedUsage] = useState<UsageDataPart | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [shortlist, setShortlist] = useState<ShortlistEntry[]>([]);
  const [shortlistOpen, setShortlistOpen] = useState(
    () => typeof matchMedia === 'undefined' || matchMedia(WIDE).matches,
  );
  // Only meaningful below 1081px; above it the list is always a docked column.
  const [chatsOpen, setChatsOpen] = useState(false);
  const noticeId = useRef(0);

  // Seed the meter from /api/config before the first message so the mock badge
  // and budget are visible immediately; streamed data-usage parts take over after.
  const usage: UsageDataPart | null =
    streamedUsage ??
    (serverConfig
      ? {
          creditsSpent: 0,
          creditsBudget: serverConfig.creditBudget,
          paidCalls: 0,
          mock: serverConfig.mock,
        }
      : null);

  const dismissNotice = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const pushNotice = useCallback((notice: { level: Notice['level']; message: string }) => {
    const id = ++noticeId.current;
    setNotices((current) => [...current, { id, ...notice }]);
  }, []);

  const { activeId, activeChat } = savedChats;
  const persistMessages = savedChats.persistMessages;

  const persistVerdicts = savedChats.persistVerdicts;
  const handleVerdicts = useCallback(
    (update: (current: VerdictMap) => VerdictMap) => persistVerdicts(activeId, update),
    [persistVerdicts, activeId],
  );

  const handleSettled = useCallback(
    (messages: ChatMessage[]) => persistMessages(activeId, messages),
    [persistMessages, activeId],
  );

  /**
   * Anything derived from the active conversation has to be dropped when that
   * conversation changes, not just when one is picked from the list. Credit spend
   * is per request on the server, and the shortlist is re-reported by the
   * remounted `Conversation` a render later — without this the header keeps the
   * previous chat's totals until that lands.
   */
  const resetConversationState = useCallback(() => {
    setStreamedUsage(null);
    setShortlist([]);
  }, []);

  /*
   * Reset only when the active conversation actually changes, because that is
   * exactly when `Conversation` remounts and reports its state again. Clearing
   * without a remount — deleting some other chat, or clicking the row that is
   * already open — would empty the header and panel with nothing to refill them.
   */
  const selectChat = useCallback(
    (id: string) => {
      setChatsOpen(false);
      if (id === activeId) return;
      resetConversationState();
      savedChats.select(id);
    },
    [savedChats, activeId, resetConversationState],
  );

  const newChat = useCallback(() => {
    setChatsOpen(false);
    // `startNew` reuses an existing blank chat, so this can be a no-op.
    if (activeChat && activeChat.messages.length === 0) return;
    resetConversationState();
    savedChats.startNew();
  }, [savedChats, activeChat, resetConversationState]);

  const deleteChat = useCallback(
    (id: string) => {
      if (id === activeId) resetConversationState();
      savedChats.remove(id);
    },
    [savedChats, activeId, resetConversationState],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-6 border-b border-border-soft bg-surface-header px-6 py-3.5 backdrop-blur-md">
        <div className="flex items-center gap-3">
          {/* Only needed when the sidebar has collapsed. */}
          <button
            type="button"
            className="hidden shrink-0 rounded-md border border-border bg-bg-card px-2.5 py-2 text-xs font-semibold text-text-dim hover:border-accent max-[1080px]:block"
            onClick={() => setChatsOpen((open) => !open)}
            aria-expanded={chatsOpen}
            aria-label="Saved searches"
          >
            ☰
          </button>
          <span
            className="size-[30px] shrink-0 rounded-[9px] bg-linear-to-br from-accent to-accent-teal"
            aria-hidden="true"
          />
          <div>
            <h1 className="m-0 text-[15px] font-[650] tracking-[-0.01em]">Agentic influencer search</h1>
            <p className="m-0 text-xs text-text-faint">
              Built on the{' '}
              <a href="https://docs.modash.io/products/discovery_api/openapi_doc/discovery/ai-search">
                Modash AI Search API
              </a>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <CreditMeter usage={usage} />

          {/* Always reachable, so a shortlist is never somewhere the user can't see. */}
          <button
            type="button"
            className={`flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold transition-colors ${
              shortlistOpen
                ? 'border-accent-border-strong bg-accent-soft text-text'
                : 'border-border bg-bg-card text-text-dim hover:border-accent'
            }`}
            onClick={() => setShortlistOpen((open) => !open)}
            aria-expanded={shortlistOpen}
          >
            Shortlist
            <span
              className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                shortlist.length > 0 ? 'bg-good-soft text-good' : 'bg-bg-input text-text-faint'
              }`}
            >
              {shortlist.length}
            </span>
          </button>
        </div>
      </header>

      {/* Wraps both trees that render creator cards: the transcript and the shortlist. */}
      <CreatorFeedbackProvider verdicts={activeChat?.verdicts ?? {}} onChange={handleVerdicts}>
        <main
          className={`grid min-h-0 flex-1 max-[1080px]:grid-cols-[minmax(0,1fr)] ${
            shortlistOpen ? 'grid-cols-[220px_minmax(0,1fr)_330px]' : 'grid-cols-[220px_minmax(0,1fr)]'
          }`}
        >
          <ChatList
            chats={savedChats.chats}
            activeId={activeId}
            open={chatsOpen}
            onSelect={(id) => {
              setChatsOpen(false);
              selectChat(id);
            }}
            onNew={newChat}
            onDelete={deleteChat}
          />

          {/* Keyed so switching conversations remounts useChat with the right history. */}
          {savedChats.ready && activeChat && (
            <Conversation
              key={activeChat.id}
              chatId={activeChat.id}
              initialMessages={activeChat.messages}
              onUsage={setStreamedUsage}
              onNotice={pushNotice}
              onMessagesSettled={handleSettled}
              onShortlistChange={setShortlist}
            />
          )}

          {shortlistOpen && <ShortlistPanel entries={shortlist} onClose={() => setShortlistOpen(false)} />}
        </main>
      </CreatorFeedbackProvider>

      {/* Only bites when a panel is an overlay; at full width each has its own column. */}
      {(shortlistOpen || chatsOpen) && (
        <button
          type="button"
          className="fixed inset-0 z-20 hidden bg-black/50 max-[1080px]:block"
          onClick={() => {
            setShortlistOpen(false);
            setChatsOpen(false);
          }}
          aria-label="Close panel"
          tabIndex={-1}
        />
      )}

      <Notices notices={notices} onDismiss={dismissNotice} />
    </div>
  );
}
