// The phone's half of the connection trail (contract: shared/conn.ts; analysis: `sightr-ctl conn`).
//
// Module state in the lib/busy.ts idiom. Callers note what happened — a request's outcome and
// latency, a not-live gap, a wake, an SSE open or drop — and this batches it. Requests are folded
// into one per-class histogram per usage window, so a 1.5 s poll costs a counter bump, not a line.
// Every FLUSH_MS (and when the page hides) the batch goes to the bridge with a keepalive fetch.
// A batch that can't be sent (offline, locked, bridge down) waits in localStorage for the next one,
// so the outage that stopped it still gets reported once the link is back.
//
// Never touches the connection-health clock or the busy bar: telemetry is not a live poll.

import {
  CONN_MAX_EVENTS,
  CONN_PATH,
  emptyFetchStats,
  latencyBucket,
  type FetchClass,
  type FetchOutcome,
  type FetchStats,
  type PhoneEvent,
} from "@shared/conn";

export const FLUSH_MS = 5 * 60_000;
/** Most unsent events kept while the bridge is unreachable; the oldest go first. */
export const MAX_PENDING = 500;
const STORE_KEY = "sightr.conn.pending";

/** One id per page load. Also the SSE `client` id, so the bridge's stream lines join the phone's. */
export const SESSION_ID: string =
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type Distributive<T> = T extends unknown ? Omit<T, "at" | "sid" | "net"> : never;
export type ConnNote = Distributive<PhoneEvent>;

interface NetworkInformationLike extends EventTarget {
  type?: string;
  effectiveType?: string;
  rtt?: number;
  downlink?: number;
}

function connection(): NetworkInformationLike | undefined {
  return typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: NetworkInformationLike }).connection : undefined;
}

let pending: PhoneEvent[] = restore();
let stats: Partial<Record<FetchClass, FetchStats>> = {};
let visibleMs = 0;
let visibleSince: number | null = typeof document === "undefined" || document.visibilityState === "visible" ? Date.now() : null;
let hiddenAt: number | null = null;
let wake: { at: number; hiddenMs: number } | null = null;
/** When the page last came to the foreground; an episode never starts before it. */
let shownAt = 0;
let flushing = false;

function restore(): PhoneEvent[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as PhoneEvent[]).slice(-MAX_PENDING) : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    if (pending.length) localStorage.setItem(STORE_KEY, JSON.stringify(pending));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* private mode / quota: the batch still lives in memory */
  }
}

/** Record one event. Stamps the clock, the page-load id and the current network class. */
export function noteConn(note: ConnNote): void {
  const net = connection()?.effectiveType;
  pending.push({ ...note, at: Date.now(), sid: SESSION_ID, ...(net ? { net } : {}) } as PhoneEvent);
  if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
}

/** Which bucket a bridge request belongs to. */
export function fetchClassOf(path: string, method = "GET"): FetchClass {
  if (method.toUpperCase() !== "GET") return "write";
  const pathname = path.split("?")[0] ?? path;
  if (pathname === "/api/snapshot") return "snapshot";
  if (/^\/api\/pane\/[^/]+\/history$/.test(pathname)) return "history";
  if (/^\/api\/pane\/[^/]+$/.test(pathname)) return "pane";
  return "read";
}

/** Classify a fetch that threw. null = superseded on purpose (not a connection fact). */
export function outcomeOfError(err: unknown): FetchOutcome | null {
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError") return null;
  if (name === "TimeoutError") return "timeout";
  return "network";
}

export function outcomeOfStatus(status: number): FetchOutcome {
  if (status >= 500) return "http5";
  if (status >= 400) return "http4";
  return "ok";
}

/** Fold one request into the current window. `ms` is time to response headers. */
export function noteFetch(cls: FetchClass, outcome: FetchOutcome | null, ms: number): void {
  if (outcome === null) return;
  const s = (stats[cls] ??= emptyFetchStats());
  s.n += 1;
  s[outcome] += 1;
  if (outcome !== "network") {
    const bucket = latencyBucket(ms);
    s.buckets[bucket] = (s.buckets[bucket] ?? 0) + 1;
    if (ms > s.maxMs) s.maxMs = Math.round(ms);
  }
}

/**
 * Time a bridge request. Wraps the `fetch` call itself (to headers), so the body read and JSON
 * parse don't count against the network.
 */
export async function timedFetch(cls: FetchClass, run: () => Promise<Response>): Promise<Response> {
  const t0 = performance.now();
  try {
    const res = await run();
    noteFetch(cls, outcomeOfStatus(res.status), performance.now() - t0);
    return res;
  } catch (err) {
    noteFetch(cls, outcomeOfError(err), performance.now() - t0);
    throw err;
  }
}

/** Called by connection-health on every live stamp: closes a pending wake with its time-to-live. */
export function noteLive(now: number): void {
  if (!wake) return;
  noteConn({ kind: "wake", hiddenMs: wake.hiddenMs, liveMs: Math.max(0, now - wake.at) });
  wake = null;
}

let episode: { anchor: number; lost: boolean } | null = null;

/**
 * Called with what the connection banner shows. An episode opens when amber appears (measured from
 * `anchor`, the last live moment) and closes into a `gap` event when it clears or the page hides.
 */
export function noteTrouble(trouble: boolean, lost: boolean, anchor: number): void {
  if (trouble && !episode) episode = { anchor: Math.max(anchor, shownAt), lost };
  if (episode && lost) episode.lost = true;
  if (!trouble && episode) closeEpisode("live");
}

function closeEpisode(ended: "live" | "hidden"): void {
  if (!episode) return;
  noteConn({ kind: "gap", ms: Math.max(0, Date.now() - episode.anchor), lost: episode.lost, ended });
  episode = null;
}

function onVisibility(): void {
  const now = Date.now();
  if (document.visibilityState === "hidden") {
    if (visibleSince !== null) visibleMs += now - visibleSince;
    visibleSince = null;
    hiddenAt = now;
    closeEpisode("hidden");
    if (wake) {
      noteConn({ kind: "wake", hiddenMs: wake.hiddenMs, liveMs: null });
      wake = null;
    }
    void flushConn();
  } else {
    visibleSince = now;
    shownAt = now;
    if (hiddenAt !== null) wake = { at: now, hiddenMs: now - hiddenAt };
    hiddenAt = null;
  }
}

/** Close the current usage window into a `window` event (if anything happened in it). */
function closeWindow(): void {
  const now = Date.now();
  const visible = visibleMs + (visibleSince !== null ? now - visibleSince : 0);
  if (visibleSince !== null) visibleSince = now;
  visibleMs = 0;
  const any = Object.keys(stats).length > 0;
  if (any || visible > 0) noteConn({ kind: "window", visibleMs: visible, stats });
  stats = {};
}

/** Send everything pending. Failures keep the batch for next time; never throws. */
export async function flushConn(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    closeWindow();
    while (pending.length) {
      const batch = pending.slice(0, CONN_MAX_EVENTS);
      let ok = false;
      try {
        const res = await fetch(CONN_PATH, {
          method: "POST",
          keepalive: true,
          headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
          body: JSON.stringify({ events: batch }),
        });
        // 4xx other than lock/auth means the bridge will never take this batch — drop it.
        ok = res.ok || (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403);
      } catch {
        ok = false;
      }
      if (!ok) break;
      pending = pending.slice(batch.length);
    }
  } finally {
    flushing = false;
    persist();
  }
}

function noteNet(): void {
  const c = connection();
  if (!c) return;
  noteConn({ kind: "net", type: c.type ?? "unknown", eff: c.effectiveType ?? "unknown", rttMs: c.rtt ?? null, downMbps: c.downlink ?? null });
}

function platform(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Windows/.test(ua)) return "windows";
  if (/Mac OS X/.test(ua)) return "mac";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}

let started = false;

/** Start the recorder: boot line, network listeners, the flush timer. Idempotent. */
export function startConnTelemetry(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  const standalone = typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
  noteConn({ kind: "boot", platform: platform(), standalone });
  noteNet();
  connection()?.addEventListener("change", noteNet);
  window.addEventListener("online", () => noteConn({ kind: "online", on: true }));
  window.addEventListener("offline", () => noteConn({ kind: "online", on: false }));
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", () => void flushConn());
  window.setInterval(() => void flushConn(), FLUSH_MS);
  // Ship whatever an earlier page load could not send.
  window.setTimeout(() => void flushConn(), 10_000);
}

/** Test helper: the unsent queue, and a reset. */
export function __pendingConn(): readonly PhoneEvent[] {
  return pending;
}
export function __resetConnTelemetry(): void {
  pending = [];
  stats = {};
  visibleMs = 0;
  visibleSince = Date.now();
  hiddenAt = null;
  wake = null;
  episode = null;
  shownAt = 0;
  flushing = false;
}
