/**
 * The wire contract between the Express route and the React app.
 *
 * Tool *results* are kept small on purpose: everything the model needs to reason
 * about a search comes back as a compact summary, while the rich payload the UI
 * renders (avatars, post thumbnails, stats) is streamed separately as a typed
 * data part. Thumbnail URLs are long and worthless to the model — sending them
 * through the conversation would burn tokens on every subsequent turn.
 *
 * See https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data
 */

import type { UIMessage } from 'ai';
import type { AudienceReport, Creator, Platform } from './creators';

/** A search (or lookalike lookup) the agent ran, rendered as a result card. */
export interface SearchDataPart {
  kind: 'text-search' | 'lookalikes';
  status: 'running' | 'complete' | 'error';
  platform: Platform;
  /** The natural-language query the agent wrote, or the source handles for lookalikes. */
  query: string;
  /** Human-readable filter summary, e.g. `followers 10k–250k`, `language en`. */
  filterSummary: string[];
  /** Why the agent ran this search. Surfacing intent is what makes the loop legible. */
  rationale?: string;
  total?: number;
  creators?: Creator[];
  creditsSpent?: number;
  error?: string;
}

export interface ShortlistEntry {
  creator: Creator;
  reason: string;
  fit: 'strong' | 'possible';
}

export interface UsageDataPart {
  creditsSpent: number;
  creditsBudget: number;
  paidCalls: number;
  /** Account-wide balance from GET /user/info, when the agent has looked it up. */
  accountCredits?: number;
  mock: boolean;
}

/**
 * A follow-up the agent thinks is worth doing, phrased so the UI can run it
 * without the user retyping it. `instruction` is sent verbatim as the next user
 * message when the button is clicked, which is why the agent is told to write it
 * as an instruction rather than a description.
 */
export interface NextStep {
  label: string;
  instruction: string;
  /** Rough credit cost, so nobody clicks a button that spends 5 credits blind. */
  estimatedCredits?: number;
}

export interface ReportsDataPart {
  status: 'running' | 'complete' | 'error';
  /** Handles being reported on, known before the results come back. */
  usernames: string[];
  reports?: AudienceReport[];
  creditsSpent?: number;
  error?: string;
}

export type ChatDataParts = {
  search: SearchDataPart;
  shortlist: { entries: ShortlistEntry[] };
  reports: ReportsDataPart;
  nextSteps: { steps: NextStep[] };
  usage: UsageDataPart;
  /** Transient: delivered via `onData`, never persisted into message history. */
  notice: { level: 'info' | 'warning' | 'error'; message: string };
};

export type ChatMessage = UIMessage<never, ChatDataParts>;

/** Labels for the generic tool-activity rows in the transcript. */
export const TOOL_LABELS: Record<string, string> = {
  searchCreators: 'AI Search',
  findLookalikes: 'Lookalike search',
  resolveLocations: 'Location lookup',
  resolveLanguage: 'Language lookup',
  resolveBrands: 'Brand lookup',
  resolveTextTags: 'Hashtag / mention lookup',
  shortlistCreators: 'Shortlist update',
  removeFromShortlist: 'Shortlist trimmed',
  checkCredits: 'Credit check',
  getAudienceReports: 'Audience reports',
  proposeNextSteps: 'Next steps',
};
