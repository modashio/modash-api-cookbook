import { creatorKey } from '../shared/feedback';
import type { ChatMessage, NextStep, ShortlistEntry } from '../shared/messages';

/**
 * A standing next step, offered by the UI rather than proposed by the agent.
 *
 * The agent suggests follow-ups based on what just happened, so "go back and
 * check the shortlist" is exactly the kind of thing it drops once the
 * conversation has moved on. This one is always there while a shortlist exists.
 *
 * The cost shown is the number of creators that still need a report — reports
 * already bought this conversation are reused, so re-running the review is
 * usually free the second time.
 */
export function buildReviewStep(messages: ChatMessage[], shortlist: ShortlistEntry[]): NextStep | undefined {
  if (shortlist.length === 0) return undefined;

  const reported = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'data-reports') continue;
      for (const report of part.data.reports ?? []) {
        reported.add(creatorKey(report.platform, report.username));
      }
    }
  }

  const unreported = shortlist.filter(
    (entry) => !reported.has(creatorKey(entry.creator.platform, entry.creator.username)),
  ).length;

  return {
    label: 'Auto-review & filter shortlist',
    instruction:
      'Review the shortlist properly: pull audience reports for any shortlisted creator that does not have one yet, judge every creator against the brief on audience location, credibility and demographics, then remove the ones that do not fit and give me a one-line reason for each cut.',
    // 1 credit per report; the rest of the work is free.
    ...(unreported > 0 ? { estimatedCredits: unreported } : {}),
  };
}
