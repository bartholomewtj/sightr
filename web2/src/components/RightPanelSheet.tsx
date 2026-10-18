// Adapted from T3 Code apps/web/src/components/RightPanelSheet.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: a full-height bottom sheet on a phone (T13), one tab at a time, not kept mounted (closing it
// stops the tab's reads); the system back gesture closes it before it leaves the thread (one history
// entry per open sheet, `popstate` closes the topmost sheet only (`sheetHistory.ts`), and asks the Files
// editor first when it holds unsaved edits); a tab strip in the title bar (it scrolls sideways when four tabs
// do not fit) switches Terminal / Files / Git / Diff without closing the sheet; the sheet
// stops under the status bar (safe-area-top), pads for the home indicator, and shrinks above an iOS
// soft keyboard (lib/keyboard-inset.ts) so the Terminal's key bar is never behind it.
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { watchKeyboardInset } from "@/lib/keyboard-inset";
import { RIGHT_PANEL_KINDS, RIGHT_PANEL_LABEL, useRightPanelStore } from "@/rightPanelStore";

import { RIGHT_PANEL_ICON } from "./RightPanelTabs";
import { guardPanelLeave } from "./right-panel/leaveGuard";
import { useSheetHistory } from "./sheetHistory";
import { Button } from "./ui/button";
import { Sheet, SheetPopup, SheetTitle } from "./ui/sheet";

// The other sheets (changed file, thread details, tasks) import it from here, where it always lived.
export { useSheetHistory } from "./sheetHistory";

function showSelectedTab(strip: HTMLElement | null): void {
  strip?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
  // Four tabs do not fit a 320 px strip: it scrolls sideways, and the open tab is kept in view.
  const strip = useRef<HTMLDivElement | null>(null);
  const stripRef = useCallback((el: HTMLDivElement | null) => {
    strip.current = el;
    showSelectedTab(el); // the sheet opened on this tab
  }, []);
  useEffect(() => showSelectedTab(strip.current), [active]); // a tab was picked
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
          <div
            ref={stripRef}
            role="tablist"
            aria-label="Thread tools"
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none]"
          >
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
                    "inline-flex h-9 pointer-coarse:h-11 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
