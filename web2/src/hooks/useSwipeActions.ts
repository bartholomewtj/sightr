/**
 * Horizontal swipe on a list row (T10, phone). Pointer events, read at start, move and end like v1's
 * `web/src/hooks/use-swipe.ts`, plus a vertical-scroll guard: in the first 10 px, a move that is more
 * vertical than horizontal gives the gesture back to the page and the row never moves.
 *
 * Past `REVEAL_PX` the row stays open on that side (its action buttons show); past the full distance
 * the side's first action runs. `swipeOutcome` is the pure decision, exported for tests.
 */
import { useRef, useState, type PointerEvent } from "react";

export const GUARD_PX = 10;
export const REVEAL_PX = 56;
export const FULL_SWIPE_PX = 160;

export type SwipeSide = "right" | "left";

export type SwipeOutcome = { kind: "none" } | { kind: "reveal"; side: SwipeSide } | { kind: "full"; side: SwipeSide };

/** What a release at `dx` means. `right` is a swipe to the right (positive dx). */
export function swipeOutcome(dx: number, width = 0): SwipeOutcome {
  const full = Math.max(FULL_SWIPE_PX, width * 0.6);
  const side: SwipeSide = dx > 0 ? "right" : "left";
  const dist = Math.abs(dx);
  if (dist >= full) return { kind: "full", side };
  if (dist >= REVEAL_PX) return { kind: "reveal", side };
  return { kind: "none" };
}

/** Decide in the first `GUARD_PX`: null while undecided, else whether the gesture is horizontal. */
export function swipeAxis(dx: number, dy: number): "x" | "y" | null {
  if (Math.abs(dx) < GUARD_PX && Math.abs(dy) < GUARD_PX) return null;
  return Math.abs(dy) > Math.abs(dx) ? "y" : "x";
}

export interface SwipeHandlers {
  onPointerDown(e: PointerEvent<HTMLElement>): void;
  onPointerMove(e: PointerEvent<HTMLElement>): void;
  onPointerUp(e: PointerEvent<HTMLElement>): void;
  onPointerCancel(e: PointerEvent<HTMLElement>): void;
}

export function useSwipeActions(options: {
  enabled: boolean;
  /** How many action buttons each side reveals. A swipe toward a side with none does not move. */
  sides: { right: number; left: number };
  onFull(side: SwipeSide): void;
}): { offset: number; revealed: SwipeSide | null; swiping: boolean; close(): void; handlers: SwipeHandlers } {
  const start = useRef<{ x: number; y: number; id: number; axis: "x" | "y" | null; width: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [revealed, setRevealed] = useState<SwipeSide | null>(null);
  const [swiping, setSwiping] = useState(false);

  const clamp = (dx: number) => {
    if (dx > 0 && options.sides.right === 0) return 0;
    if (dx < 0 && options.sides.left === 0) return 0;
    return dx;
  };

  const end = (e: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const s = start.current;
    start.current = null;
    setSwiping(false);
    if (!s || s.id !== e.pointerId || s.axis !== "x") return;
    const dx = clamp(e.clientX - s.x);
    const outcome = cancelled ? ({ kind: "none" } as SwipeOutcome) : swipeOutcome(dx, s.width);
    if (outcome.kind === "full") {
      setOffset(0);
      setRevealed(null);
      options.onFull(outcome.side);
    } else if (outcome.kind === "reveal") {
      setRevealed(outcome.side);
      setOffset(outcome.side === "right" ? REVEAL_PX * options.sides.right : -REVEAL_PX * options.sides.left);
    } else {
      setRevealed(null);
      setOffset(0);
    }
  };

  const handlers: SwipeHandlers = {
    onPointerDown(e) {
      if (!options.enabled || e.button > 0) return;
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: null, width: e.currentTarget.offsetWidth || 0 };
    },
    onPointerMove(e) {
      const s = start.current;
      if (!s || s.id !== e.pointerId) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (s.axis === null) {
        s.axis = swipeAxis(dx, dy);
        if (s.axis === "y") {
          start.current = null; // a scroll: hand it back
          return;
        }
        if (s.axis === "x") {
          setSwiping(true);
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }
      }
      if (s.axis === "x") setOffset(clamp(dx));
    },
    onPointerUp(e) {
      end(e, false);
    },
    onPointerCancel(e) {
      end(e, true);
    },
  };

  return {
    offset,
    revealed,
    swiping,
    close: () => {
      setRevealed(null);
      setOffset(0);
    },
    handlers,
  };
}
