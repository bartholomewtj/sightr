// Adapted from T3 Code apps/web/src/components/chat/MessageCopyButton.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Same button and tooltip. Changes: lucide-react icons instead of MorphIcon; the clipboard call is
// wrapped in try/catch and a failure shows a status line beside the button (T11) instead of T3's
// anchored toast; no extra clipboard flavours.
import { CheckIcon, CopyIcon, type LucideIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const COPIED_MS = 1500;

/** Write `text` to the clipboard; false when the browser refuses (no permission, insecure origin). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  label = "Copy message",
  icon: Icon = CopyIcon,
  size = "xs",
  variant = "outline",
  className,
}: {
  text: string;
  label?: string;
  icon?: LucideIcon;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onCopy = async () => {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), ok ? COPIED_MS : COPIED_MS * 3);
  };

  return (
    <span className="inline-flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={label}
              disabled={state === "copied"}
              onClick={() => void onCopy()}
              type="button"
              size={size}
              variant={variant === "ghost" ? "ghost-muted" : variant}
              className={className}
            />
          }
        >
          {state === "copied" ? (
            <CheckIcon className="size-3 text-primary" />
          ) : (
            <Icon className={cn("size-3")} />
          )}
        </TooltipTrigger>
        <TooltipPopup>
          <p>{label}</p>
        </TooltipPopup>
      </Tooltip>
      {state === "failed" ? (
        <span role="status" className="text-2xs text-warning">
          Couldn't copy. Select the text instead.
        </span>
      ) : null}
    </span>
  );
});
