// Two-finger pinch on a scroller changes a number (the Terminal tab's font size) instead of zooming the
// page: the mirror's touch-action is `pan-x pan-y`, so the browser leaves pinch to us.

/** The value after a pinch that started at `startDist` px apart with `startValue`, now `dist` apart. */
export function pinchValue(startValue: number, startDist: number, dist: number, min: number, max: number): number {
  if (!(startDist > 0) || !Number.isFinite(dist)) return startValue;
  return Math.round(Math.min(max, Math.max(min, startValue * (dist / startDist))));
}

function distance(touches: TouchList): number {
  const a = touches[0]!;
  const b = touches[1]!;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export interface PinchOptions {
  get: () => number;
  set: (value: number) => void;
  min: number;
  max: number;
}

/** Listen for pinches on `el`; returns the detach function. */
export function attachPinchZoom(el: HTMLElement, opts: PinchOptions): () => void {
  let start: { dist: number; value: number } | null = null;
  const onStart = (e: TouchEvent) => {
    start = e.touches.length === 2 ? { dist: distance(e.touches), value: opts.get() } : null;
  };
  const onMove = (e: TouchEvent) => {
    if (!start || e.touches.length !== 2) return;
    const next = pinchValue(start.value, start.dist, distance(e.touches), opts.min, opts.max);
    if (next !== opts.get()) opts.set(next);
  };
  const onEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) start = null;
  };
  el.addEventListener("touchstart", onStart, { passive: true });
  el.addEventListener("touchmove", onMove, { passive: true });
  el.addEventListener("touchend", onEnd, { passive: true });
  el.addEventListener("touchcancel", onEnd, { passive: true });
  return () => {
    el.removeEventListener("touchstart", onStart);
    el.removeEventListener("touchmove", onMove);
    el.removeEventListener("touchend", onEnd);
    el.removeEventListener("touchcancel", onEnd);
  };
}
