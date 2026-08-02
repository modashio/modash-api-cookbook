import type { AudienceReport } from '../../shared/creators';
import { formatCredits, formatPercent } from '../../shared/format';
import type { ReportsDataPart } from '../../shared/messages';

/**
 * Audience data from a full profile report — the part AI Search can't tell you,
 * and the reason a report costs a whole credit.
 */
export function ReportCard({ part }: { part: ReportsDataPart }) {
  return (
    <section className="rounded-md border border-border-soft bg-bg-raised px-4 py-3.5">
      <header className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold">Audience reports</span>
        {part.status === 'running' && (
          <span
            className="size-[11px] animate-spin-search rounded-full border-2 border-border border-t-accent"
            aria-label="Loading reports"
          />
        )}
        <span className="ml-auto text-[11px] tabular-nums text-text-faint">
          {part.usernames.length} creator{part.usernames.length === 1 ? '' : 's'}
          {part.creditsSpent !== undefined && ` · ${formatCredits(part.creditsSpent)} credits`}
        </span>
      </header>

      {part.status === 'error' && (
        <p className="mt-2.5 mb-0 rounded-sm border border-bad-border bg-bad-soft px-2.5 py-2 text-xs text-bad-text">
          {part.error}
        </p>
      )}

      {part.status === 'running' && (
        <p className="m-0 text-xs text-text-faint">{part.usernames.map((name) => `@${name}`).join(', ')}</p>
      )}

      {part.reports && part.reports.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
          {part.reports.map((report) => (
            <ReportBody key={`${report.platform}:${report.username}`} report={report} />
          ))}
        </div>
      )}
    </section>
  );
}

function ReportBody({ report }: { report: AudienceReport }) {
  const email = report.contacts.find((contact) => contact.type === 'email');

  return (
    <article className="flex flex-col gap-2 rounded-sm border border-border-soft bg-bg-card p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[12.5px] font-semibold">@{report.username}</span>
        {report.credibility !== undefined && (
          <span
            className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] tabular-nums ${
              report.credibility >= 0.75 ? 'bg-good-soft text-good' : 'bg-warn-soft text-warn'
            }`}
            title="Audience credibility: the inverse of estimated fake followers"
          >
            {formatPercent(report.credibility, 0)} real
          </span>
        )}
      </div>

      <Breakdown title="Top countries" rows={report.topCountries} />
      <Breakdown title="Age" rows={report.ageBrackets} />
      <Breakdown title="Gender" rows={report.genders} />

      {email && (
        <a
          className="truncate font-mono text-[11px]"
          href={`mailto:${email.value}`}
          title={email.value}
        >
          {email.value}
        </a>
      )}
    </article>
  );
}

function Breakdown({ title, rows }: { title: string; rows: Array<{ label: string; weight: number }> }) {
  if (rows.length === 0) return null;

  return (
    <div>
      <span className="text-[9.5px] uppercase tracking-[0.04em] text-text-faint">{title}</span>
      <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center gap-2 text-[11px]">
            <span className="w-24 shrink-0 truncate text-text-dim" title={row.label}>
              {row.label}
            </span>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-border">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${Math.min(100, row.weight * 100)}%` }}
              />
            </span>
            <span className="w-9 shrink-0 text-right font-mono tabular-nums text-text-faint">
              {formatPercent(row.weight, 0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
