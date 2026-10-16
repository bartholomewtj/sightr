// Adapted from T3 Code apps/web/src/components/chat/ComposerPrimaryActions.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: the button's state comes from ChatComposer.logic's table (thread status, capabilities and
// the queue), so the props are that result; labelled pill buttons (Send / Queue / Steer / Update)
// instead of an icon-only circle, for phones; T3's square Stop button and its Ctrl/⌘-click alternate
// kept. No pending-question, plan, resume, compact or worktree states.
import { memo, type MouseEvent } from "react";
import { ArrowUpIcon, CheckIcon, CornerUpRightIcon, ListPlusIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerButtons } from "./ChatComposer.logic";

const pillClassName =
  "inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-primary px-4 font-medium text-sm text-primary-foreground shadow-xs outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:h-8";

interface ComposerPrimaryActionsProps {
  buttons: ComposerButtons;
  /** The destructive-text guard is armed: the next tap sends. */
  confirmArmed: boolean;
  interrupting: boolean;
  followUp: "queue" | "steer";
  onSubmit: (alternate: boolean) => void;
  onInterrupt: () => void;
}

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  buttons,
  confirmArmed,
  interrupting,
  followUp,
  onSubmit,
  onInterrupt,
}: ComposerPrimaryActionsProps) {
  const { primary } = buttons;
  const stopButton = (
    <button
      key="interrupt"
      type="button"
      className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs transition-colors duration-150 hover:bg-destructive disabled:opacity-64 sm:size-8"
      disabled={interrupting}
      onClick={onInterrupt}
      aria-label={interrupting ? "Stopping" : "Stop"}
      title="Stop the agent"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  );

  if (primary.kind === "stop") {
    return <div className="flex items-center gap-2">{stopButton}</div>;
  }

  const working = primary.kind === "queue" || primary.kind === "steer";
  const other = followUp === "queue" ? "steer" : "queue";
  const tooltip = primary.reason ?? (working ? `Click to ${primary.kind}, Ctrl/⌘-click to ${other}` : primary.label);
  const label = confirmArmed ? "Tap again to send" : primary.label;

  return (
    <div className="flex items-center gap-2">
      {buttons.stop ? stopButton : null}
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <button
            type="button"
            data-primary-kind={primary.kind}
            className={cn(pillClassName, confirmArmed && "bg-warn text-paper hover:bg-warn/90")}
            disabled={primary.disabled}
            aria-label={label}
            onClick={(event: MouseEvent<HTMLButtonElement>) => onSubmit(event.ctrlKey || event.metaKey)}
          >
            {primary.kind === "update" ? (
              <CheckIcon className="size-4" aria-hidden="true" />
            ) : primary.kind === "queue" ? (
              <ListPlusIcon className="size-4" aria-hidden="true" />
            ) : primary.kind === "steer" ? (
              <CornerUpRightIcon className="size-4" aria-hidden="true" />
            ) : (
              <ArrowUpIcon className="size-4" aria-hidden="true" />
            )}
            <span>{label}</span>
          </button>
        </TooltipTrigger>
        <TooltipPopup>{tooltip}</TooltipPopup>
      </Tooltip>
    </div>
  );
});
