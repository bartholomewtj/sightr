// T33: reading a subagent's own conversation from the bridge, and keeping a view of it live.
//
// `GET /api/v2/thread/:threadId/item/:itemId/transcript` (bridge/threads/subagent-transcript.ts). The
// full read returns the agent's newest items in the thread's own item shape plus the log's `size`; a poll
// passes that size back and gets `{unchanged: true}` while the file has not grown. `?latest=1` returns only
// the agent's newest action, which is what a closed row shows.

import type { TurnItem } from "@shared/v2/contracts";
import { v2TranscriptPath } from "@shared/v2/contracts";
import { useEffect, useRef, useState } from "react";

import { noteIfLocked, XHR_HEADER, XHR_HEADER_VALUE } from "@/lib/api";
import { timedFetch } from "@v1/lib/conn-telemetry";

export interface TranscriptView {
  items: TurnItem[];
  size: number;
  running: boolean;
  /** The log's older part was cut: the view starts partway. */
  cutHead: boolean;
}

export interface LatestActivity {
  label: string;
  text: string;
}

export type TranscriptReply =
  | { unchanged: true; size: number }
  | ({ unchanged?: undefined } & TranscriptView);

export class TranscriptUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function get(threadId: string, itemId: string, query: string, signal?: AbortSignal): Promise<unknown> {
  const res = await timedFetch("read", () =>
    fetch(`${v2TranscriptPath(threadId, itemId)}${query}`, { headers: { [XHR_HEADER]: XHR_HEADER_VALUE }, signal }),
  );
  if (res.status === 404) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new TranscriptUnavailable(body?.error ?? "no-transcript");
  }
  if (!res.ok) {
    noteIfLocked(res);
    throw new Error(`transcript -> ${res.status}`);
  }
  return res.json();
}

export async function fetchTranscript(
  threadId: string,
  itemId: string,
  sinceSize: number | null,
  signal?: AbortSignal,
): Promise<TranscriptReply> {
  return (await get(threadId, itemId, sinceSize === null ? "" : `?size=${sinceSize}`, signal)) as TranscriptReply;
}

export async function fetchLatest(
  threadId: string,
  itemId: string,
  signal?: AbortSignal,
): Promise<{ latest: LatestActivity | null; running: boolean; toolCount: number }> {
  return (await get(threadId, itemId, "?latest=1", signal)) as { latest: LatestActivity | null; running: boolean; toolCount: number };
}

/** Why a transcript cannot be shown, in the words a person needs. */
export function transcriptUnavailableText(reason: string): string {
  switch (reason) {
    case "no-transcript":
      return "This agent's log isn't available yet. For a background agent it appears after the first check on it.";
    case "no-session-log":
      return "The session this agent ran in has no log Sightr can read.";
    case "unsupported-harness":
      return "This agent's harness doesn't keep a log Sightr can open.";
    default:
      return "The agent's log could not be opened.";
  }
}

export interface TranscriptState {
  view: TranscriptView | null;
  /** First load in flight. */
  loading: boolean;
  /** Set while the log cannot be read; polling goes on for a live agent, so it clears itself. */
  error: { reason: string; unavailable: boolean } | null;
}

const LIVE_POLL_MS = 2_000;

/**
 * The agent's conversation, loaded when `enabled`, and re-checked every 2 s while `live` (the agent is
 * running) and the page is visible. One last read runs when `live` turns off, so the end of the log shows.
 */
export function useSubagentTranscript(
  threadId: string,
  itemId: string,
  opts: { enabled: boolean; live: boolean; pollMs?: number },
): TranscriptState {
  const { enabled, live, pollMs = LIVE_POLL_MS } = opts;
  const [state, setState] = useState<TranscriptState>({ view: null, loading: true, error: null });
  const sizeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    sizeRef.current = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let failed = false;

    const tick = async () => {
      failed = false;
      try {
        const reply = await fetchTranscript(threadId, itemId, sizeRef.current, controller.signal);
        if (stopped) return;
        if (reply.unchanged) {
          setState((s) => (s.loading || s.error ? { ...s, loading: false, error: null } : s));
        } else {
          sizeRef.current = reply.size;
          setState({ view: reply, loading: false, error: null });
        }
      } catch (err) {
        if (stopped || (err as Error).name === "AbortError") return;
        failed = true;
        const unavailable = err instanceof TranscriptUnavailable;
        setState((s) => ({
          ...s,
          loading: false,
          error: { reason: unavailable ? err.reason : "failed", unavailable },
        }));
      }
      // A log that cannot be read yet (a background agent nobody has checked) is asked for less often.
      if (!stopped && live) timer = setTimeout(tick, document.visibilityState === "hidden" || failed ? pollMs * 4 : pollMs);
    };
    void tick();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [threadId, itemId, enabled, live, pollMs]);

  return state;
}

const ACTIVITY_POLL_MS = 6_000;

/** A running agent's newest action, polled while its row is on screen. Null until the first answer, and when none. */
export function useSubagentActivity(threadId: string | null, itemId: string, enabled: boolean): LatestActivity | null {
  const [latest, setLatest] = useState<LatestActivity | null>(null);
  useEffect(() => {
    if (!enabled || threadId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const tick = async () => {
      if (document.visibilityState !== "hidden") {
        try {
          const reply = await fetchLatest(threadId, itemId, controller.signal);
          if (!stopped) setLatest(reply.latest);
        } catch (err) {
          if (stopped || (err as Error).name === "AbortError") return;
          if (err instanceof TranscriptUnavailable) return; // nothing to show, and nothing will change: stop asking
        }
      }
      if (!stopped) timer = setTimeout(tick, ACTIVITY_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [threadId, itemId, enabled]);
  return latest;
}
