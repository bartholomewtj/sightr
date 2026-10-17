/**
 * A touch long press (T10). Opens the row menu where a desktop has right click: iOS fires no
 * `contextmenu` on a long press, and Android's fires only on links. The click that ends a long press
 * must not activate the row, so `consumeClick()` is asked from the row's click handler. Any movement
 * past `MOVE_PX` (a scroll or a swipe) cancels the press.
 */
import { useCallback, useEffect, useRef, type PointerEvent } from "react";

export const LONG_PRESS_MS = 500;
const MOVE_PX = 10;

export function useLongPress(onPress: (target: HTMLElement) => void) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const callback = useRef(onPress);
  callback.current = onPress;

  const cancel = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  return {
    cancel,
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.pointerType !== "touch") return;
      const el = e.currentTarget;
      cancel();
      press.current = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          press.current = null;
          suppressClick.current = true;
          callback.current(el);
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > MOVE_PX) cancel();
    },
    /** True once after a long press fired: the caller swallows that click. */
    consumeClick(): boolean {
      const was = suppressClick.current;
      suppressClick.current = false;
      return was;
    },
  };
}
