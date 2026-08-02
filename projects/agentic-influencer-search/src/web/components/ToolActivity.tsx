import { TOOL_LABELS } from '../../shared/messages';

const RUNNING_STATES = new Set(['input-streaming', 'input-available']);

/**
 * The free, boring steps: dictionary lookups, shortlist writes, credit checks.
 * Showing them is what makes the agent's reasoning auditable — a reader can see
 * that it resolved "Berlin" to a location ID instead of inventing one.
 */
export function ToolActivity({
  name,
  state,
  output,
}: {
  name: string;
  state: string;
  output: unknown;
}) {
  const running = RUNNING_STATES.has(state);
  const failed = state === 'output-error';

  const dotClass = failed
    ? 'bg-bad'
    : running
      ? 'animate-pulse-dot bg-accent'
      : 'bg-good';

  return (
    <div className="flex items-baseline gap-2 text-xs text-text-dim">
      <span className={`size-1.5 shrink-0 -translate-y-px rounded-full ${dotClass}`} aria-hidden="true" />
      <span className="text-text">{TOOL_LABELS[name] ?? name}</span>
      {!running && <span className="truncate text-text-faint">{summarise(output)}</span>}
    </div>
  );
}

function summarise(output: unknown): string {
  if (!output || typeof output !== 'object') return '';
  const record = output as Record<string, unknown>;

  if (typeof record.error === 'string') return record.error;

  if (Array.isArray(record.locations)) {
    return record.locations.length
      ? record.locations.map((location) => (location as { title: string }).title).join(' · ')
      : 'no match';
  }
  if (Array.isArray(record.languages)) {
    return record.languages.map((language) => (language as { code: string }).code).join(', ') || 'no match';
  }
  if (Array.isArray(record.brands)) return record.brands.join(', ') || 'no match';
  if (Array.isArray(record.tags)) return record.tags.slice(0, 6).join(' · ') || 'no match';
  if (Array.isArray(record.added)) return `${record.added.length} creator(s) shortlisted`;
  if (typeof record.sessionCreditsRemaining === 'number') {
    return `${record.sessionCreditsRemaining} credits left in this session`;
  }
  if (typeof record.note === 'string') return record.note;

  return 'done';
}
