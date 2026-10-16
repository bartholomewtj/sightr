import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import { applySnapshot, setSnapshotPushMode } from "@/lib/loaders";
import { openSnapshotStream } from "@/lib/api";
import { noteConn } from "@/lib/conn-telemetry";
import type { HomeData } from "@/lib/loaders";
import { useTyping } from "@/lib/typing";
import { SSE_KEEPALIVE_MS } from "@shared/limits";

// Adaptive polling, the React Router way: a timer that calls `revalidator.revalidate()`, which
// re-runs every active loader (snapshot + the open pane) — our equivalent of a refetch interval.
//  - fast (1.5s) while any agent is active OR a pane is open (you're watching it live), slow (4s)
//    when idle on the home screen with no active work;
//  - SSE is the snapshot path while connected. The interval skips GET /api/snapshot whenever the
//    EventSource is open (home and open pane). An open pane still ticks so the dump loader can
//    refresh /api/pane/...; root.shouldRevalidate refuses the snapshot GET on those ticks.
//  - skipped only while the tab is hidden (battery); it deliberately does NOT gate on
//    navigator.onLine (that flag lies on some phones and would wedge polling forever — see the tick),
//    and it's kicked immediately on focus/online/visibility as an accelerator.
const HOT_MS = 1500;
const COLD_MS = 4000;
// While the operator types into the open pane (lib/typing.ts), its mirror refreshes this often so
// the keystrokes show up quickly. Only the open pane's read runs at this pace; a read costs the
// bridge ~15 ms and comes back 304 when nothing moved.
export const TYPING_MS = 400;
// An open pane whose agent is working refreshes this often, so its output keeps up with the PC.
export const WORKING_PANE_MS = 750;

// Self-heal a wedged revalidation. Normally a tick no-ops while one is already in flight (see the
// idle fast-path below), but a black-holed fetch can stay `loading` forever (its timeout aside — the
// timer itself can freeze while the phone sleeps). Once a revalidation has been loading for longer
// than this — just past GET_TIMEOUT_MS (10s) as a belt-and-braces margin — a tick kicks a fresh
// revalidate() anyway: React Router aborts/supersedes the hung one (loaders treat that AbortError as
// "superseded"). We compare against wall-clock (Date.now), not a timer, precisely because timers can
// stop advancing during sleep — the age we care about is real elapsed time since the load began.
export const SUPERSEDE_MS = 12_000;

// The snapshot stream's lifecycle. Silent for SSE_STALE_MS (two keep-alives and some slack) means
// dead. A drop reconnects after a backoff that starts over only once a stream has stayed up for
// SSE_STABLE_MS, so a stream that opens and dies at once backs off instead of reconnecting every
// second (the bridge's EventPoker does the same on its side).
export const SSE_STALE_MS = 2 * SSE_KEEPALIVE_MS + 5_000;
export const SSE_STABLE_MS = 30_000;
const SSE_RETRY_MIN_MS = 1_000;
export const SSE_RETRY_MAX_MS = 30_000;
const SSE_WATCHDOG_TICK_MS = 5_000;

/**
 * Pure cadence resolver — exported so it can be unit-tested in isolation.
 *
 * Returns HOT_MS when:
 *   - Any agent anywhere in the herd is `working` or `blocked`, OR
 *   - A pane detail is open (paneId is set) and that pane exists in agents ∪ shellPanes.
 *     A shell you've drilled into is implicitly "live" regardless of its status.
 *
 * Returns COLD_MS otherwise (home screen, idle herd, no pane open).
 *
 * Returns WORKING_PANE_MS when the open pane's own agent is working or blocked, and TYPING_MS,
 * faster still, while the operator is typing into an open pane that exists.
 */
export function intervalFor(data: HomeData | undefined, paneId?: string | null, typing = false): number {
  if (paneId) {
    const open = [...(data?.agents ?? []), ...(data?.shellPanes ?? [])].find((p) => p.paneId === paneId);
    if (open && typing) return TYPING_MS;
    if (open && (open.status === "working" || open.status === "blocked")) return WORKING_PANE_MS;
  }
  const anyActive = data?.agents.some((a) => a.status === "blocked" || a.status === "working");
  if (anyActive) return HOT_MS;

  if (paneId) {
    const allPanes = [...(data?.agents ?? []), ...(data?.shellPanes ?? [])];
    if (allPanes.some((p) => p.paneId === paneId)) return HOT_MS;
  }

  return COLD_MS;
}

export function usePolling(data: HomeData | undefined, paneId?: string | null): void {
  const revalidator = useRevalidator();
  const [pushConnected, setPushConnected] = useState(false);
  const retry = useRef<number | undefined>(undefined);

  // SSE is opportunistic: an older bridge, a proxy that does not stream, or a dropped connection
  // simply returns to the polling path. A snapshot event always revalidates (home and open pane)
  // so the tree, header, and dump stay on the same poke. One stream serves the whole app: it carries
  // the herd, not the open pane, so opening a pane does not reconnect it.
  useEffect(() => {
    let source: EventSource | undefined;
    let stopped = false;
    let delay = SSE_RETRY_MIN_MS;
    // When the current stream opened (null until it does), and when the bridge last wrote to it.
    let openedAt: number | null = null;
    let lastBeat = 0;
    const cancelRetry = () => {
      if (retry.current !== undefined) { clearTimeout(retry.current); retry.current = undefined; }
    };
    const close = () => {
      source?.close(); source = undefined; openedAt = null;
      setSnapshotPushMode(false); setPushConnected(false);
    };
    // Connection telemetry: how long the stream lived before it dropped, and whether it went silent.
    const drop = (stale: boolean) => {
      const upMs = openedAt === null ? 0 : Date.now() - openedAt;
      noteConn({ kind: "sse.drop", upMs, opened: openedAt !== null, ...(stale ? { stale: true as const } : {}) });
      if (upMs >= SSE_STABLE_MS) delay = SSE_RETRY_MIN_MS;
      close();
      if (stopped) return;
      // The screen may already be a whole silence old, so fetch now rather than at the next tick.
      if (ref.current.state === "idle") ref.current.revalidate();
      retry.current = window.setTimeout(open, delay);
      delay = Math.min(delay * 2, SSE_RETRY_MAX_MS);
    };
    const open = () => {
      cancelRetry();
      close();
      if (stopped || document.hidden || typeof EventSource !== "function") return;
      const dialedAt = Date.now();
      // Callbacks check they still belong to the current stream: a late error from one already
      // replaced must not close its successor.
      const s = openSnapshotStream((snapshot) => {
        applySnapshot(snapshot);
        if (ref.current.state === "idle") ref.current.revalidate();
      }, () => { if (source === s) drop(false); }, () => { if (source === s) lastBeat = Date.now(); });
      source = s;
      s.addEventListener("open", () => {
        if (source !== s) return;
        openedAt = lastBeat = Date.now();
        noteConn({ kind: "sse.open", connectMs: openedAt - dialedAt });
        setSnapshotPushMode(true); setPushConnected(true);
      });
    };
    // While the stream is open the home screen stops polling, so a stream that dies without an error
    // (a 4G NAT or a tailnet route dropping the flow, which a receive-only socket never notices) would
    // leave a stale herd on screen with nothing saying so. The bridge writes at least every
    // SSE_KEEPALIVE_MS; a stream silent for SSE_STALE_MS is treated as dropped.
    const watchdog = window.setInterval(() => {
      if (openedAt !== null && !document.hidden && Date.now() - lastBeat > SSE_STALE_MS) drop(true);
    }, SSE_WATCHDOG_TICK_MS);
    const visibility = () => {
      if (document.hidden) { cancelRetry(); close(); } else open();
    };
    // The network is back: reconnect now instead of waiting out a backoff of up to SSE_RETRY_MAX_MS.
    const online = () => { if (openedAt === null) open(); };
    open();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
    return () => {
      stopped = true;
      cancelRetry();
      clearInterval(watchdog);
      close();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
    };
  }, []);
  // Hold the revalidator in a ref so the effect only re-subscribes when the cadence changes,
  // not on every revalidation (its identity flips each cycle).
  const ref = useRef(revalidator);
  ref.current = revalidator;

  // Wall-clock timestamp of when the current revalidation began, or null when idle. Stamped on the
  // idle→loading edge and cleared on →idle, so a tick can tell how long a load has been in flight
  // (used to detect and supersede a wedged one). A ref, not state — it must not trigger re-renders.
  const loadingSince = useRef<number | null>(null);
  if (revalidator.state === "loading") {
    if (loadingSince.current === null) loadingSince.current = Date.now();
  } else {
    loadingSince.current = null;
  }

  const typing = useTyping();
  const ms = intervalFor(data, paneId, typing);

  useEffect(() => {
    if (pushConnected && !paneId) return;
    const tick = () => {
      if (document.hidden) return;
      // Deliberately NO navigator.onLine gate here. On some phones the flag lies — it stuck FALSE
      // after an airplane-mode toggle even though the network was back — and gating the tick on it
      // wedged polling permanently: the app froze on "not connected" with a resting mark
      // and a stale mirror forever, because it never fetched again to discover the network had returned. A
      // failed fetch on a genuinely dead connection is cheap and self-heals the instant it's back; the
      // focus/online/visibility listeners below only accelerate that first beat. Never STOP fetching
      // because a possibly-lying flag says offline.
      const r = ref.current;
      if (r.state === "idle") {
        r.revalidate();
        return;
      }
      // Already loading: normally we leave it be, but a revalidation stuck past SUPERSEDE_MS is
      // almost certainly a black-holed fetch — kick a fresh one to supersede it and self-heal.
      const since = loadingSince.current;
      if (since !== null && Date.now() - since >= SUPERSEDE_MS) r.revalidate();
    };
    const id = window.setInterval(tick, ms);
    const onWake = () => tick();
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, pushConnected, paneId]);
}
