export interface Notice {
  id: number;
  level: 'info' | 'warning' | 'error';
  message: string;
}

const LEVEL_BORDER: Record<Notice['level'], string> = {
  info: 'border-border',
  warning: 'border-warn-border',
  error: 'border-bad-border-strong',
};

/** Toasts fed by transient `data-notice` parts — credit warnings, API errors. */
export function Notices({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: number) => void }) {
  if (notices.length === 0) return null;

  return (
    <div
      // Above the sidebars (z-30) — at z-10 a toast was hidden behind the shortlist panel.
      className="fixed right-4 bottom-4 z-40 flex max-w-sm flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={`flex items-start gap-2.5 rounded-sm border bg-bg-card px-3 py-2.5 text-xs shadow-card ${LEVEL_BORDER[notice.level]}`}
        >
          <span>{notice.message}</span>
          <button
            type="button"
            className="cursor-pointer border-none bg-transparent p-0 text-base leading-none text-text-faint"
            onClick={() => onDismiss(notice.id)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
