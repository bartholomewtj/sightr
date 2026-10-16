// Adapted from T3 Code apps/web/src/components/RightPanelSheet.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: a full-height bottom sheet on a phone (T13), one tab at a time, not kept mounted (closing it
// stops the tab's reads); the system back gesture closes it before it leaves the thread (one history
// entry per open sheet, `popstate` closes); a title bar names the tab.
import { XIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { guardPanelLeave } from "./right-panel/leaveGuard";
import { Button } from "./ui/button";
import { Sheet, SheetPopup, SheetTitle } from "./ui/sheet";

const SHEET_STATE = "sightrSheet";

/**
 * One history entry while a sheet is open. Back pops it (and closes the sheet) instead of leaving the
 * thread; closing the sheet any other way pops the entry it pushed.
 */
export function useSheetHistory(open: boolean, onClose: () => void): void {
  const pushed = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    window.history.pushState({ ...(window.history.state as object | null), [SHEET_STATE]: true }, "");
    pushed.current = true;
    const onPop = () => {
      if (!pushed.current) return;
      pushed.current = false;
      closeRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Closed from the sheet itself (X, Escape, backdrop): take our entry back off.
      if (pushed.current) {
        pushed.current = false;
        if ((window.history.state as Record<string, unknown> | null)?.[SHEET_STATE]) window.history.back();
      }
    };
  }, [open]);
}

export function RightPanelSheet(props: {
  animationDurationMs?: number;
  children: ReactNode;
  open: boolean;
  title: string;
  onClose: () => void;
}) {
  useSheetHistory(props.open, props.onClose);
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) guardPanelLeave(props.onClose);
      }}
    >
      <SheetPopup
        {...(props.animationDurationMs !== undefined ? { transitionDurationMs: props.animationDurationMs } : {})}
        side="bottom"
        showCloseButton={false}
        className="h-[calc(100dvh-3rem)] rounded-t-2xl"
        data-right-panel-sheet=""
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <SheetTitle className="min-w-0 flex-1 truncate text-base font-semibold">{props.title}</SheetTitle>
          <Button size="icon-sm" variant="ghost" aria-label={`Close ${props.title}`} onClick={() => guardPanelLeave(props.onClose)}>
            <XIcon />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
      </SheetPopup>
    </Sheet>
  );
}
