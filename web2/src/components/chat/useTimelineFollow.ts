/**
 * Follow mode for the timeline (T11). The approach of v1's `use-auto-scroll.ts`, on LegendList:
 * - following while the reader is within 80 px of the end (`resolveTimelineIsAtEnd`); the list then
 *   keeps itself pinned (`maintainScrollAtEnd`);
 * - only the READER's scroll up leaves follow mode (a wheel, a touch, a key or a drag on the list, just
 *   before the scroll); rows that arrive after that are counted for the "Jump to latest" pill
 *   (`countUnseenRows`);
 * - a scroll the reader did not make while following is content moving under the viewport (a stopped
 *   run's output unfolding, a send's rows landing, the composer growing): it re-pins to the end. Live
 *   2026-10-18 at 360 px: a stopped Pi run's output grew 273 px, the list's own scroll event read that
 *   as "left the end", and the next send landed under a "Jump to latest · 2 new" pill;
 * - jumping, or this client's own send (`followRequest` changes), re-follows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** How long after the reader's last wheel, touch or key a scroll still counts as theirs (momentum). */
export const USER_SCROLL_INTENT_MS = 1_500;

const INTENT_EVENTS = ["wheel", "touchstart", "touchmove", "touchend", "keydown", "pointerdown"] as const;
/** The list's scrolling element (MessagesTimeline's LegendList). */
const SCROLLER_CLASS = "messages-timeline-scroll";

import { resolveTimelineIsAtEnd, type MessagesTimelineRow, type TimelineEndState } from "./MessagesTimeline.logic";

/** Rows that count as "new" for the pill: not headers, dividers or the live tail. */
function rowCountsAsNew(row: MessagesTimelineRow): boolean {
  return row.kind === "message" || row.kind === "work" || row.kind === "work-toggle" || row.kind === "event" || row.kind === "turn-fold";
}

/**
 * Rows after the last one the reader had when they left follow mode. Rows above it (an older history
 * page) and rows that were already there do not count.
 */
export function countUnseenRows(rows: ReadonlyArray<MessagesTimelineRow>, seen: ReadonlySet<string> | null): number {
  if (!seen) return 0;
  let lastSeen = -1;
  rows.forEach((row, index) => {
    if (seen.has(row.id)) lastSeen = index;
  });
  return rows.slice(lastSeen + 1).filter((row) => !seen.has(row.id) && rowCountsAsNew(row)).length;
}

export interface TimelineFollow {
  following: boolean;
  unseenCount: number;
  onScroll: () => void;
  jumpToLatest: () => void;
}

export function useTimelineFollow(input: {
  rows: ReadonlyArray<MessagesTimelineRow>;
  readEndState: () => TimelineEndState | undefined;
  scrollToEnd: () => void;
  followRequest: number;
  /** The element around the list: the reader's wheel, touch and keys are heard here. */
  container?: HTMLElement | null;
  /**
   * Any scroll may leave follow mode (find is open and scrolls the list to a hit itself). Off by
   * default: only the reader's own scroll leaves it.
   */
  anyScrollLeaves?: boolean;
  now?: () => number;
}): TimelineFollow {
  const { rows, readEndState, scrollToEnd, followRequest, container, anyScrollLeaves = false } = input;
  const now = input.now ?? Date.now;
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const following = seen === null;

  const setFollow = useCallback((next: boolean) => {
    setSeen((prev) => {
      if (next) return null;
      return prev ?? new Set(rowsRef.current.map((row) => row.id));
    });
  }, []);

  // The reader's hand on the list: a finger down, or a wheel / key / drag a moment ago.
  const touching = useRef(false);
  const lastIntentAt = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (!container) return;
    const onIntent = (event: Event) => {
      // A press counts only on the scrolling element itself (its scrollbar), not on a row's button.
      if (event.type === "pointerdown" && !(event.target as Element | null)?.classList?.contains(SCROLLER_CLASS)) return;
      if (event.type === "touchstart") touching.current = true;
      if (event.type === "touchend") touching.current = false;
      lastIntentAt.current = now();
    };
    for (const type of INTENT_EVENTS) container.addEventListener(type, onIntent, { capture: true, passive: true });
    return () => {
      for (const type of INTENT_EVENTS) container.removeEventListener(type, onIntent, { capture: true });
    };
  }, [container, now]);

  const followingRef = useRef(following);
  followingRef.current = following;
  const onScroll = useCallback(() => {
    const atEnd = resolveTimelineIsAtEnd(readEndState());
    if (atEnd === undefined) return;
    if (atEnd) {
      setFollow(true);
      return;
    }
    const readerScrolled = touching.current || now() - lastIntentAt.current < USER_SCROLL_INTENT_MS;
    if (readerScrolled || anyScrollLeaves) {
      setFollow(false);
    } else if (followingRef.current) {
      // Content moved under a following reader: stay pinned.
      scrollToEnd();
    }
  }, [readEndState, setFollow, scrollToEnd, anyScrollLeaves, now]);

  const jumpToLatest = useCallback(() => {
    setFollow(true);
    scrollToEnd();
  }, [scrollToEnd, setFollow]);

  const lastFollowRequest = useRef(followRequest);
  useEffect(() => {
    if (followRequest === lastFollowRequest.current) return;
    lastFollowRequest.current = followRequest;
    jumpToLatest();
  }, [followRequest, jumpToLatest]);

  const unseenCount = useMemo(() => countUnseenRows(rows, seen), [rows, seen]);
  return { following, unseenCount, onScroll, jumpToLatest };
}
