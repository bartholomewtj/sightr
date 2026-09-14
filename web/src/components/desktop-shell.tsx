import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Outlet, useParams } from "react-router";
import { setSidebarPx, useDesktop } from "@/lib/desktop";
import { DesktopSidebar } from "@/components/desktop-sidebar";
import { useRouteLoaderData } from "react-router";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { useDesktopHotkeys } from "@/hooks/use-desktop-hotkeys";
import { ShortcutsSheet } from "@/components/shortcuts-sheet";

export function DesktopShell() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { paneId } = useParams();
  const { sidebarPx } = useDesktop();
  const shellRef = useRef<HTMLDivElement>(null);
  const [dragPx, setDragPx] = useState<number | null>(null);
  const dragging = useRef(false);
  useDesktopHotkeys({ agents: data.agents, currentPaneId: paneId });
  useEffect(() => {
    document.documentElement.classList.add("sightr-desktop");
    return () => document.documentElement.classList.remove("sightr-desktop");
  }, []);
  const width = dragPx ?? sidebarPx;
  const dragWidth = (clientX: number) => {
    const left = shellRef.current?.getBoundingClientRect().left ?? 0;
    return Math.min(480, Math.max(200, clientX - left));
  };
  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    dragging.current = true;
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* jsdom and older browsers may reject capture */ }
  }
  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragging.current) setDragPx(dragWidth(event.clientX));
  }
  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    setDragPx(null);
    setSidebarPx(dragWidth(event.clientX));
  }
  function cancelResize() { dragging.current = false; setDragPx(null); }
  return <>
    <div ref={shellRef} className="grid h-full min-h-0 flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden" style={{ gridTemplateColumns: `${width}px minmax(0,1fr)` }}>
    <div className="relative min-h-0 h-full"><DesktopSidebar data={data} currentPaneId={paneId} /><div role="separator" aria-label="Resize sidebar" className="absolute inset-y-0 right-[-2px] z-10 w-1 cursor-col-resize" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={cancelResize} /></div>
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden"><Outlet /></div>
    </div>
    <ShortcutsSheet />
  </>;
}
