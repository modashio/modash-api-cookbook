import { formatCredits } from '../../shared/format';
import type { NextStep } from '../../shared/messages';

/**
 * The agent's proposed follow-ups, as buttons. Clicking one sends its
 * `instruction` back as the next user message, so continuing a search never
 * requires the user to work out what to type.
 *
 * Only the latest turn's steps are interactive — see `MessageTranscript`.
 * Re-running a step from three turns ago would spend credits on stale intent.
 */
export function NextSteps({
  steps,
  onRun,
  disabled,
}: {
  steps: NextStep[];
  onRun: (instruction: string) => void;
  disabled: boolean;
}) {
  if (steps.length === 0) return null;

  return (
    <div className="mt-1 flex flex-col gap-2">
      <span className="text-[10px] uppercase tracking-[0.07em] text-text-faint">Next steps</span>

      <div className="flex flex-wrap gap-2">
        {steps.map((step) => (
          <button
            key={step.label}
            type="button"
            className="group flex items-center gap-2 rounded-md border border-border bg-bg-card px-3 py-2 text-left text-xs text-text transition-colors hover:border-accent disabled:cursor-default disabled:opacity-50 disabled:hover:border-border"
            onClick={() => onRun(step.instruction)}
            disabled={disabled}
            title={step.instruction}
          >
            <span className="font-semibold">{step.label}</span>
            {step.estimatedCredits ? (
              <span className="rounded-sm bg-bg-input px-1.5 py-0.5 font-mono text-[10px] text-text-faint tabular-nums">
                ~{formatCredits(step.estimatedCredits)} cr
              </span>
            ) : (
              <span className="rounded-sm bg-bg-input px-1.5 py-0.5 text-[10px] text-text-faint">free</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
