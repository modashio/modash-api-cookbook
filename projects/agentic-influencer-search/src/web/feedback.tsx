import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Platform } from '../shared/creators';
import { creatorKey, type Verdict, type VerdictMap } from '../shared/feedback';

/**
 * Creator cards appear three levels down two different trees (search results and
 * the shortlist), so verdicts go through context rather than being threaded
 * through every component in between.
 *
 * The default is inert, which lets a card render outside a provider — the render
 * tests do exactly that — without the buttons blowing up.
 */
const CreatorFeedback = createContext<{
  verdicts: VerdictMap;
  setVerdict: (platform: Platform, username: string, verdict: Verdict | null) => void;
  enabled: boolean;
}>({
  verdicts: {},
  setVerdict: () => {},
  enabled: false,
});

export function CreatorFeedbackProvider({
  verdicts,
  onChange,
  children,
}: {
  verdicts: VerdictMap;
  /** An updater, not a value: two clicks in one tick must not clobber each other. */
  onChange: (update: (current: VerdictMap) => VerdictMap) => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({
      verdicts,
      enabled: true,
      setVerdict: (platform: Platform, username: string, verdict: Verdict | null) => {
        const key = creatorKey(platform, username);
        onChange((current) => {
          const next = { ...current };
          // Clicking the active verdict again clears it, so a misclick is undoable.
          if (verdict === null || next[key] === verdict) delete next[key];
          else next[key] = verdict;
          return next;
        });
      },
    }),
    [verdicts, onChange],
  );

  return <CreatorFeedback.Provider value={value}>{children}</CreatorFeedback.Provider>;
}

export function useCreatorFeedback() {
  return useContext(CreatorFeedback);
}
