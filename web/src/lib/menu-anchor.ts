import type { MouseEvent as ReactMouseEvent } from "react";

/** Viewport point an actions sheet/popover anchors to. */
export interface MenuPoint { x: number; y: number }

/** Centre of an element — used by the ⋯ button, which has no pointer coordinates. */
export function anchorFrom(element: HTMLElement): MenuPoint {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** The event point, falling back to the target's rect when it has none. */
function menuPoint(e: ReactMouseEvent): MenuPoint {
  return e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : anchorFrom(e.currentTarget as HTMLElement);
}

/** Props for opening a row menu from right-click or Android's contextmenu. */
export function contextMenuProps(onMenu?: (at: MenuPoint) => void): {
  onContextMenu?: (e: ReactMouseEvent) => void;
} {
  if (!onMenu) return {};
  return { onContextMenu: (e) => { e.preventDefault(); onMenu(menuPoint(e)); } };
}
