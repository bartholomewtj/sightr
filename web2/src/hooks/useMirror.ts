/**
 * The Terminal tab's live mirror (T13): the only place v2 reads `/api/pane/:id`. It reads only while
 * mounted, enabled and the page is visible; every 1.5 s while the operator types or the agent works
 * (`hot`), 4 s otherwise (v1's HOT_MS / COLD_MS idea, hooks/use-polling.ts). Unmounting aborts the
 * read in flight; a hidden page stops the timer and aborts too, and showing it again reads at once. A
 * 304 keeps the cached text (lib/api.ts `fetchPane`).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchPane } from "@/lib/api";

export const MIRROR_HOT_MS = 1_500;
export const MIRROR_COLD_MS = 4_000;

export interface MirrorState {
  text: string | null;
  error: string | null;
  /** A read is in flight and nothing has arrived yet. */
  loading: boolean;
  /** Read now (after a key press), then carry on at the usual pace. */
  refresh: () => void;
}

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function useMirror(paneId: string | null, opts: { hot: boolean; lines?: number; enabled?: boolean }): MirrorState {
  const { hot, lines, enabled = true } = opts;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const hotRef = useRef(hot);
  hotRef.current = hot;
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    setText(null);
    setError(null);
  }, [paneId]);

  useEffect(() => {
    if (!paneId || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let stopped = false;

    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      clear();
      if (stopped || pageHidden()) return;
      timer = setTimeout(tick, hotRef.current ? MIRROR_HOT_MS : MIRROR_COLD_MS);
    };
    function tick() {
      clear();
      if (stopped || pageHidden()) return;
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      setLoading(true);
      fetchPane(paneId!, lines, mine.signal)
        .then((res) => {
          if (mine.signal.aborted) return;
          setText(res.text);
          setError(null);
        })
        .catch((err: unknown) => {
          if (mine.signal.aborted || (err as { name?: string })?.name === "AbortError") return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (controller !== mine) return;
          controller = null;
          setLoading(false);
          schedule();
        });
    }
    const onVisibility = () => {
      if (pageHidden()) {
        clear();
        controller?.abort();
        controller = null;
        setLoading(false);
      } else {
        tick();
      }
    };
    kick.current = tick;
    document.addEventListener("visibilitychange", onVisibility);
    tick();
    return () => {
      stopped = true;
      kick.current = () => {};
      clear();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [paneId, lines, enabled]);

  const refresh = useCallback(() => kick.current(), []);
  return { text, error, loading: loading && text === null, refresh };
}
