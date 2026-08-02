import { getToolName, isToolUIPart } from 'ai';
import type { ChatMessage, NextStep } from '../../shared/messages';
import { NextSteps } from './NextSteps';
import { ReportCard } from './ReportCard';
import { RichText } from './RichText';
import { SearchCard } from './SearchCard';
import { ToolActivity } from './ToolActivity';

/**
 * Tool calls that already have a dedicated result card. Rendering a generic
 * activity row for them too would just be noise.
 */
const TOOLS_WITH_CARDS = new Set(['searchCreators', 'findLookalikes', 'getAudienceReports', 'proposeNextSteps']);

const roleClass = 'pt-0.5 text-[11px] uppercase tracking-[0.08em] text-text-faint';

export function MessageTranscript({
  messages,
  busy,
  onRunNextStep,
  standingStep,
}: {
  messages: ChatMessage[];
  busy: boolean;
  onRunNextStep: (instruction: string) => void;
  /** Always offered on the latest turn, regardless of what the agent proposed. */
  standingStep?: NextStep | undefined;
}) {
  const lastMessage = messages.at(-1);
  const waitingForFirstToken =
    busy && lastMessage?.role === 'assistant'
      ? !lastMessage.parts.some((part) => part.type === 'text' && part.text.length > 0)
      : busy && lastMessage?.role === 'user';

  return (
    <div className="flex max-w-[860px] flex-col gap-5">
      {messages.map((message, messageIndex) => {
        // Only the most recent turn's buttons stay live. Re-running a suggestion
        // from three turns ago would spend credits on stale intent.
        const isLatest = messageIndex === messages.length - 1;

        // The model sometimes calls proposeNextSteps before writing its closing
        // summary. Buttons belong at the end of a turn regardless, so they are
        // pulled out and appended rather than rendered where they happen to land.
        const proposed = message.parts.findLast((part) => part.type === 'data-nextSteps')?.data.steps ?? [];
        const steps =
          isLatest && standingStep && message.role === 'assistant'
            ? [...proposed, standingStep]
            : proposed;

        return (
          <article key={message.id} className="grid grid-cols-[56px_minmax(0,1fr)] gap-3.5">
            <div className={roleClass}>{message.role === 'user' ? 'You' : 'Agent'}</div>

            <div className="flex min-w-0 flex-col gap-2.5 text-text">
              {message.parts.map((part, index) => {
                const key = `${message.id}-${index}`;

                if (part.type === 'data-nextSteps') return null;

                if (part.type === 'text') {
                  return <RichText key={key} text={part.text} bubble={message.role === 'user'} />;
                }

                if (part.type === 'data-search') {
                  return <SearchCard key={key} search={part.data} />;
                }

                if (part.type === 'data-reports') {
                  return <ReportCard key={key} part={part.data} />;
                }

                if (isToolUIPart(part)) {
                  const toolName = getToolName(part);
                  if (TOOLS_WITH_CARDS.has(toolName)) return null;
                  return <ToolActivity key={key} name={toolName} state={part.state} output={part.output} />;
                }

                return null;
              })}

              {steps.length > 0 && (
                <NextSteps steps={steps} onRun={onRunNextStep} disabled={busy || !isLatest} />
              )}
            </div>
          </article>
        );
      })}

      {waitingForFirstToken && (
        <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-3.5">
          <div className={roleClass}>Agent</div>
          <div className="flex min-w-0 flex-col gap-2.5">
            <span className="inline-flex h-5 items-center gap-1">
              <i className="size-1.5 animate-pulse-dot rounded-full bg-text-faint not-italic" />
              <i className="size-1.5 animate-pulse-dot rounded-full bg-text-faint not-italic [animation-delay:0.15s]" />
              <i className="size-1.5 animate-pulse-dot rounded-full bg-text-faint not-italic [animation-delay:0.3s]" />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
