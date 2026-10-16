import { useParams } from "@tanstack/react-router";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { CommandPalette } from "@/components/CommandPalette";
import { GlobalShortcuts } from "@/components/GlobalShortcuts";
import { KeyboardShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { RightPanelTabs } from "@/components/RightPanelTabs";
import { Sidebar } from "@/components/Sidebar";
import { useLayout } from "@/hooks/useLayout";
import { useRightPanelStore } from "@/rightPanelStore";
import { SIDEBAR_MAX, SIDEBAR_MIN, useUiState } from "@/uiStateStore";

/**
 * The adaptive shell (T09).
 * - Desktop (>= 1024 px): Sidebar | Chat | RightPanel. The sidebar width drags between 200 and 480 px
 *   and is remembered, and mod+b hides it; the right panel (T13: Terminal, Files, Git) drags between
 *   320 and 720 px and mod+alt+b collapses it. T10, T11/T12 and T13 fill the three regions.
 * - Phone: only the chat region (the route). The home route renders the sidebar itself; a thread is a
 *   full screen with a back button; right-panel tabs become sheets (T13).
 *
 * The chat region stays the same element in both layouts, so crossing 1024 px never remounts the open
 * thread (its stream stays open).
 */
export function ChatShell({ children }: { children: ReactNode }) {
  const desktop = useLayout() === "desktop";
  const width = useUiState((s) => s.sidebarWidth);
  const sidebarOpen = useUiState((s) => s.sidebarOpen);
  const setSidebarOpen = useUiState((s) => s.setSidebarOpen);
  const panelOpen = useRightPanelStore((s) => s.isOpen);
  const showPanel = useRightPanelStore((s) => s.show);
  const { threadId } = useParams({ strict: false }) as { threadId?: string };

  return (
    <div className="flex min-h-0 flex-1" data-layout={desktop ? "desktop" : "phone"}>
      <GlobalShortcuts />
      <CommandPalette />
      <KeyboardShortcutsDialog />
      {desktop && sidebarOpen ? (
        <aside data-region="sidebar" className="flex min-h-0 shrink-0 flex-col border-r" style={{ width }}>
          <Sidebar />
        </aside>
      ) : null}
      {desktop && sidebarOpen ? <SidebarResizer /> : null}
      <main data-region="chat" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {desktop && !sidebarOpen ? (
          <Button size="icon-sm" variant="ghost" className="absolute left-2 top-2 z-10" aria-label="Show the sidebar" onClick={() => setSidebarOpen(true)}>
            <PanelLeftOpen />
          </Button>
        ) : null}
        {desktop && !panelOpen ? (
          <Button size="icon-sm" variant="ghost" className="absolute right-2 top-2 z-10" aria-label="Open the right panel" onClick={showPanel}>
            <PanelRightOpen />
          </Button>
        ) : null}
        {children}
      </main>
      {desktop && panelOpen ? <RightPanelTabs threadId={threadId ?? null} /> : null}
    </div>
  );
}

const KEY_STEP = 16;

/** The drag handle between sidebar and chat: pointer drag, or arrow keys when focused. */
function SidebarResizer() {
  const width = useUiState((s) => s.sidebarWidth);
  const setWidth = useUiState((s) => s.setSidebarWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(drag.current.width + e.clientX - drag.current.x);
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") setWidth(width - KEY_STEP);
    else if (e.key === "ArrowRight") setWidth(width + KEY_STEP);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      className="w-1 shrink-0 cursor-col-resize touch-none bg-transparent outline-none hover:bg-border focus-visible:bg-ring"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
