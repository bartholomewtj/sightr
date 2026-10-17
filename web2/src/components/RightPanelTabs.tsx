/**
 * The desktop right panel (T13). Same job and name as T3 Code's
 * apps/web/src/components/RightPanelTabs.tsx @ e3b35d1b (pattern; MIT, see THIRD_PARTY.md): a tab strip
 * over the active surface, a drag handle on its left edge. T3's tabs are an open-ended list per thread
 * (browser, terminal, diff, files, PR…); Sightr's are three fixed tabs, Terminal, Files and Git, for the
 * open thread. Only the active tab's content is mounted, so closing the panel or switching tabs stops
 * that tab's network work.
 */
import { FilesIcon, GitBranchIcon, TerminalSquareIcon, XIcon } from "lucide-react";
import { useRef, type KeyboardEvent, type PointerEvent } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { shortcutLabelForCommand, KEYBINDINGS } from "@/keybindings";
import {
  RIGHT_PANEL_KINDS,
  RIGHT_PANEL_LABEL,
  RIGHT_PANEL_MAX,
  RIGHT_PANEL_MIN,
  useRightPanelStore,
  type RightPanelKind,
} from "@/rightPanelStore";
import { useThreadView, useThreadViewStore } from "@/threadViewStore";

import { FilesPanel } from "./right-panel/FilesPanel";
import { guardPanelLeave } from "./right-panel/leaveGuard";
import { GitPanel } from "./right-panel/GitPanel";
import { TerminalPanel } from "./right-panel/TerminalPanel";

export const RIGHT_PANEL_ICON: Record<RightPanelKind, typeof TerminalSquareIcon> = {
  terminal: TerminalSquareIcon,
  files: FilesIcon,
  git: GitBranchIcon,
};

/** The tab's content for a thread. Shared by the desktop panel and the phone sheet. */
export function RightPanelSurface({ kind, threadId }: { kind: RightPanelKind; threadId: string }) {
  if (kind === "terminal") return <TerminalSurface threadId={threadId} />;
  if (kind === "files") return <FilesPanel threadId={threadId} />;
  return <GitPanel threadId={threadId} />;
}

/**
 * The Terminal tab, unless the thread's main view is already the CLI (a thread with no transcript):
 * then a second mirror of the same pane would read it twice and race the first for ctrl+`.
 */
function TerminalSurface({ threadId }: { threadId: string }) {
  const { view } = useThreadView(threadId);
  const setView = useThreadViewStore((s) => s.setView);
  if (view !== "cli") return <TerminalPanel threadId={threadId} />;
  return (
    <div className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground" data-terminal-in-main="">
      <p>This thread's terminal is the main view.</p>
      <Button size="xs" variant="outline" onClick={() => setView(threadId, "thread")}>
        Show the thread there instead
      </Button>
    </div>
  );
}

const KEY_STEP = 16;

export function RightPanelTabs({ threadId }: { threadId: string | null }) {
  const active = useRightPanelStore((s) => s.activeSurfaceId);
  const width = useRightPanelStore((s) => s.width);
  const open = useRightPanelStore((s) => s.open);
  const close = useRightPanelStore((s) => s.close);
  const toggleLabel = shortcutLabelForCommand(KEYBINDINGS, "rightPanel.toggle");

  return (
    <aside
      data-region="right-panel"
      aria-label="Right panel"
      className="relative flex min-h-0 shrink-0 flex-col border-l bg-card"
      style={{ width }}
    >
      <RightPanelResizeHandle />
      <div role="tablist" aria-label="Right panel tabs" className="flex items-center gap-0.5 border-b px-1.5 py-1">
        {RIGHT_PANEL_KINDS.map((kind) => {
          const Icon = RIGHT_PANEL_ICON[kind];
          const selected = kind === active;
          return (
            <button
              key={kind}
              type="button"
              role="tab"
              id={`right-panel-tab-${kind}`}
              aria-selected={selected}
              aria-controls="right-panel-surface"
              onClick={() => (kind === active ? undefined : guardPanelLeave(() => open(kind)))}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm",
                selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {RIGHT_PANEL_LABEL[kind]}
            </button>
          );
        })}
        <span className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Close the right panel"
          title={toggleLabel ? `Close (${toggleLabel})` : "Close"}
          onClick={() => guardPanelLeave(close)}
        >
          <XIcon />
        </Button>
      </div>
      <div id="right-panel-surface" role="tabpanel" aria-labelledby={`right-panel-tab-${active}`} className="flex min-h-0 flex-1 flex-col">
        {threadId ? (
          <RightPanelSurface key={`${active}:${threadId}`} kind={active} threadId={threadId} />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">Open a thread</p>
        )}
      </div>
    </aside>
  );
}

/** T3's `RightPanelResizeHandle` placement (left edge), dragging 320–720 px; arrows when focused. */
function RightPanelResizeHandle() {
  const width = useRightPanelStore((s) => s.width);
  const setWidth = useRightPanelStore((s) => s.setWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    // Dragging left widens the panel.
    if (drag.current) setWidth(drag.current.width - (e.clientX - drag.current.x));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") setWidth(width + KEY_STEP);
    else if (e.key === "ArrowRight") setWidth(width - KEY_STEP);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the right panel"
      aria-valuemin={RIGHT_PANEL_MIN}
      aria-valuemax={RIGHT_PANEL_MAX}
      aria-valuenow={width}
      tabIndex={0}
      className="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none select-none outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-ring group-active:bg-primary/60"
      />
    </div>
  );
}
