/**
 * The whistlr decision card (T19): a draftr operator decision marked for `whistlr reply`. It takes the
 * composer's place like any request panel, shows the prompt and one button per option, and answers
 * through the bridge's decision-reply route (`state/decision-reply.ts`), never by keys. Sightr's own;
 * the look is the approval panel's (ComposerBanner "you" step, ComposerPendingApprovalActions).
 */
import { memo, type Ref } from "react";
import { MessageSquareReplyIcon } from "lucide-react";

import type { RuntimeRequest } from "@shared/v2/contracts";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

interface ComposerDecisionPanelProps {
  request: RuntimeRequest;
  pendingCount: number;
  respondingIndex: number | null;
  verdict: string | null;
  disabled?: boolean;
  firstOptionRef?: Ref<HTMLButtonElement>;
  onRespond: (optionIndex: number) => void;
}

export const ComposerDecisionPanel = memo(function ComposerDecisionPanel({
  request,
  pendingCount,
  respondingIndex,
  verdict,
  disabled = false,
  firstOptionRef,
  onRespond,
}: ComposerDecisionPanelProps) {
  return (
    <ComposerBanner.Root variant="you" density="spacious" data-request-kind={request.kind} data-decision-card="true">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-xs">
          <MessageSquareReplyIcon className="size-4 text-house-accent" aria-hidden="true" />
          <h2 className="font-semibold text-house-accent">Decision for the operator</h2>
          {pendingCount > 1 ? <span className="ml-auto tabular-nums text-muted-foreground">1/{pendingCount}</span> : null}
        </div>
        {request.prompt ? (
          <p className="max-h-40 overflow-auto whitespace-pre-wrap text-sm text-foreground" tabIndex={0} aria-label="Prompt">
            {request.prompt}
          </p>
        ) : null}
        {request.options.length > 0 ? (
          <ComposerPendingApprovalActions
            options={request.options}
            respondingIndex={respondingIndex}
            disabled={disabled}
            firstOptionRef={firstOptionRef}
            onRespond={onRespond}
          />
        ) : (
          <p className="text-sm text-muted-foreground">This card has no options. Answer it from the desk.</p>
        )}
        <p className="text-2xs text-muted-foreground">Answered with whistlr reply. Nothing is typed into the pane.</p>
        {verdict ? (
          <p role="status" className="text-xs text-muted-foreground">
            {verdict}
          </p>
        ) : null}
      </div>
    </ComposerBanner.Root>
  );
});
