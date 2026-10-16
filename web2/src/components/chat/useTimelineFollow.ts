/**
 * Follow mode for the timeline (T11). The approach of v1's `use-auto-scroll.ts`, on LegendList:
 * - following while the reader is within 80 px of the end (`resolveTimelineIsAtEnd`); the list then
 *   keeps itself pinned (`maintainScrollAtEnd`);
 * - a scroll up leaves follow mode; rows that arrive after that are counted for the "Jump to latest"
 *   pill (`countUnseenRows`);
 * - jumping, or this client's own send (`followRequest` changes), re-follows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
}): TimelineFollow {
  const { rows, readEndState, scrollToEnd, followRequest } = input;
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

  const onScroll = useCallback(() => {
    const atEnd = resolveTimelineIsAtEnd(readEndState());
    if (atEnd !== undefined) setFollow(atEnd);
  }, [readEndState, setFollow]);

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
