/**
 * Self-heal for a timeline that has gone blank (reported on a phone: after a send the window showed
 * pages of empty space, the text sat above it, and only leaving the thread and coming back, or
 * scrolling up pages, brought it back).
 *
 * A virtualized list draws only the rows near the scroll position it believes in. When that belief and
 * the scroller disagree (a missed scroll, a row measured at a stale height), the scroller shows the gap
 * between rows and the list does not notice until something scrolls it. No row, header or footer frame
 * touches the visible band while the reader's hand is off the list: that is never a legitimate state,
 * whatever the list's own bookkeeping says. Fast flings blank a list for a moment, so the guard only
 * looks when the list has been still, and only acts when two looks in a row agree.
 *
 * It does not guess the cause: it does what the reader did by hand, and rebuilds the list at the end.
 */
import { useEffect, useRef } from "react";

/** How often the guard looks while the timeline is mounted. */
export const BLANK_CHECK_MS = 500;
/** The list must have been still (no scroll, no finger) this long before a look counts. */
export const BLANK_IDLE_MS = 400;
/** Looks in a row that must agree before the guard acts. */
export const BLANK_CONFIRM_LOOKS = 2;
/** After acting, wait this long before acting again, so a cause the rebuild cannot cure never loops. */
export const BLANK_COOLDOWN_MS = 5_000;

const SCROLLER_CLASS = "messages-timeline-scroll";
/** Everything the list draws that carries content: rows and the history header share this frame. */
const FRAME_CLASS = "messages-timeline-row-frame";

/**
 * True when the list's scroller is on screen and tall enough to have a band to fill, and no content
 * frame in it touches that band. A scroller with no size (hidden tab, collapsed pane) is not blank.
 */
export function viewportIsBlank(scroller: Element): boolean {
  const band = scroller.getBoundingClientRect();
  if (band.height < 1 || band.width < 1) return false;
  const frames = scroller.getElementsByClassName(FRAME_CLASS);
  if (frames.length === 0) return false; // nothing rendered yet: the list is still starting, not blank
  for (const frame of frames) {
    const rect = frame.getBoundingClientRect();
    if (rect.bottom > band.top && rect.top < band.bottom) return false;
  }
  return true;
}

export function useBlankViewportGuard(input: {
  /** The element around the list. */
  container: HTMLElement | null;
  /** Off while there are no rows to show (empty thread, skeleton). */
  enabled: boolean;
  /** Rebuild the list. */
  onBlank: () => void;
  now?: () => number;
  checkMs?: number;
}): void {
  const { container, enabled, checkMs = BLANK_CHECK_MS } = input;
  const now = input.now ?? Date.now;
  const onBlank = useRef(input.onBlank);
  onBlank.current = input.onBlank;
  const lastMotionAt = useRef(Number.NEGATIVE_INFINITY);
  const touching = useRef(false);

  useEffect(() => {
    if (!container) return;
    const motion = () => {
      lastMotionAt.current = now();
    };
    const down = () => {
      touching.current = true;
      motion();
    };
    const up = () => {
      touching.current = false;
      motion();
    };
    const opts = { capture: true, passive: true } as const;
    container.addEventListener("scroll", motion, opts);
    container.addEventListener("wheel", motion, opts);
    container.addEventListener("touchstart", down, opts);
    container.addEventListener("touchend", up, opts);
    container.addEventListener("touchcancel", up, opts);
    return () => {
      container.removeEventListener("scroll", motion, { capture: true });
      container.removeEventListener("wheel", motion, { capture: true });
      container.removeEventListener("touchstart", down, { capture: true });
      container.removeEventListener("touchend", up, { capture: true });
      container.removeEventListener("touchcancel", up, { capture: true });
    };
  }, [container, now]);

  useEffect(() => {
    if (!container || !enabled) return;
    let agreeing = 0;
    let actedAt = Number.NEGATIVE_INFINITY;
    const look = () => {
      const scroller = container.getElementsByClassName(SCROLLER_CLASS)[0];
      const still = !touching.current && now() - lastMotionAt.current >= BLANK_IDLE_MS;
      if (!scroller || document.hidden || !still || !viewportIsBlank(scroller)) {
        agreeing = 0;
        return;
      }
      agreeing += 1;
      if (agreeing < BLANK_CONFIRM_LOOKS || now() - actedAt < BLANK_COOLDOWN_MS) return;
      agreeing = 0;
      actedAt = now();
      onBlank.current();
    };
    const id = setInterval(look, checkMs);
    return () => clearInterval(id);
  }, [container, enabled, checkMs, now]);
}
