import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { fetchHistory } from "@/lib/api";
import { mergeNewest } from "@/lib/transcript-merge";
import type { TranscriptEntry } from "@/lib/types";

export { mergeNewest };

// Last turns of a pane's transcript, stacked above the live mirror so a swipe up reads the
// conversation without leaving the pane. The live TUI always stays; there is no seam-cutter and
// the tail is never hidden. This is the only history view there is.
//
// Small pages, not one 5000-turn gulp: this sits on every pane open, and the live
// tail must paint first. Growing fetches the next page only when the reader reaches the top.
//
// The newest end is REFRESHED, not fetched once: a pane stays open for hours, and every turn the
// agent writes after open used to be invisible — scrolling up went from the 50-row live viewport
// straight into a snapshot from open time (and after `/clear`, into the previous session entirely).
// A status transition still refetches immediately, and a tick keeps the page fresh while the pane
// is open. Several harnesses keep the composer on screen, so Herdr reports idle/done during a
// turn; gating the tick on Working left jsonl writes unseen on every agent until the next real
// status flip. Cadence matches the open-pane dump poll (use-polling HOT_MS). The fresh page is
// spliced in by uuid: overlap replaces (a tool call picks up its result), the rest appends; no
// overlap at all means a different session, so the fresh page replaces the lot.

/** Turns fetched on pane open — a few screens, cheap enough to prefetch. */
export const INLINE_HISTORY_PAGE = 160;
/** Turns added per upward page. */
export const INLINE_HISTORY_STEP = 120;
/** Distance from the top of the scroller that triggers growth, in px. */
export const INLINE_GROW_THRESHOLD = 800;
/** How often the newest page is refetched while the pane is open, in ms. */
export const INLINE_REFRESH_MS = 1_500;
/** Extra refetch after working → idle/done, so the last turn is in the journal. Claude writes the
 *  jsonl line as the turn completes; the status flip can beat that write by a beat. */
export const INLINE_IDLE_RETRY_MS = 2000;

export type InlineHistoryUnavailable = "disabled" | "no-session" | "no-log" | "error";

function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && "name" in e && (e as { name?: unknown }).name === "AbortError";
}

export function useInlineHistory({
  paneId,
  enabled,
  status,
  getScrollElement,
}: {
  paneId: string;
  enabled: boolean;
  /** The pane's agent status; a change means new turns may exist and the newest page is refetched. */
  status?: string;
  getScrollElement: () => HTMLElement | null;
}) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState<InlineHistoryUnavailable | undefined>();

  const loadingRef = useRef(false);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const pendingRestore = useRef(false);
  // First paint inserts above a following tail and must NOT re-anchor (the auto-scroller pins).
  // Later pages insert above a scrolled-up reader and must.
  const seeded = useRef(false);
  // The first page has come back (with turns, empty, or unavailable) — refreshes may run from here.
  // Distinct from `seeded`, which an empty first page never sets.
  const primed = useRef(false);
  // Turn uuids dropped by `reset()` (a `/clear` was sent). The bridge may still hand back the OLD
  // session's page for a moment after the wipe; a fresh page overlapping these is that page, and is
  // ignored rather than resurrecting the conversation the operator just cleared.
  const staleIds = useRef<Set<string>>(new Set());

  const captureAnchor = () => {
    const el = getScrollElement();
    anchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    pendingRestore.current = true;
  };

  useEffect(() => {
    if (!enabled) {
      setEntries([]);
      setHasMore(false);
      setUnavailable(undefined);
      seeded.current = false;
      primed.current = false;
      return;
    }
    let cancelled = false;
    primed.current = false;
    staleIds.current = new Set();
    const ac = new AbortController();
    loadingRef.current = true;
    setLoading(true);
    fetchHistory(paneId, { limit: INLINE_HISTORY_PAGE }, ac.signal)
      .then((res) => {
        if (cancelled) return;
        if (!res.available) {
          setUnavailable(res.reason);
          setEntries([]);
          setHasMore(false);
          return;
        }
        setEntries(res.entries);
        setHasMore(res.hasMore);
        setUnavailable(undefined);
      })
      .catch((e) => {
        if (cancelled || isAbortError(e)) return;
        setUnavailable("error");
        setEntries([]);
        setHasMore(false);
      })
      .finally(() => {
        if (cancelled) return;
        loadingRef.current = false;
        primed.current = true;
        setLoading(false);
      });
    return () => {
      cancelled = true;
      ac.abort();
      loadingRef.current = false;
    };
  }, [enabled, paneId]);

  const loadOlder = useCallback(async () => {
    const oldest = entries[0]?.uuid;
    if (loadingRef.current || !hasMore || !oldest) return;
    captureAnchor();
    loadingRef.current = true;
    setLoading(true);
    try {
      const res = await fetchHistory(
        paneId,
        { limit: INLINE_HISTORY_STEP, before: oldest },
      );
      if (!res.available) {
        setHasMore(false);
        return;
      }
      setEntries((prev) => [...res.entries, ...prev]);
      setHasMore(res.hasMore);
    } catch (e) {
      if (!isAbortError(e)) setUnavailable("error");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [entries, getScrollElement, hasMore, paneId]);

  const refreshNewest = useCallback(async () => {
    if (loadingRef.current || !primed.current) return;
    loadingRef.current = true;
    try {
      const res = await fetchHistory(paneId, { limit: INLINE_HISTORY_PAGE });
      if (!res.available) return;
      if (res.entries.some((e) => staleIds.current.has(e.uuid))) return;
      staleIds.current = new Set();
      setEntries((prev) => {
        const merged = mergeNewest(prev, res.entries);
        if (merged === res.entries) setHasMore(res.hasMore);
        return merged;
      });
      setUnavailable(undefined);
    } catch {
      // A failed refresh keeps the last good page; the next trigger tries again.
    } finally {
      loadingRef.current = false;
    }
  }, [paneId]);

  const lastStatus = useRef(status);
  useEffect(() => {
    if (!enabled) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    if (lastStatus.current !== status) {
      lastStatus.current = status;
      void refreshNewest();
      if (status === "idle" || status === "done") {
        retry = setTimeout(() => void refreshNewest(), INLINE_IDLE_RETRY_MS);
      }
    }
    const id = setInterval(() => void refreshNewest(), INLINE_REFRESH_MS);
    return () => {
      if (retry) clearTimeout(retry);
      clearInterval(id);
    };
  }, [enabled, status, refreshNewest]);

  /**
   * Drop the loaded turns now — for when the operator sends `/clear` (or an alias). The agent has
   * wiped its context, so the conversation above the live tail is a different session's and would
   * otherwise sit there until the next status transition refetches. Nothing is refetched here: the
   * new session has no log yet, and an eager fetch would only bring the old page back. The next
   * status change (the first prompt of the new session) loads the new one.
   */
  const reset = useCallback(() => {
    setEntries((prev) => {
      staleIds.current = new Set(prev.map((e) => e.uuid));
      return [];
    });
    setHasMore(false);
    seeded.current = false;
    anchor.current = null;
    pendingRestore.current = false;
  }, []);

  const growUpward = useCallback(() => {
    if (hasMore) void loadOlder();
  }, [hasMore, loadOlder]);

  useLayoutEffect(() => {
    if (!seeded.current) {
      if (entries.length > 0 || unavailable) seeded.current = true;
      return;
    }
    if (!pendingRestore.current) return;
    pendingRestore.current = false;
    const a = anchor.current;
    const el = getScrollElement();
    if (a && el) el.scrollTop = a.top + (el.scrollHeight - a.height);
    anchor.current = null;
  }, [entries, getScrollElement, unavailable]);

  return { entries, loading, hasMore, growUpward, unavailable, reset };
}
