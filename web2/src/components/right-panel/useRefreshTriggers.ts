// The Git tab's refresh triggers (T13), moved out of GitPanel.tsx in T27 so the Diff panel shares them with
// the same behaviour: the thread's run ended (running to a final status), the page came back to the
// foreground after sleep or another app, and the network returned. Both panels also have a Refresh button,
// which calls the same `refresh`.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useThread } from "@/stream/stores";

const FINAL = new Set(["completed", "interrupted", "failed"]);

/** The newest run's id and status; a change from running to final means the run ended. */
export function useRunEnded(threadId: string, onEnd: () => void): void {
  const state = useThread(threadId);
  const latest = useMemo(() => {
    const runs = Object.values(state?.runs ?? {});
    return runs.length === 0 ? null : runs.reduce((a, b) => (b.ordinal > a.ordinal ? b : a));
  }, [state?.runs]);
  const seen = useRef<{ id: string; status: string } | null>(null);
  const fire = useRef(onEnd);
  fire.current = onEnd;
  useEffect(() => {
    const prev = seen.current;
    seen.current = latest ? { id: latest.id, status: latest.status } : null;
    if (!latest || !prev) return;
    if (prev.id === latest.id && prev.status === "running" && FINAL.has(latest.status)) fire.current();
  }, [latest?.id, latest?.status]);
}

/** Back from sleep or another app, and the network returning: what was read may have moved on meanwhile. */
export function useVisibilityRefresh(onRefresh: () => void): void {
  const fire = useRef(onRefresh);
  fire.current = onRefresh;
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") fire.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, []);
}

/**
 * A counter that rises on every trigger, and the function that raises it by hand. A panel puts `refreshes` in
 * the dependency list of its read (or hands it to a hook that refetches when it changes).
 */
export function useRefreshTriggers(threadId: string): { refreshes: number; refresh: () => void } {
  const [refreshes, setRefreshes] = useState(0);
  const refresh = useCallback(() => setRefreshes((n) => n + 1), []);
  useRunEnded(threadId, refresh);
  useVisibilityRefresh(refresh);
  return { refreshes, refresh };
}
