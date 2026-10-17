// Adapted from T3 Code apps/web/src/components/RightPanelSheet.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: a full-height bottom sheet on a phone (T13), one tab at a time, not kept mounted (closing it
// stops the tab's reads); the system back gesture closes it before it leaves the thread (one history
// entry per open sheet, `popstate` closes, and asks the Files editor first when it holds unsaved edits);
// a tab strip in the title bar switches Terminal / Files / Git without closing the sheet; the sheet
// stops under the status bar (safe-area-top), pads for the home indicator, and shrinks above an iOS
// soft keyboard (lib/keyboard-inset.ts) so the Terminal's key bar is never behind it.
import { XIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { watchKeyboardInset } from "@/lib/keyboard-inset";
import { RIGHT_PANEL_KINDS, RIGHT_PANEL_LABEL, useRightPanelStore } from "@/rightPanelStore";

import { RIGHT_PANEL_ICON } from "./RightPanelTabs";
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
      // Back with unsaved edits asks first. If the guard holds the close, our entry is already gone:
      // put it back so the next back gesture still closes the sheet instead of leaving the thread.
      let closed = false;
      guardPanelLeave(() => {
        closed = true;
        closeRef.current();
      });
      if (!closed) {
        window.history.pushState({ ...(window.history.state as object | null), [SHEET_STATE]: true }, "");
        pushed.current = true;
      }
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
  useEffect(() => (props.open ? watchKeyboardInset() : undefined), [props.open]);
  const active = useRightPanelStore((s) => s.sheet);
  const openSheet = useRightPanelStore((s) => s.openSheet);
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
        className="sheet-fill rounded-t-2xl"
        data-right-panel-sheet=""
      >
        <div className="flex items-center gap-1 border-b px-2 py-0.5">
          <SheetTitle className="sr-only">{props.title}</SheetTitle>
          <div role="tablist" aria-label="Thread tools" className="flex min-w-0 flex-1 items-center gap-0.5">
            {RIGHT_PANEL_KINDS.map((kind) => {
              const Icon = RIGHT_PANEL_ICON[kind];
              const selected = kind === active;
              return (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => (selected ? undefined : guardPanelLeave(() => openSheet(kind)))}
                  className={cn(
                    "inline-flex h-9 pointer-coarse:h-11 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "bg-accent text-foreground" : "text-muted-foreground active:bg-accent/60",
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {RIGHT_PANEL_LABEL[kind]}
                </button>
              );
            })}
          </div>
          <Button size="icon-sm" variant="ghost" aria-label={`Close ${props.title}`} onClick={() => guardPanelLeave(props.onClose)}>
            <XIcon />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
      </SheetPopup>
    </Sheet>
  );
}
