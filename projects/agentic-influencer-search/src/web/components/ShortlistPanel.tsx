import type { ShortlistEntry } from '../../shared/messages';
import { CreatorCard } from './CreatorCard';

const FIT_CLASS = {
  strong: 'bg-good-soft text-good',
  possible: 'bg-border text-text-dim',
} as const;

/**
 * A docked column when the window is wide enough, and a slide-over drawer when it
 * isn't. It used to be `hidden` below 1080px, so in a narrow window — an IDE's
 * side browser, say — shortlisted creators appeared to go nowhere.
 */
export function ShortlistPanel({ entries, onClose }: { entries: ShortlistEntry[]; onClose: () => void }) {
  const strong = entries.filter((entry) => entry.fit === 'strong').length;

  return (
    <aside
      className="z-30 flex min-h-0 flex-col overflow-y-auto border-l border-border-soft bg-surface-panel p-4 max-[1080px]:fixed max-[1080px]:inset-y-0 max-[1080px]:right-0 max-[1080px]:w-[min(340px,88vw)] max-[1080px]:bg-bg-raised max-[1080px]:shadow-card"
      aria-label="Shortlist"
    >
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="m-0 text-[13px] tracking-[0.08em] text-text-dim uppercase">Shortlist</h2>
        <span className="ml-auto text-[11px] text-text-faint">
          {entries.length === 0 ? 'empty' : `${entries.length} · ${strong} strong`}
        </span>
        <button
          type="button"
          className="rounded-sm px-1 text-sm leading-none text-text-faint hover:text-text"
          onClick={onClose}
          aria-label="Close shortlist"
          title="Close"
        >
          ×
        </button>
      </header>

      {entries.length === 0 ? (
        <p className="m-0 text-xs text-text-faint">
          Creators the agent recommends will collect here, with the reason it picked them.
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
          {entries.map((entry) => (
            <li
              key={`${entry.creator.platform}:${entry.creator.username}`}
              className="rounded-sm border border-border-soft bg-bg-card px-2 py-2"
            >
              {/* On its own line, not floated into the corner — the card's own
                  like/dislike controls already sit top-right. */}
              <span
                className={`ml-1 inline-block rounded-[5px] px-1.5 py-0.5 text-[10px] tracking-[0.06em] uppercase ${FIT_CLASS[entry.fit]}`}
              >
                {entry.fit}
              </span>
              <CreatorCard creator={entry.creator} compact />
              <p className="mx-1 mt-0 mb-0.5 text-[11.5px] text-text-dim">{entry.reason}</p>
            </li>
          ))}
        </ol>
      )}

      {entries.length > 0 && (
        <p className="mt-4 mb-0 border-t border-border-soft pt-3.5 text-xs text-text-faint">
          Ask for audience reports before reaching out — search matches content, not audience.
          They cost 1 credit each and show credibility, country and age split.
        </p>
      )}
    </aside>
  );
}
