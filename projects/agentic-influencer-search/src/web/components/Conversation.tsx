import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { countVerdicts, toVerdictList } from '../../shared/feedback';
import type { ChatMessage, ShortlistEntry, UsageDataPart } from '../../shared/messages';
import { useCreatorFeedback } from '../feedback';
import { buildReviewStep } from '../review-step';
import { Alert } from './Alert';
import { Composer } from './Composer';
import { EmptyState } from './EmptyState';
import { MessageTranscript } from './MessageTranscript';

/**
 * One conversation. `App` mounts this with `key={chatId}`, so switching chats
 * remounts it and `useChat` picks up the right history — rather than relying on
 * the hook to notice that its `id` and `messages` changed underneath it.
 */
export function Conversation({
  chatId,
  initialMessages,
  onUsage,
  onNotice,
  onMessagesSettled,
  onShortlistChange,
}: {
  chatId: string;
  initialMessages: ChatMessage[];
  onUsage: (usage: UsageDataPart) => void;
  onNotice: (notice: { level: 'info' | 'warning' | 'error'; message: string }) => void;
  onMessagesSettled: (messages: ChatMessage[]) => void;
  /** Lifted so the header can show a count and the panel can live outside the grid. */
  onShortlistChange: (entries: ShortlistEntry[]) => void;
}) {
  const { verdicts } = useCreatorFeedback();
  // Verdicts ride along with each request rather than living in the transcript,
  // so the agent always sees the current set instead of a history of changes.
  const verdictsRef = useRef(verdicts);
  verdictsRef.current = verdicts;

  const { messages, sendMessage, status, stop, error } = useChat<ChatMessage>({
    id: chatId,
    messages: initialMessages,
    transport: new DefaultChatTransport({ api: '/api/chat' }),
    onData: (part) => {
      // `data-usage` is reconciled by id, so this always holds the latest spend.
      if (part.type === 'data-usage') onUsage(part.data);

      // `data-notice` is transient — it only ever arrives here, never in message.parts.
      if (part.type === 'data-notice') onNotice(part.data);
    },
  });

  const send = useCallback(
    (text: string) => sendMessage({ text }, { body: { verdicts: toVerdictList(verdictsRef.current) } }),
    [sendMessage],
  );

  const busy = status === 'submitted' || status === 'streaming';

  // Save once a turn settles rather than on every token. localStorage writes are
  // synchronous, and transcripts are large enough that doing this mid-stream
  // would stutter the UI for no benefit.
  useEffect(() => {
    if (busy || messages.length === 0) return;
    onMessagesSettled(messages);
  }, [busy, messages, onMessagesSettled]);

  /**
   * Switching or deleting a chat mid-stream unmounts this component before the
   * turn settles. Flush what we have — a partial turn beats no turn — and then
   * abort the request. Without the abort the stream keeps running behind a
   * conversation the user has left, and paid searches and reports carry on
   * spending credits.
   */
  const latest = useRef({ messages, onMessagesSettled, stop });
  latest.current = { messages, onMessagesSettled, stop };

  useEffect(
    () => () => {
      const { messages: pending, onMessagesSettled: persist, stop: abort } = latest.current;
      if (pending.length > 0) persist(pending);
      void abort();
    },
    [],
  );

  // The shortlist lives in the message history, so restoring a saved chat
  // rebuilds it with no extra state anywhere.
  const shortlist = useMemo<ShortlistEntry[]>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const parts = messages[i]?.parts ?? [];
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j];
        if (part?.type === 'data-shortlist') return part.data.entries;
      }
    }
    return [];
  }, [messages]);

  // Offered by the UI, not the agent: a standing 'go back and check the shortlist'
  // that survives the conversation moving on.
  const reviewStep = useMemo(() => buildReviewStep(messages, shortlist), [messages, shortlist]);

  useEffect(() => {
    onShortlistChange(shortlist);
  }, [shortlist, onShortlistChange]);

  const { liked, disliked } = countVerdicts(verdicts);

  return (
    <section className="flex min-h-0 min-w-0 flex-col" aria-label="Conversation">
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-2">
        {messages.length === 0 ? (
          <EmptyState onPick={send} disabled={busy} />
        ) : (
          <MessageTranscript
            messages={messages}
            busy={busy}
            onRunNextStep={send}
            standingStep={reviewStep}
          />
        )}

        {error && <Alert variant="error">{error.message}</Alert>}
      </div>

      {liked + disliked > 0 && (
        <div className="flex items-center gap-3 border-t border-border-soft px-6 pt-3 text-[11.5px] text-text-faint">
          <span>
            {liked > 0 && <span className="text-good">{liked} liked</span>}
            {liked > 0 && disliked > 0 && ' · '}
            {disliked > 0 && <span className="text-bad">{disliked} not wanted</span>}
          </span>
          <button
            type="button"
            className="rounded-sm border border-border bg-bg-card px-2.5 py-1 text-[11.5px] font-semibold text-text-dim transition-colors hover:border-accent disabled:opacity-50"
            onClick={() =>
              send('Use my likes and dislikes to refine the search, and tell me what you changed.')
            }
            disabled={busy}
          >
            Refine with these
          </button>
        </div>
      )}

      <Composer busy={busy} onSend={send} onStop={stop} />
    </section>
  );
}
