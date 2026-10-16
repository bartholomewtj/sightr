// Adapted from T3 Code apps/web/src/components/chat/ComposerPendingApprovalActions.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: one full-width button per option the dialog itself offers (Sightr answers by the dialog's own
// keys, so there is no fixed accept/decline set and no overflow menu), 44 px tall for phones. T3's
// `warning` becomes the bridge's `destructive`: warn tokens, never first, and a second tap to confirm.
// The tapped option shows busy until the request leaves `pending`.
import { memo, useEffect, useState, type Ref } from "react";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";

import type { RuntimeRequestOption } from "@shared/v2/contracts";
import { cn } from "~/lib/utils";
import { orderRequestOptions } from "./ChatComposer.logic";

/** How long an armed destructive option waits for its second tap. */
export const CONFIRM_MS = 4_000;

interface ComposerPendingApprovalActionsProps {
  options: readonly RuntimeRequestOption[];
  /** The option index whose answer is in flight. */
  respondingIndex: number | null;
  disabled?: boolean;
  /** Receives the first non-destructive option, for the panel's focus rule. */
  firstOptionRef?: Ref<HTMLButtonElement>;
  onRespond: (optionIndex: number) => void;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  options,
  respondingIndex,
  disabled = false,
  firstOptionRef,
  onRespond,
}: ComposerPendingApprovalActionsProps) {
  const [armed, setArmed] = useState<number | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const id = setTimeout(() => setArmed(null), CONFIRM_MS);
    return () => clearTimeout(id);
  }, [armed]);

  const responding = respondingIndex !== null;
  const ordered = orderRequestOptions(options);
  return (
    <div className="flex flex-col gap-1.5" data-request-options="true">
      {ordered.map(({ option, index }, position) => {
        const destructive = option.destructive === true;
        const isArmed = armed === index;
        const busy = respondingIndex === index;
        return (
          <button
            key={index}
            ref={position === 0 && !destructive ? firstOptionRef : undefined}
            type="button"
            data-option-index={index}
            aria-busy={busy || undefined}
            disabled={disabled || responding}
            onClick={() => {
              if (disabled || responding) return;
              if (destructive && !isArmed) {
                setArmed(index);
                return;
              }
              setArmed(null);
              onRespond(index);
            }}
            className={cn(
              "flex min-h-11 w-full items-center gap-2 rounded-lg border-2 px-3 py-2 text-left text-sm font-medium transition-colors",
              "disabled:cursor-not-allowed",
              destructive
                ? "border-warn/50 bg-warning-surface text-warn hover:border-warn"
                : "border-border bg-card text-foreground hover:border-you hover:bg-you-soft",
              busy && "border-you bg-you-soft",
              responding && !busy && "opacity-60",
              isArmed && "border-warn bg-warn text-paper",
            )}
          >
            {destructive ? <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" /> : null}
            <span className="min-w-0 flex-1 break-words">
              {isArmed ? "Tap again to confirm" : option.label}
              {option.description && !isArmed ? (
                <span className="block text-xs font-normal text-muted-foreground">{option.description}</span>
              ) : null}
            </span>
            {busy ? <Loader2Icon className="size-4 shrink-0 animate-spin" aria-label="Sending" /> : null}
          </button>
        );
      })}
    </div>
  );
});
