import { formatCredits } from '../../shared/format';
import type { UsageDataPart } from '../../shared/messages';

export function CreditMeter({ usage }: { usage: UsageDataPart | null }) {
  if (!usage) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-text-faint">
        <span className="text-text-dim">Credits</span>
        <span className="font-mono tabular-nums">idle</span>
      </div>
    );
  }

  const ratio = usage.creditsBudget > 0 ? Math.min(1, usage.creditsSpent / usage.creditsBudget) : 0;

  return (
    <div className="flex items-center gap-3 text-xs">
      {usage.mock && (
        <span
          className="rounded-full border border-warn-border bg-warn-soft px-2 py-0.5 text-[10px] uppercase tracking-[0.07em] text-warn"
          title="No Modash token configured — synthetic data, no credits spent"
        >
          mock data
        </span>
      )}

      <div className="min-w-52">
        <div className="flex justify-between gap-3">
          <span className="text-text-dim">Session credits</span>
          <span className="font-mono tabular-nums">
            {formatCredits(usage.creditsSpent)} / {usage.creditsBudget}
          </span>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-border">
          <div
            className="h-full bg-linear-to-r from-good to-warn transition-[width] duration-400 ease-in-out"
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
        <div className="mt-0.5 flex justify-between gap-3 text-[11px] text-text-faint">
          <span>{usage.paidCalls} paid call{usage.paidCalls === 1 ? '' : 's'}</span>
          {usage.accountCredits !== undefined && <span>{usage.accountCredits.toLocaleString()} on account</span>}
        </div>
      </div>
    </div>
  );
}
