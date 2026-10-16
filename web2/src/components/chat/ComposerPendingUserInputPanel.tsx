// Adapted from T3 Code apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: one question per request (a Sightr `question` runtime request), answered by tapping one of
// the dialog's own options, which posts at once (no draft answers, Next/Submit or multi-select: T17).
// T3's digit shortcuts 1–9 are kept, and never fire while typing in a field. A question with no options
// (a free-text row, multi-select, wizard or preview before T17) shows the prompt and Open terminal.
import { memo, useEffect, type Ref } from "react";
import { MessageCircleQuestionIcon } from "lucide-react";

import type { RuntimeRequest } from "@shared/v2/contracts";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { OpenTerminalButton } from "./ComposerPendingApprovalPanel";

interface PendingUserInputPanelProps {
  request: RuntimeRequest;
  pendingCount: number;
  paneId: string;
  respondingIndex: number | null;
  verdict: string | null;
  disabled?: boolean;
  firstOptionRef?: Ref<HTMLButtonElement>;
  onRespond: (optionIndex: number) => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  request,
  pendingCount,
  paneId,
  respondingIndex,
  verdict,
  disabled = false,
  firstOptionRef,
  onRespond,
}: PendingUserInputPanelProps) {
  const responding = respondingIndex !== null;
  const options = request.options;

  // T3: digits 1–9 pick an option when focus is not in a text field. Destructive options are skipped
  // (they need the second tap on the button itself).
  useEffect(() => {
    if (disabled || responding || options.length === 0) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLElement && target.closest('[contenteditable]:not([contenteditable="false"])')) return;
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const option = options[digit - 1];
      if (!option || option.destructive) return;
      event.preventDefault();
      onRespond(digit - 1);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [disabled, responding, options, onRespond]);

  return (
    <ComposerBanner.Root variant="you" density="spacious" data-request-kind="question">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-xs">
          <MessageCircleQuestionIcon className="size-4 text-house-accent" aria-hidden="true" />
          <h2 className="font-semibold text-house-accent">The agent is asking</h2>
          {pendingCount > 1 ? <span className="ml-auto tabular-nums text-muted-foreground">1/{pendingCount}</span> : null}
        </div>
        <p className="max-h-40 overflow-auto whitespace-pre-wrap text-sm text-foreground" tabIndex={0} aria-label="Question">
          {request.prompt}
        </p>
        {options.length > 0 ? (
          <ComposerPendingApprovalActions
            options={options}
            respondingIndex={respondingIndex}
            disabled={disabled}
            firstOptionRef={firstOptionRef}
            onRespond={onRespond}
          />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Answer in the Terminal tab.</p>
            <div>
              <OpenTerminalButton paneId={paneId} />
            </div>
          </>
        )}
        {verdict ? (
          <p role="status" className="text-xs text-muted-foreground">
            {verdict}
          </p>
        ) : null}
      </div>
    </ComposerBanner.Root>
  );
});
