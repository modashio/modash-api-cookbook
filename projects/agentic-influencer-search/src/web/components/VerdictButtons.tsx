import type { Verdict } from '../../shared/feedback';

/**
 * Thumbs up / thumbs down on a creator. Clicking the active one clears it, so a
 * misclick costs nothing. The verdicts are handed to the agent on the next turn,
 * which is what makes them steer rather than just decorate.
 */
export function VerdictButtons({
  verdict,
  username,
  onSet,
}: {
  verdict: Verdict | undefined;
  username: string;
  onSet: (verdict: Verdict) => void;
}) {
  return (
    <div className="flex shrink-0 gap-0.5">
      <Button
        active={verdict === 'like'}
        activeClass="bg-good-soft text-good"
        label={verdict === 'like' ? `Undo liking @${username}` : `More creators like @${username}`}
        onClick={() => onSet('like')}
      >
        {/* Thumbs up */}
        <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
          <path d="M6.6 14H4.2A1.2 1.2 0 0 1 3 12.8V8.2A1.2 1.2 0 0 1 4.2 7h2.1l2.5-4.6a.9.9 0 0 1 1.7.4v3h2.4a1.3 1.3 0 0 1 1.3 1.6l-1 4.6A1.6 1.6 0 0 1 11.6 14H6.6Z" />
        </svg>
      </Button>

      <Button
        active={verdict === 'dislike'}
        activeClass="bg-bad-soft text-bad"
        label={verdict === 'dislike' ? `Undo hiding @${username}` : `Fewer creators like @${username}`}
        onClick={() => onSet('dislike')}
      >
        {/* Thumbs down */}
        <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
          <path d="M9.4 2h2.4A1.2 1.2 0 0 1 13 3.2v4.6A1.2 1.2 0 0 1 11.8 9H9.7l-2.5 4.6a.9.9 0 0 1-1.7-.4v-3H3.1a1.3 1.3 0 0 1-1.3-1.6l1-4.6A1.6 1.6 0 0 1 4.4 2h5Z" />
        </svg>
      </Button>
    </div>
  );
}

function Button({
  active,
  activeClass,
  label,
  onClick,
  children,
}: {
  active: boolean;
  activeClass: string;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rounded-sm p-1 transition-colors ${
        active ? activeClass : 'text-text-faint hover:bg-bg-input hover:text-text-dim'
      }`}
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
