import { useEffect, useRef, useState, type RefObject } from "react";

// A pull that starts at the top of a scroller and travels down past this many px refreshes in
// place. Below it, the gesture is a no-op (a tap, or a short drag). Same idea as BottomSheet's
// close threshold, a little shorter so a one-handed pull on a short card still lands.
export const PULL_THRESHOLD = 72;
// Ignore taps and jitter before the indicator appears.
const SLOP = 6;

export interface PullState {
  /** How far the finger has pulled down, in px. 0 when idle. */
  distance: number;
  /** Past the threshold: release will refresh. */
  ready: boolean;
  /** A refresh is in flight. */
  refreshing: boolean;
}

/**
 * Whether a downward touch that started at `scrollTop` should refresh.
 * A gesture that starts below the top, or one shorter than the threshold, does nothing.
 * Horizontal-dominant moves are rejected so a sideways drag never refreshes.
 */
export function isPullRefresh(
  scrollTopAtStart: number,
  dx: number,
  dy: number,
  threshold = PULL_THRESHOLD,
): boolean {
  return scrollTopAtStart <= 0 && dy >= threshold && dy > Math.abs(dx);
}

/**
 * In-app pull-to-refresh for one scroller. Engage only when the gesture starts at
 * `scrollTop === 0` and moves down. On release past the threshold, call `onRefresh` once.
 * Never reloads the page. Callers pass the route's `revalidate`.
 *
 * Touch listeners are non-passive so a downward pull at the top can `preventDefault` — that is
 * what keeps the browser from treating the gesture as its own reload. A gesture that starts
 * below the top falls through to normal scrolling.
 */
export function usePullToRefresh(
  scrollerRef: RefObject<HTMLElement | null>,
  onRefresh: () => void,
  /** False while a refresh is in flight, or when this scroller should not pull (desktop). */
  enabled = true,
): PullState {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [state, setState] = useState<PullState>({ distance: 0, ready: false, refreshing: false });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const el = scrollerRef.current;
    // Re-run when `enabled` flips. A scroller that mounts later (Spaces renders nothing on
    // desktop) would otherwise keep a listener aimed at an element that is no longer on screen.
    if (!el) return;
    const drag = { startX: 0, startY: 0, atTop: false, engaged: false, dx: 0, dy: 0 };

    const onStart = (e: TouchEvent) => {
      if (!enabledRef.current || stateRef.current.refreshing) return;
      const t = e.touches[0];
      if (!t) return;
      drag.startX = t.clientX;
      drag.startY = t.clientY;
      drag.atTop = el.scrollTop <= 0;
      drag.engaged = false;
      drag.dx = 0;
      drag.dy = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!drag.atTop || stateRef.current.refreshing) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - drag.startX;
      const dy = t.clientY - drag.startY;
      drag.dx = dx;
      drag.dy = dy;
      // A sideways-dominant move is a scroll or a selection, not a pull.
      if (!drag.engaged && dy > SLOP && dy > Math.abs(dx)) drag.engaged = true;
      if (!drag.engaged) return;
      if (dy > 0) e.preventDefault();
      const distance = Math.max(0, dy);
      setState({ distance, ready: distance >= PULL_THRESHOLD, refreshing: false });
    };
    const onEnd = () => {
      const { atTop, dx, dy } = drag;
      drag.atTop = false;
      drag.engaged = false;
      drag.dx = 0;
      drag.dy = 0;
      if (stateRef.current.refreshing) return;
      if (!isPullRefresh(atTop ? 0 : 1, dx, dy)) {
        setState({ distance: 0, ready: false, refreshing: false });
        return;
      }
      setState({ distance: 0, ready: false, refreshing: true });
      refreshRef.current();
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [scrollerRef, enabled]);

  // `enabled` goes false while the route revalidator is busy, then true again when it
  // returns to idle. Drop the indicator on that return, not on the idle state we started in.
  const sawBusy = useRef(false);
  useEffect(() => {
    if (!state.refreshing) {
      sawBusy.current = false;
      return;
    }
    if (!enabled) sawBusy.current = true;
    else if (sawBusy.current) setState({ distance: 0, ready: false, refreshing: false });
  }, [enabled, state.refreshing]);

  return state;
}
