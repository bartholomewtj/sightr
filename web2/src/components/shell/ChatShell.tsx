import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Sidebar } from "@/components/Sidebar";
import { useLayout } from "@/hooks/useLayout";
import { SIDEBAR_MAX, SIDEBAR_MIN, useUiState } from "@/uiStateStore";

/**
 * The adaptive shell (T09).
 * - Desktop (>= 1024 px): Sidebar | Chat | RightPanel. The sidebar width drags between 200 and 480 px
 *   and is remembered; the right panel collapses. T10, T11/T12 and T13 fill the three regions.
 * - Phone: only the chat region (the route). The home route renders the sidebar itself; a thread is a
 *   full screen with a back button; right-panel tabs become sheets (T13).
 *
 * The chat region stays the same element in both layouts, so crossing 1024 px never remounts the open
 * thread (its stream stays open).
 */
export function ChatShell({ children }: { children: ReactNode }) {
  const desktop = useLayout() === "desktop";
  const width = useUiState((s) => s.sidebarWidth);
  const panelOpen = useUiState((s) => s.rightPanelOpen);
  const setPanelOpen = useUiState((s) => s.setRightPanelOpen);

  return (
    <div className="flex min-h-0 flex-1" data-layout={desktop ? "desktop" : "phone"}>
      {desktop ? (
        <aside data-region="sidebar" className="flex min-h-0 shrink-0 flex-col border-r" style={{ width }}>
          <Sidebar />
        </aside>
      ) : null}
      {desktop ? <SidebarResizer /> : null}
      <main data-region="chat" className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {desktop ? (
          <Button
            size="icon-sm"
            variant="ghost"
            className="absolute right-2 top-2 z-10"
            aria-label={panelOpen ? "Close the right panel" : "Open the right panel"}
            aria-pressed={panelOpen}
            onClick={() => setPanelOpen(!panelOpen)}
          >
            {panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </Button>
        ) : null}
        {children}
      </main>
      {desktop && panelOpen ? (
        <aside data-region="right-panel" aria-label="Right panel" className="flex min-h-0 w-80 shrink-0 flex-col border-l bg-card">
          {/* T13: Terminal, Files, Git. */}
        </aside>
      ) : null}
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
