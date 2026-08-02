import { shortlistSize, type SavedChat } from '../storage/chat-store';

/**
 * Saved conversations, newest first. Each one is a campaign's worth of research.
 *
 * Always a docked column when there's room. Below 1080px it collapses, and `open`
 * turns it into a drawer rather than leaving it unreachable.
 */
export function ChatList({
  chats,
  activeId,
  open,
  onSelect,
  onNew,
  onDelete,
}: {
  chats: SavedChat[];
  activeId: string;
  open: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside
      className={`flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-border-soft bg-surface-panel p-3 ${
        open
          ? 'z-30 max-[1080px]:fixed max-[1080px]:inset-y-0 max-[1080px]:left-0 max-[1080px]:w-[min(280px,85vw)] max-[1080px]:bg-bg-raised max-[1080px]:shadow-card'
          : 'max-[1080px]:hidden'
      }`}
      aria-label="Saved searches"
    >
      <button
        type="button"
        className="rounded-md border border-border bg-bg-card px-3 py-2 text-xs font-semibold text-text transition-colors hover:border-accent"
        onClick={onNew}
      >
        + New search
      </button>

      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {chats.map((chat) => {
          const shortlisted = shortlistSize(chat.messages);
          const isActive = chat.id === activeId;

          return (
            <li key={chat.id} className="group relative">
              <button
                type="button"
                className={`w-full rounded-sm border px-2.5 py-2 pr-7 text-left transition-colors ${
                  isActive
                    ? 'border-accent-border-strong bg-accent-soft'
                    : 'border-transparent hover:border-border-soft hover:bg-bg-card'
                }`}
                onClick={() => onSelect(chat.id)}
                aria-current={isActive}
              >
                <span className="block truncate text-[12px] text-text">{chat.title}</span>
                <span className="mt-0.5 block text-[10px] text-text-faint">
                  {chat.messages.length === 0
                    ? 'empty'
                    : `${relativeTime(chat.updatedAt)}${shortlisted > 0 ? ` · ${shortlisted} shortlisted` : ''}`}
                </span>
              </button>

              <button
                type="button"
                className="absolute top-2 right-1.5 rounded-sm px-1 text-sm leading-none text-text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-bad focus-visible:opacity-100"
                onClick={() => onDelete(chat.id)}
                aria-label={`Delete ${chat.title}`}
                title="Delete"
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-auto m-0 pt-3 text-[10px] text-text-faint">
        Saved in this browser only. Clearing site data removes them.
      </p>
    </aside>
  );
}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
