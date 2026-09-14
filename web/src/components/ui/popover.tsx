import * as React from "react";

import { cn } from "@/lib/utils";
import { useDialogFocus, useInertBehind } from "@/components/ui/sheet";

export interface ActionPopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: { x: number; y: number } | null;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function ActionPopover({ open, onClose, anchor, title, children, className }: ActionPopoverProps): React.ReactElement | null {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const [position, setPosition] = React.useState({ left: 8, top: 8 });
  useDialogFocus(open, panelRef);
  useInertBehind(open, containerRef);

  React.useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const x = anchor?.x || 0;
    const y = anchor?.y || 0;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x || 8, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y || 8, window.innerHeight - rect.height - 8)),
    });
  }, [open, anchor]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={(node) => { panelRef.current = node; containerRef.current = node; }}
      data-testid="action-popover"
      role="dialog"
      tabIndex={-1}
      aria-labelledby={title ? titleId : undefined}
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      className={cn("fixed z-50 min-w-[13rem] max-w-[16rem] rounded-lg border-2 border-foreground bg-card p-2 shadow-lg", className)}
    >
      {title && <div id={titleId} className="px-1 pb-2 text-sm font-semibold">{title}</div>}
      {children}
    </div>
  );
}
