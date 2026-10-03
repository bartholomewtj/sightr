import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveStateDir } from "../../bridge/beacon/paths.ts";
import { EVENT_KEEPALIVE_MS } from "../../bridge/events-route.ts";
import {
  CONN_LOG_FILENAME,
  FETCH_CLASSES,
  FETCH_OUTCOMES,
  LATENCY_EDGES_MS,
  emptyFetchStats,
  type ConnLine,
  type FetchClass,
  type FetchStats,
} from "../../shared/conn.ts";
import { effectiveEnv } from "./env.ts";
import { defaultPluginStateDir } from "./paths.ts";
import { CtlError, realRun, type Run } from "./types.ts";

// `sightr-ctl conn` — read `<stateDir>/conn.log` (+ its rotated `.1`) and say how the connection
// has been, and what to change. The analysis is pure (analyseConn) so it is tested on fixtures and
// the /sightr-conn skill can take it as --json and compare runs over time.

/** Mirrors of the phone's thresholds (web/src/lib/connection-health.ts, web/src/lib/api.ts). */
export const TROUBLE_MS = 4_000;
export const CONNECTION_LOST_MS = 15_000;
export const GET_TIMEOUT_MS = 10_000;
/** A gap that starts this soon after a bridge start is blamed on the restart. */
const RESTART_BLAME_MS = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Dist { n: number; p50: number | null; p95: number | null; max: number | null }
export interface ClassReport {
  n: number; ok: number; http4: number; http5: number; timeout: number; network: number;
  /** Share of requests that failed at the transport (timeout + network) or with a 5xx. */
  failRate: number;
  /** Latency percentiles as histogram upper bounds in ms (null = above the last edge). */
  p50: number | null; p95: number | null; maxMs: number;
}
export type Severity = "high" | "medium" | "low" | "info";
export interface Finding { id: string; severity: Severity; title: string; evidence: string; suggest: string }
export type GapCause = "restart" | "herdr" | "network";

export interface ConnReport {
  window: { from: string; to: string; days: number };
  lines: { total: number; bad: number; phone: number; bridge: number };
  phone: { sessions: number; devices: string[]; platforms: Record<string, number>; visibleHours: number };
  fetch: Record<FetchClass, ClassReport>;
  gaps: {
    amber: number; red: number; ms: Dist; amberMs: number; redMs: number; endedHidden: number;
    perVisibleHour: number | null; availability: number | null;
    byCause: Record<GapCause, { n: number; ms: number }>;
    byHour: number[]; byNet: Record<string, { n: number; ms: number }>;
  };
  wakes: { n: number; liveMs: Dist; overTrouble: number; failed: number };
  sse: {
    opens: number; drops: number; neverOpened: number; connectMs: Dist; upMs: Dist; bridgeUpMs: Dist;
    dropsPerVisibleHour: number | null; cut: { atMs: number; n: number; of: number } | null;
  };
  bridge: { starts: string[]; herdrDowns: number; herdrDownMs: Dist };
  findings: Finding[];
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export function parseConnLog(text: string): { lines: ConnLine[]; bad: number } {
  const lines: ConnLine[] = [];
  let bad = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw) as ConnLine;
      if (typeof line?.ts === "string" && typeof line.kind === "string" && (line.src === "phone" || line.src === "bridge")) lines.push(line);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { lines, bad };
}

/** When the event happened: the phone's own clock for phone lines (batches arrive late), sanity-checked. */
export function timeOf(line: ConnLine): number {
  const ts = Date.parse(line.ts);
  if (line.src === "phone" && "at" in line && typeof line.at === "number" && Math.abs(line.at - ts) < 7 * DAY) return line.at;
  return ts;
}

/** `7d`, `24h`, `30m`, or an ISO date → epoch ms. */
export function parseSince(raw: string, now = Date.now()): number {
  const rel = /^(\d+)\s*([dhm])$/i.exec(raw.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase() === "d" ? DAY : rel[2]!.toLowerCase() === "h" ? HOUR : 60_000;
    return now - n * unit;
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) throw new CtlError(`--since: expected 7d, 24h, 30m or a date, got "${raw}"`, 2);
  return at;
}

// ── Statistics ────────────────────────────────────────────────────────────────

export function dist(values: number[]): Dist {
  if (!values.length) return { n: 0, p50: null, p95: null, max: null };
  const v = [...values].sort((a, b) => a - b);
  const at = (q: number) => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)]!;
  return { n: v.length, p50: at(0.5), p95: at(0.95), max: v[v.length - 1]! };
}

/** Percentile of a latency histogram, as the upper edge of the bucket it falls in (null = open bucket). */
export function histPercentile(buckets: number[], q: number): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = Math.ceil(q * total);
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i] ?? 0;
    if (seen >= target) return LATENCY_EDGES_MS[i] ?? null;
  }
  return null;
}

function mergeStats(into: FetchStats, s: FetchStats): void {
  into.n += s.n;
  for (const k of FETCH_OUTCOMES) into[k] += s[k];
  s.buckets.forEach((b, i) => { into.buckets[i] = (into.buckets[i] ?? 0) + b; });
  into.maxMs = Math.max(into.maxMs, s.maxMs);
}

function classReport(s: FetchStats): ClassReport {
  const failed = s.timeout + s.network + s.http5;
  return {
    n: s.n, ok: s.ok, http4: s.http4, http5: s.http5, timeout: s.timeout, network: s.network,
    failRate: s.n ? failed / s.n : 0,
    p50: histPercentile(s.buckets, 0.5), p95: histPercentile(s.buckets, 0.95), maxMs: s.maxMs,
  };
}

/**
 * The densest run of values within ±10% of each other. A stream that keeps dying at the same age is
 * something in the path timing it out; human app-switching does not cluster like that.
 */
export function findCluster(values: number[], minN = 5, minShare = 0.4): { atMs: number; n: number; of: number } | null {
  const v = values.filter((x) => x >= 5_000).sort((a, b) => a - b);
  if (v.length < minN) return null;
  let best = { i: 0, j: -1 };
  for (let i = 0, j = 0; i < v.length; i++) {
    while (j + 1 < v.length && v[j + 1]! <= v[i]! * 1.22) j++;
    if (j - i > best.j - best.i) best = { i, j };
  }
  const n = best.j - best.i + 1;
  if (n < minN || n / v.length < minShare) return null;
  return { atMs: v[best.i + Math.floor((n - 1) / 2)]!, n, of: v.length };
}

// ── Analysis ──────────────────────────────────────────────────────────────────

type L<K extends ConnLine["kind"]> = Extract<ConnLine, { kind: K }>;
const is = <K extends ConnLine["kind"]>(kind: K) => (l: ConnLine): l is L<K> => l.kind === kind;

export function analyseConn(all: ConnLine[], opts: { from: number; to: number; bad?: number }): ConnReport {
  const lines = all.filter((l) => { const t = timeOf(l); return t >= opts.from && t <= opts.to; }).sort((a, b) => timeOf(a) - timeOf(b));
  const phone = lines.filter((l) => l.src === "phone");
  const bridge = lines.filter((l) => l.src === "bridge");

  // Phone sessions, devices, platforms, visible time and request stats.
  const sessions = new Set<string>();
  const devices = new Set<string>();
  const platforms: Record<string, number> = {};
  for (const l of phone) {
    if ("sid" in l) sessions.add(l.sid);
    if (l.device) devices.add(l.device);
    if (l.kind === "boot") platforms[`${l.platform}${l.standalone ? " (pwa)" : ""}`] = (platforms[`${l.platform}${l.standalone ? " (pwa)" : ""}`] ?? 0) + 1;
  }
  const windows = phone.filter(is("window"));
  const visibleMs = windows.reduce((a, w) => a + w.visibleMs, 0);
  const visibleHours = visibleMs / HOUR;
  const perHour = (n: number) => (visibleHours >= 0.25 ? n / visibleHours : null);
  const merged = Object.fromEntries(FETCH_CLASSES.map((c) => [c, emptyFetchStats()])) as Record<FetchClass, FetchStats>;
  for (const w of windows) for (const c of FETCH_CLASSES) { const s = w.stats[c]; if (s) mergeStats(merged[c], s); }
  const fetch = Object.fromEntries(FETCH_CLASSES.map((c) => [c, classReport(merged[c])])) as Record<FetchClass, ClassReport>;

  // Bridge restarts and Herdr link episodes.
  const starts = bridge.filter(is("bridge.start")).map(timeOf);
  const herdrDown: Array<{ from: number; to: number }> = [];
  let downSince: number | null = null;
  for (const l of bridge) {
    if (l.kind === "herdr.down") downSince = timeOf(l);
    if (l.kind === "herdr.up" && downSince !== null) { herdrDown.push({ from: downSince, to: timeOf(l) }); downSince = null; }
  }
  if (downSince !== null) herdrDown.push({ from: downSince, to: opts.to });

  // Gaps the operator saw, and what most likely caused each.
  const gapLines = phone.filter(is("gap"));
  const byCause: Record<GapCause, { n: number; ms: number }> = { restart: { n: 0, ms: 0 }, herdr: { n: 0, ms: 0 }, network: { n: 0, ms: 0 } };
  const byHour = new Array<number>(24).fill(0);
  const byNet: Record<string, { n: number; ms: number }> = {};
  for (const g of gapLines) {
    const end = timeOf(g);
    const start = end - g.ms;
    const cause: GapCause = starts.some((s) => s >= start - 5_000 && s <= start + RESTART_BLAME_MS && s <= end)
      ? "restart"
      : herdrDown.some((d) => d.from <= end && d.to >= start) ? "herdr" : "network";
    byCause[cause].n++; byCause[cause].ms += g.ms;
    byHour[new Date(start).getHours()]!++;
    const net = g.net ?? "unknown";
    (byNet[net] ??= { n: 0, ms: 0 }).n++; byNet[net]!.ms += g.ms;
  }
  const red = gapLines.filter((g) => g.lost);
  const amber = gapLines.filter((g) => !g.lost);
  const gapMs = gapLines.reduce((a, g) => a + g.ms, 0);

  // Wakes.
  const wakes = phone.filter(is("wake"));
  const wakeLive = wakes.flatMap((w) => (w.liveMs === null ? [] : [w.liveMs]));

  // SSE.
  const opens = phone.filter(is("sse.open"));
  const drops = phone.filter(is("sse.drop"));
  const upMs = drops.filter((d) => d.opened).map((d) => d.upMs);
  const bridgeUp = bridge.filter(is("sse.detach")).filter((d) => d.why === "cancel").map((d) => d.upMs);

  const report: ConnReport = {
    window: { from: new Date(opts.from).toISOString(), to: new Date(opts.to).toISOString(), days: Math.round(((opts.to - opts.from) / DAY) * 100) / 100 },
    lines: { total: lines.length, bad: opts.bad ?? 0, phone: phone.length, bridge: bridge.length },
    phone: { sessions: sessions.size, devices: [...devices].sort(), platforms, visibleHours: Math.round(visibleHours * 100) / 100 },
    fetch,
    gaps: {
      amber: amber.length, red: red.length, ms: dist(gapLines.map((g) => g.ms)),
      amberMs: amber.reduce((a, g) => a + g.ms, 0), redMs: red.reduce((a, g) => a + g.ms, 0),
      endedHidden: gapLines.filter((g) => g.ended === "hidden").length,
      perVisibleHour: perHour(gapLines.length),
      availability: visibleMs > 0 ? Math.max(0, 1 - gapMs / visibleMs) : null,
      byCause, byHour, byNet,
    },
    wakes: { n: wakes.length, liveMs: dist(wakeLive), overTrouble: wakeLive.filter((ms) => ms >= TROUBLE_MS).length, failed: wakes.length - wakeLive.length },
    sse: {
      opens: opens.length, drops: drops.length, neverOpened: drops.filter((d) => !d.opened).length,
      connectMs: dist(opens.map((o) => o.connectMs)), upMs: dist(upMs), bridgeUpMs: dist(bridgeUp),
      dropsPerVisibleHour: perHour(drops.length), cut: findCluster(upMs),
    },
    bridge: { starts: starts.map((s) => new Date(s).toISOString()), herdrDowns: herdrDown.length, herdrDownMs: dist(herdrDown.map((d) => d.to - d.from)) },
    findings: [],
  };
  report.findings = findings(report);
  return report;
}

// ── Findings ──────────────────────────────────────────────────────────────────

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
export const secs = (ms: number | null) => (ms === null ? "—" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);
/** A histogram percentile: null is the open bucket past the last edge, not "no data". */
const hsecs = (ms: number | null, n: number) => (n === 0 ? "—" : ms === null ? `>${LATENCY_EDGES_MS[LATENCY_EDGES_MS.length - 1]! / 1000}s` : secs(ms));
const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

/** Rule-based reading of a report. Each finding names the knob or file to look at next. */
export function findings(r: ConnReport): Finding[] {
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);

  if (r.lines.phone === 0) {
    add({ id: "no-phone-data", severity: "high", title: "No phone telemetry in this window",
      evidence: `${r.lines.bridge} bridge lines, 0 phone lines.`,
      suggest: "Open Sightr on the phone after the bundle that carries telemetry is live (restart the bridge, reload the PWA). If it still stays empty, POST /api/conn is being refused: check the idle lock and SIGHTR_DEVICE_HEADER." });
  }

  const avail = r.gaps.availability;
  if (avail !== null && r.phone.visibleHours >= 1 && avail < 0.99) {
    add({ id: "availability", severity: avail < 0.97 ? "high" : "medium", title: `Live ${pct(avail)} of visible time`,
      evidence: `${r.gaps.amber + r.gaps.red} gaps (${r.gaps.red} red) over ${r.phone.visibleHours.toFixed(1)} h visible; red time ${secs(r.gaps.redMs)}.`,
      suggest: "See the cause split below: restarts and Herdr are fixable on the PC; network gaps point at the tailnet path or the phone." });
  }

  const totalGapMs = r.gaps.amberMs + r.gaps.redMs;
  const restart = r.gaps.byCause.restart;
  if (restart.n >= 2 && totalGapMs > 0 && restart.ms / totalGapMs >= 0.3) {
    add({ id: "restart-outages", severity: "medium", title: `Bridge restarts cause ${pct(restart.ms / totalGapMs)} of outage time`,
      evidence: `${restart.n} gaps began within ${RESTART_BLAME_MS / 1000}s of one of ${r.bridge.starts.length} bridge starts.`,
      suggest: "Run `sightr-ctl logs` for crash output. If the restarts are updates, cut them when the phone is idle; if crashes, fix the crash first." });
  }
  if (r.bridge.herdrDowns > 0) {
    const h = r.gaps.byCause.herdr;
    add({ id: "herdr-down", severity: h.ms > 60_000 ? "medium" : "info", title: `Herdr link dropped ${r.bridge.herdrDowns}×`,
      evidence: `Down p50 ${secs(r.bridge.herdrDownMs.p50)}, max ${secs(r.bridge.herdrDownMs.max)}; ${h.n} phone gaps overlap it.`,
      suggest: "Not the network: the bridge lost Herdr's socket. Check whether Herdr itself restarted (bridge/state-engine.ts poll errors in sightr-error.log)." });
  }

  if (r.sse.cut) {
    const near = Math.abs(r.sse.cut.atMs - EVENT_KEEPALIVE_MS) / EVENT_KEEPALIVE_MS < 0.25;
    add({ id: "sse-cut", severity: "high", title: `Snapshot streams die at ~${secs(r.sse.cut.atMs)}`,
      evidence: `${r.sse.cut.n} of ${r.sse.cut.of} stream drops (that had opened) ended within ±10% of the same age.`,
      suggest: near
        ? `That is the keep-alive period (EVENT_KEEPALIVE_MS = ${EVENT_KEEPALIVE_MS / 1000}s, bridge/events-route.ts): the first keep-alive is not getting through. Check that the proxy flushes SSE (x-accel-buffering).`
        : `Something in the path idle-times the stream. Lower EVENT_KEEPALIVE_MS (now ${EVENT_KEEPALIVE_MS / 1000}s, bridge/events-route.ts) well below ${secs(r.sse.cut.atMs)}, or find the timeout in tailscale serve / the fronting proxy.` });
  }
  const dph = r.sse.dropsPerVisibleHour;
  if (dph !== null && dph > 6 && !r.sse.cut) {
    add({ id: "sse-flap", severity: "medium", title: `Snapshot stream drops ${dph.toFixed(1)}×/visible hour`,
      evidence: `${r.sse.drops} drops, session p50 ${secs(r.sse.upMs.p50)}.`,
      suggest: "Each drop falls back to polling with a 1s→30s backoff (web/src/hooks/use-polling.ts). Compare with the gap causes: network drops point at the path, not the code." });
  }
  if (r.sse.drops >= 5 && r.sse.neverOpened / r.sse.drops > 0.5) {
    add({ id: "sse-never-opens", severity: "medium", title: "The snapshot stream mostly fails before it opens",
      evidence: `${r.sse.neverOpened} of ${r.sse.drops} drops never opened.`,
      suggest: "The phone is on the polling path. Check that GET /api/events reaches the bridge through the proxy unbuffered, and the idle lock is not refusing it." });
  }

  if (r.wakes.n >= 5 && r.wakes.liveMs.p95 !== null && r.wakes.liveMs.p95 >= TROUBLE_MS) {
    add({ id: "wake-slow", severity: r.wakes.overTrouble / r.wakes.n > 0.2 ? "medium" : "low",
      title: `Waking the app shows amber on ${pct(r.wakes.overTrouble / Math.max(1, r.wakes.n - r.wakes.failed))} of wakes`,
      evidence: `Wake → first live data p50 ${secs(r.wakes.liveMs.p50)}, p95 ${secs(r.wakes.liveMs.p95)} (amber at ${TROUBLE_MS / 1000}s).`,
      suggest: "Fire one snapshot GET the instant the page is visible rather than waiting for the EventSource to reopen (web/src/hooks/use-polling.ts visibility handler); the phone's radio may also be waking slowly." });
  }
  if (r.wakes.n >= 5 && r.wakes.failed / r.wakes.n > 0.1) {
    add({ id: "wake-fail", severity: "low", title: `${pct(r.wakes.failed / r.wakes.n)} of glances got no live data`,
      evidence: `${r.wakes.failed} of ${r.wakes.n} wakes went back to the background before anything live arrived.`,
      suggest: "Quick glances see only the cached herd. Faster first data after wake (see wake-slow) is the lever." });
  }

  for (const cls of ["snapshot", "pane"] as const) {
    const c = r.fetch[cls];
    if (c.n >= 50 && c.timeout >= 3 && c.timeout / c.n > 0.01) {
      add({ id: `${cls}-timeouts`, severity: "medium", title: `${pct(c.timeout / c.n)} of ${cls} reads time out`,
        evidence: `${c.timeout} of ${c.n} hit the ${GET_TIMEOUT_MS / 1000}s leash; p95 ${hsecs(c.p95, c.n)}.`,
        suggest: `Each one is up to ${GET_TIMEOUT_MS / 1000}s of a stale screen. If p95 is well under it, shorten GET_TIMEOUT_MS (web/src/lib/api.ts) so a black-holed read is retried sooner.` });
    }
    if (c.n >= 50 && (c.p95 === null || c.p95 >= 2_500)) {
      add({ id: `${cls}-slow`, severity: "medium", title: `${cls} reads are slow (p95 ${hsecs(c.p95, c.n)})`,
        evidence: `${c.n} requests; p50 ${hsecs(c.p50, c.n)}, max ${secs(c.maxMs)}.`,
        suggest: cls === "pane" ? "Check the pane read size (SIGHTR_READ_LINES) and whether the ETag 304 path is being hit." : "Check snapshot size and bridge CPU; the SSE path should carry most snapshots." });
    }
  }
  const w = r.fetch.write;
  if (w.n >= 10 && w.failRate > 0.02) {
    add({ id: "write-fail", severity: "high", title: `${pct(w.failRate)} of sends/actions failed in transit`,
      evidence: `${w.timeout} timeouts, ${w.network} network errors, ${w.http5} 5xx of ${w.n}.`,
      suggest: "A failed write may or may not have reached the terminal. Check the audit log around those times and whether the composer kept the draft." });
  }
  const http5 = FETCH_CLASSES.reduce((a, c) => a + r.fetch[c].http5, 0);
  const all = FETCH_CLASSES.reduce((a, c) => a + r.fetch[c].n, 0);
  if (all >= 100 && http5 / all > 0.01) {
    add({ id: "bridge-errors", severity: "medium", title: `${pct(http5 / all)} of requests got a 5xx`,
      evidence: `${http5} of ${all}.`, suggest: "Bridge-side failures, not the network: `sightr-ctl logs`." });
  }

  const aph = r.gaps.perVisibleHour === null ? null : r.gaps.amber / r.phone.visibleHours;
  if (aph !== null && aph > 1 && r.gaps.ms.p50 !== null && r.gaps.ms.p50 < 8_000) {
    add({ id: "amber-flicker", severity: "low", title: `Short amber blips, ${aph.toFixed(1)}/visible hour`,
      evidence: `${r.gaps.amber} amber gaps that recovered before red; p50 ${secs(r.gaps.ms.p50)}.`,
      suggest: `They clear on their own. Either find the cause (gap causes, net split) or raise TROUBLE_MS (${TROUBLE_MS / 1000}s, web/src/lib/connection-health.ts) so they stop showing.` });
  }

  const nets = Object.entries(r.gaps.byNet).filter(([k]) => k !== "unknown");
  if (nets.length >= 2) {
    const sorted = nets.sort((a, b) => b[1].n - a[1].n);
    add({ id: "net-split", severity: "info", title: "Gaps by network class",
      evidence: sorted.map(([k, v]) => `${k}: ${v.n} (${secs(v.ms)})`).join(", "),
      suggest: "Android reports effectiveType; iOS reports nothing (unknown). A slow class dominating points at coverage, not Sightr." });
  }

  if (!out.length && r.lines.phone > 0) {
    add({ id: "healthy", severity: "info", title: "Nothing anomalous", evidence: `${r.phone.visibleHours.toFixed(1)} h visible, ${r.gaps.amber + r.gaps.red} gaps.`, suggest: "Keep collecting; rates firm up over a longer window." });
  }
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

// ── Text report ───────────────────────────────────────────────────────────────

export function formatConnReport(r: ConnReport): string {
  const L: string[] = [];
  const row = (cells: string[], widths: number[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  L.push(`Sightr connection  ${r.window.from.slice(0, 16).replace("T", " ")} → ${r.window.to.slice(0, 16).replace("T", " ")} UTC (${r.window.days >= 1 ? `${r.window.days} d` : `${Math.round(r.window.days * 24)} h`})`);
  L.push(`lines ${r.lines.total} (phone ${r.lines.phone}, bridge ${r.lines.bridge}${r.lines.bad ? `, ${r.lines.bad} unreadable` : ""})`);
  const plats = Object.entries(r.phone.platforms).map(([k, v]) => `${k}×${v}`).join(", ") || "—";
  L.push(`phone: ${r.phone.sessions} page loads, ${r.phone.visibleHours.toFixed(1)} h visible; ${plats}${r.phone.devices.length ? `; devices ${r.phone.devices.join(", ")}` : ""}`);
  L.push("");

  const g = r.gaps;
  L.push(`Live ${g.availability === null ? "—" : pct(g.availability)} of visible time`);
  L.push(`  gaps: ${g.amber} amber, ${g.red} red; p50 ${secs(g.ms.p50)}, p95 ${secs(g.ms.p95)}, max ${secs(g.ms.max)}${g.endedHidden ? `; ${g.endedHidden} unresolved when hidden` : ""}`);
  L.push(`  cause: restart ${g.byCause.restart.n} (${secs(g.byCause.restart.ms)}), herdr ${g.byCause.herdr.n} (${secs(g.byCause.herdr.ms)}), network ${g.byCause.network.n} (${secs(g.byCause.network.ms)})`);
  if (g.amber + g.red > 0) {
    const peak = Math.max(...g.byHour);
    const bars = " ▁▂▃▄▅▆▇█";
    L.push(`  by hour (local) 00 ${g.byHour.map((n) => bars[peak ? Math.ceil((n / peak) * 8) : 0]).join("")} 23`);
  }
  L.push(`Wake → live: ${r.wakes.n} wakes; p50 ${secs(r.wakes.liveMs.p50)}, p95 ${secs(r.wakes.liveMs.p95)}; amber on ${r.wakes.overTrouble}; no data before hide ${r.wakes.failed}`);
  L.push(`Stream (SSE): ${r.sse.opens} opens (connect p50 ${secs(r.sse.connectMs.p50)}), ${r.sse.drops} drops (${r.sse.neverOpened} never opened); lived p50 ${secs(r.sse.upMs.p50)}; bridge-side p50 ${secs(r.sse.bridgeUpMs.p50)}`);
  L.push(`Bridge: ${r.bridge.starts.length} starts; Herdr link down ${r.bridge.herdrDowns}× (max ${secs(r.bridge.herdrDownMs.max)})`);
  L.push("");

  const widths = [9, 7, 7, 8, 8, 6, 7, 7, 7];
  L.push(row(["requests", "n", "fail", "timeout", "network", "5xx", "p50", "p95", "max"], widths));
  for (const c of FETCH_CLASSES) {
    const f = r.fetch[c];
    if (!f.n) continue;
    L.push(row([c, String(f.n), pct(f.failRate), String(f.timeout), String(f.network), String(f.http5), hsecs(f.p50, f.n), hsecs(f.p95, f.n), secs(f.maxMs)], widths));
  }
  L.push("");

  L.push("Findings");
  if (!r.findings.length) L.push("  (none)");
  for (const f of r.findings) {
    L.push(`  [${f.severity}] ${f.title}`);
    L.push(`      ${f.evidence}`);
    L.push(`      → ${f.suggest}`);
  }
  return L.join("\n");
}

// ── The verb ──────────────────────────────────────────────────────────────────

export async function readConnLog(stateDir: string): Promise<{ lines: ConnLine[]; bad: number; files: string[] }> {
  const out: ConnLine[] = [];
  let bad = 0;
  const files: string[] = [];
  for (const name of [`${CONN_LOG_FILENAME}.1`, CONN_LOG_FILENAME]) {
    const path = join(stateDir, name);
    try {
      const parsed = parseConnLog(await readFile(path, "utf8"));
      out.push(...parsed.lines);
      bad += parsed.bad;
      files.push(path);
    } catch { /* missing generation */ }
  }
  return { lines: out, bad, files };
}

/** The directory the running bridge writes to: exec-bridge's default when Herdr injected none. */
export function bridgeStateDir(effective: Record<string, string | undefined>, home = homedir()): string {
  return resolveStateDir({ ...effective, HERDR_PLUGIN_STATE_DIR: effective.HERDR_PLUGIN_STATE_DIR?.trim() || defaultPluginStateDir(effective, home) }, home);
}

/** `sightr-ctl conn [--since 7d|24h|DATE] [--json] [--file PATH]` */
export async function conn(args: string[], env = process.env, run: Run = realRun): Promise<number> {
  let since = "7d";
  let asJson = false;
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") asJson = true;
    else if (a === "--since") since = args[++i] ?? since;
    else if (a.startsWith("--since=")) since = a.slice(8);
    else if (a === "--file") file = args[++i];
    else if (a.startsWith("--file=")) file = a.slice(7);
    else throw new CtlError(`usage: sightr-ctl conn [--since 7d|24h|YYYY-MM-DD] [--json] [--file PATH]`, 2);
  }
  const now = Date.now();
  const from = parseSince(since, now);
  let lines: ConnLine[]; let bad: number; let files: string[];
  if (file) {
    const parsed = parseConnLog(await readFile(file, "utf8"));
    ({ lines, bad } = parsed); files = [file];
  } else {
    const { effective } = await effectiveEnv(env, run);
    ({ lines, bad, files } = await readConnLog(bridgeStateDir(effective)));
  }
  if (!files.length) {
    console.error("no conn.log yet in the bridge's state directory — it appears once a bridge with connection telemetry has run (SIGHTR_CONN_LOG is on by default).");
    return 1;
  }
  const report = analyseConn(lines, { from, to: now, bad });
  console.log(asJson ? JSON.stringify({ files, ...report }, null, 2) : formatConnReport(report));
  return 0;
}
