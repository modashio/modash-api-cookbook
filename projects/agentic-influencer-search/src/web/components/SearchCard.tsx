import { PLATFORM_LABELS, type Platform } from '../../shared/creators';
import { formatCredits } from '../../shared/format';
import type { SearchDataPart } from '../../shared/messages';
import { Alert } from './Alert';
import { CreatorCard } from './CreatorCard';

const LABEL = 'mr-2 text-[10px] uppercase tracking-[0.07em] text-text-faint';

const PLATFORM_CHIP: Record<Platform, string> = {
  instagram: 'bg-chip-instagram text-chip-instagram-text',
  tiktok: 'bg-chip-tiktok text-chip-tiktok-text',
  youtube: 'bg-chip-youtube text-chip-youtube-text',
};

const STATUS_BORDER: Record<SearchDataPart['status'], string> = {
  running: 'border-accent-border-strong',
  complete: 'border-border-soft',
  error: 'border-bad-border-strong',
};

export function SearchCard({ search }: { search: SearchDataPart }) {
  const heading = search.kind === 'lookalikes' ? 'Lookalike search' : 'AI Search';

  return (
    <section className={`rounded-md border bg-bg-raised px-4 py-3.5 ${STATUS_BORDER[search.status]}`}>
      <header className="mb-2 flex items-center gap-2">
        <span
          className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${PLATFORM_CHIP[search.platform]}`}
        >
          {PLATFORM_LABELS[search.platform]}
        </span>
        <span className="text-xs font-semibold">{heading}</span>
        {search.status === 'running' && (
          <span
            className="size-[11px] animate-spin-search rounded-full border-2 border-border border-t-accent"
            aria-label="Searching"
          />
        )}
        {search.status === 'complete' && (
          <span className="ml-auto text-[11px] tabular-nums text-text-faint">
            {search.creators?.length ?? 0} of {search.total?.toLocaleString() ?? '?'} matches
            {search.creditsSpent !== undefined && ` · ${formatCredits(search.creditsSpent)} credits`}
          </span>
        )}
      </header>

      <p className="m-0 text-[13px]">
        <span className={LABEL}>{search.kind === 'lookalikes' ? 'similar to' : 'query'}</span>
        {search.query}
      </p>

      {search.filterSummary.length > 0 && (
        <ul className="mt-2 flex list-none flex-wrap gap-1.5 p-0">
          {search.filterSummary.map((filter) => (
            <li
              key={filter}
              className="rounded-md border border-border-soft bg-bg-input px-2 py-0.5 font-mono text-[11px] text-text-dim"
            >
              {filter}
            </li>
          ))}
        </ul>
      )}

      {search.rationale && (
        <p className="mt-2.5 mb-0 border-l-2 border-border pl-2.5 text-xs text-text-faint italic">
          {search.rationale}
        </p>
      )}

      {search.status === 'error' && <Alert variant="error">{search.error}</Alert>}

      {search.status === 'complete' && search.creators?.length === 0 && (
        <Alert variant="muted">No creators matched. The agent should loosen the filters or rephrase.</Alert>
      )}

      {search.creators && search.creators.length > 0 && (
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-2">
          {search.creators.map((creator) => (
            <CreatorCard key={`${creator.platform}:${creator.username}`} creator={creator} />
          ))}
        </div>
      )}
    </section>
  );
}
