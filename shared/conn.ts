// Connection telemetry: the wire contract between the phone, the bridge and `sightr-ctl conn`.
//
// The phone batches what IT experienced (fetch outcomes and latency, not-live gaps, wake-to-live,
// SSE sessions, network type) and POSTs it to CONN_PATH. The bridge validates every event against
// this file, stamps it, and appends it beside its own view (SSE attach/detach, Herdr link up/down,
// restarts) to `<stateDir>/conn.log`. `sightr-ctl conn` reads that file back and analyses it.
//
// ⛔ Timings, counts and enums only. No pane ids, no text, no URLs. `normalizePhoneEvent` rebuilds
// each event from an allowlist, so a field added on the phone is dropped until it is added here.

export const CONN_PATH = "/api/conn";
/** Most events the bridge accepts in one POST; the phone sends in chunks of this size. */
export const CONN_MAX_EVENTS = 100;
/** Byte cap on one POST body (well under the 64 KiB keepalive-fetch limit). */
export const CONN_MAX_BODY_BYTES = 48 * 1024;

/** Upper edges (ms) of the latency histogram; one more open-ended bucket follows the last edge. */
export const LATENCY_EDGES_MS = [100, 250, 500, 1000, 2500, 5000, 10_000] as const;
export const LATENCY_BUCKETS = LATENCY_EDGES_MS.length + 1;

export const FETCH_CLASSES = ["snapshot", "pane", "history", "read", "write"] as const;
export type FetchClass = (typeof FETCH_CLASSES)[number];
export const FETCH_OUTCOMES = ["ok", "http4", "http5", "timeout", "network"] as const;
export type FetchOutcome = (typeof FETCH_OUTCOMES)[number];

/** One request class over one usage window. `buckets` holds the latency of every outcome but `network`. */
export interface FetchStats {
  n: number;
  ok: number;
  http4: number;
  http5: number;
  timeout: number;
  network: number;
  buckets: number[];
  maxMs: number;
}

export function emptyFetchStats(): FetchStats {
  return { n: 0, ok: 0, http4: 0, http5: 0, timeout: 0, network: 0, buckets: new Array(LATENCY_BUCKETS).fill(0), maxMs: 0 };
}

export function latencyBucket(ms: number): number {
  const i = LATENCY_EDGES_MS.findIndex((edge) => ms <= edge);
  return i === -1 ? LATENCY_EDGES_MS.length : i;
}

/** Fields every phone event carries. `at` is the phone's clock; `sid` is one page load. */
interface PhoneBase {
  at: number;
  sid: string;
  /** navigator.connection.effectiveType when the browser exposes it ("4g", "3g"…); absent on iOS. */
  net?: string;
}

export type PhoneEvent = PhoneBase &
  (
    | { kind: "boot"; platform: string; standalone: boolean }
    /** One usage window: how long the page was visible, and every request it made meanwhile. */
    | { kind: "window"; visibleMs: number; stats: Partial<Record<FetchClass, FetchStats>> }
    /**
     * One stretch the operator saw "reconnecting…" (amber, TROUBLE_MS in) — `ms` from the last live
     * moment to recovery. `lost` = it escalated to red. `ended` "hidden" = the page went to the
     * background first, so `ms` is a lower bound.
     */
    | { kind: "gap"; ms: number; lost: boolean; ended: "live" | "hidden" }
    /** The 15 s escalation latched (red bar shown). */
    | { kind: "lost" }
    /** The page came back to the foreground. `liveMs` null = hidden again before anything was live. */
    | { kind: "wake"; hiddenMs: number; liveMs: number | null }
    | { kind: "sse.open"; connectMs: number }
    /** The EventSource errored. `upMs` 0 with `opened` false = it never opened. */
    | { kind: "sse.drop"; upMs: number; opened: boolean }
    | { kind: "online"; on: boolean }
    | { kind: "net"; type: string; eff: string; rttMs: number | null; downMbps: number | null }
  );

export type PhoneEventKind = PhoneEvent["kind"];

// ── Validation ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const SHORT_TOKEN = /^[A-Za-z0-9._-]{1,24}$/;
const SID = /^[A-Za-z0-9._-]{1,64}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function ms(v: unknown, max = 7 * DAY_MS): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : undefined;
}
function token(v: unknown): string | undefined {
  return typeof v === "string" && SHORT_TOKEN.test(v) ? v : undefined;
}
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 1_000_000) : 0;
}
function nullableNum(v: unknown, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v * 10) / 10, max) : null;
}

function normalizeStats(raw: unknown): FetchStats | undefined {
  if (!isObj(raw)) return undefined;
  const out = emptyFetchStats();
  for (const k of ["n", ...FETCH_OUTCOMES] as const) out[k] = count(raw[k]);
  if (Array.isArray(raw.buckets)) out.buckets = out.buckets.map((_, i) => count((raw.buckets as unknown[])[i]));
  out.maxMs = ms(raw.maxMs, 10 * 60_000) ?? 0;
  return out.n > 0 ? out : undefined;
}

/**
 * Rebuild one phone event from untrusted JSON, keeping only the fields this contract names. Returns
 * null for anything unrecognised, so a malformed or hostile batch costs nothing but its own lines.
 */
export function normalizePhoneEvent(raw: unknown): PhoneEvent | null {
  if (!isObj(raw)) return null;
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? Math.round(raw.at) : undefined;
  const sid = typeof raw.sid === "string" && SID.test(raw.sid) ? raw.sid : undefined;
  if (at === undefined || sid === undefined) return null;
  const net = token(raw.net);
  const base: PhoneBase = net ? { at, sid, net } : { at, sid };
  switch (raw.kind) {
    case "boot":
      return { ...base, kind: "boot", platform: token(raw.platform) ?? "other", standalone: raw.standalone === true };
    case "window": {
      const visibleMs = ms(raw.visibleMs, DAY_MS);
      if (visibleMs === undefined) return null;
      const stats: Partial<Record<FetchClass, FetchStats>> = {};
      if (isObj(raw.stats)) {
        for (const cls of FETCH_CLASSES) {
          const s = normalizeStats(raw.stats[cls]);
          if (s) stats[cls] = s;
        }
      }
      return { ...base, kind: "window", visibleMs, stats };
    }
    case "gap": {
      const gap = ms(raw.ms);
      if (gap === undefined) return null;
      return { ...base, kind: "gap", ms: gap, lost: raw.lost === true, ended: raw.ended === "hidden" ? "hidden" : "live" };
    }
    case "lost":
      return { ...base, kind: "lost" };
    case "wake": {
      const hiddenMs = ms(raw.hiddenMs, 30 * DAY_MS);
      if (hiddenMs === undefined) return null;
      return { ...base, kind: "wake", hiddenMs, liveMs: raw.liveMs === null ? null : (ms(raw.liveMs) ?? null) };
    }
    case "sse.open": {
      const connectMs = ms(raw.connectMs);
      return connectMs === undefined ? null : { ...base, kind: "sse.open", connectMs };
    }
    case "sse.drop": {
      const upMs = ms(raw.upMs);
      return upMs === undefined ? null : { ...base, kind: "sse.drop", upMs, opened: raw.opened === true };
    }
    case "online":
      return typeof raw.on === "boolean" ? { ...base, kind: "online", on: raw.on } : null;
    case "net":
      return {
        ...base,
        kind: "net",
        type: token(raw.type) ?? "unknown",
        eff: token(raw.eff) ?? "unknown",
        rttMs: nullableNum(raw.rttMs, 60_000),
        downMbps: nullableNum(raw.downMbps, 10_000),
      };
    default:
      return null;
  }
}

// ── What the bridge records itself ───────────────────────────────────────────

export type BridgeEvent =
  | { kind: "bridge.start"; version: string }
  | { kind: "sse.attach"; sid: string }
  /** `why`: the client went away (cancel), or the same page opened a newer stream (replaced). */
  | { kind: "sse.detach"; sid: string; upMs: number; why: "cancel" | "replaced" }
  | { kind: "herdr.down"; err: string }
  | { kind: "herdr.up"; downMs: number | null };

/** One line of `<stateDir>/conn.log`. `ts` is the bridge's clock at the moment it wrote the line. */
export type ConnLine = { ts: string; src: "bridge" | "phone"; device?: string } & (BridgeEvent | PhoneEvent);

export const CONN_LOG_FILENAME = "conn.log";
