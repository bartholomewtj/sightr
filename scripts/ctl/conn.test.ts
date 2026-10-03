import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyFetchStats, latencyBucket, type ConnLine, type FetchStats } from "../../shared/conn.ts";
import { analyseConn, bridgeStateDir, conn, dist, findCluster, formatConnReport, histPercentile, parseConnLog, parseSince, timeOf } from "./conn.ts";

const T0 = Date.parse("2026-10-01T00:00:00Z");
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();

/** A phone line at phone-time `at`, received by the bridge `lag` ms later. */
function phone(at: number, event: Record<string, unknown>, lag = 30_000): ConnLine {
  return { ts: iso(at + lag), src: "phone", at, sid: "s1", ...event } as unknown as ConnLine;
}
function bridge(t: number, event: Record<string, unknown>): ConnLine {
  return { ts: iso(t), src: "bridge", ...event } as unknown as ConnLine;
}
function stats(n: number, ms: number, over: Partial<FetchStats> = {}): FetchStats {
  const s = { ...emptyFetchStats(), n, ok: n, ...over };
  s.buckets[latencyBucket(ms)] = n - (over.network ?? 0);
  s.maxMs = ms;
  return s;
}

/** Ten hours of visible use in 5-minute windows, healthy unless a test adds trouble. */
function usage(hours = 10, snapshotMs = 120): ConnLine[] {
  const out: ConnLine[] = [phone(T0, { kind: "boot", platform: "android", standalone: true })];
  for (let t = T0 + 5 * MIN; t <= T0 + hours * 60 * MIN; t += 5 * MIN) {
    out.push(phone(t, { kind: "window", visibleMs: 5 * MIN, stats: { snapshot: stats(20, snapshotMs), pane: stats(200, 90) } }));
  }
  return out;
}
const run = (lines: ConnLine[]) => analyseConn(lines, { from: T0 - MIN, to: T0 + 24 * 60 * MIN });
const ids = (lines: ConnLine[]) => run(lines).findings.map((f) => f.id);

describe("primitives", () => {
  test("dist takes nearest-rank percentiles", () => {
    expect(dist([])).toEqual({ n: 0, p50: null, p95: null, max: null });
    expect(dist([5, 1, 3, 2, 4])).toEqual({ n: 5, p50: 3, p95: 5, max: 5 });
  });

  test("histogram percentiles are bucket upper edges", () => {
    expect(histPercentile([0, 0, 0, 0, 0, 0, 0, 0], 0.5)).toBeNull();
    expect(histPercentile([90, 0, 0, 0, 10, 0, 0, 0], 0.5)).toBe(100);
    expect(histPercentile([90, 0, 0, 0, 10, 0, 0, 0], 0.95)).toBe(2_500);
    expect(histPercentile([0, 0, 0, 0, 0, 0, 0, 3], 0.5)).toBeNull();
  });

  test("a cluster needs both a count and a share", () => {
    expect(findCluster([30_000, 31_000, 29_500, 30_200, 30_100, 4_000, 200_000])).toEqual({ atMs: 30_100, n: 5, of: 6 });
    expect(findCluster([10_000, 40_000, 90_000, 200_000, 600_000, 30_000])).toBeNull();
    expect(findCluster([30_000, 30_000, 30_000])).toBeNull();
  });

  test("parseSince takes relative spans and dates", () => {
    expect(parseSince("7d", T0)).toBe(T0 - 7 * 86_400_000);
    expect(parseSince("24h", T0)).toBe(T0 - 86_400_000);
    expect(parseSince("2026-09-01", T0)).toBe(Date.parse("2026-09-01"));
    expect(() => parseSince("lots", T0)).toThrow();
  });

  test("phone lines use the phone clock unless it is wildly off", () => {
    expect(timeOf(phone(T0, { kind: "lost" }))).toBe(T0);
    const skewed = { ...phone(T0, { kind: "lost" }), at: 5 } as ConnLine;
    expect(timeOf(skewed)).toBe(T0 + 30_000);
  });

  test("parseConnLog counts what it cannot read", () => {
    const text = [JSON.stringify(bridge(T0, { kind: "bridge.start", version: "x" })), "{broken", JSON.stringify({ ts: "x" }), ""].join("\n");
    const { lines, bad } = parseConnLog(text);
    expect(lines.length).toBe(1);
    expect(bad).toBe(2);
  });
});

describe("analyseConn", () => {
  test("a healthy week says so", () => {
    const r = run(usage());
    expect(r.phone.visibleHours).toBe(10);
    expect(r.gaps.availability).toBe(1);
    expect(r.fetch.snapshot.p95).toBe(250);
    expect(r.findings.map((f) => f.id)).toEqual(["healthy"]);
  });

  test("no phone lines is the first thing it says", () => {
    expect(ids([bridge(T0, { kind: "bridge.start", version: "x" })])[0]).toBe("no-phone-data");
  });

  test("gaps are blamed on a restart, on Herdr, or on the network", () => {
    const lines = [
      ...usage(),
      bridge(T0 + 60 * MIN, { kind: "bridge.start", version: "x" }),
      phone(T0 + 60 * MIN + 20_000, { kind: "gap", ms: 25_000, lost: true, ended: "live" }),
      bridge(T0 + 200 * MIN, { kind: "bridge.start", version: "x" }),
      phone(T0 + 200 * MIN + 20_000, { kind: "gap", ms: 25_000, lost: true, ended: "live" }),
      bridge(T0 + 120 * MIN, { kind: "herdr.down", err: "pipe" }),
      bridge(T0 + 122 * MIN, { kind: "herdr.up", downMs: 120_000 }),
      phone(T0 + 121 * MIN, { kind: "gap", ms: 50_000, lost: true, ended: "live" }),
      phone(T0 + 300 * MIN, { kind: "gap", ms: 6_000, lost: false, ended: "live", net: "3g" }),
    ];
    const r = run(lines);
    expect(r.gaps.byCause).toEqual({ restart: { n: 2, ms: 50_000 }, herdr: { n: 1, ms: 50_000 }, network: { n: 1, ms: 6_000 } });
    expect(r.gaps.red).toBe(3);
    expect(r.gaps.amber).toBe(1);
    expect(r.bridge.herdrDowns).toBe(1);
    expect(r.findings.map((f) => f.id)).toContain("herdr-down");
    expect(r.findings.map((f) => f.id)).toContain("restart-outages");
  });

  test("low availability is high severity", () => {
    const gaps = Array.from({ length: 12 }, (_, i) => phone(T0 + (i + 1) * 40 * MIN, { kind: "gap", ms: 2 * MIN, lost: true, ended: "live" }));
    const r = run([...usage(), ...gaps]);
    expect(r.gaps.availability).toBeCloseTo(0.96, 2);
    expect(r.findings[0]).toEqual(expect.objectContaining({ id: "availability", severity: "high" }));
  });

  test("streams dying at one age are an idle cut", () => {
    const drops = Array.from({ length: 8 }, (_, i) => phone(T0 + (i + 1) * 30 * MIN, { kind: "sse.drop", upMs: 100_000 + i * 500, opened: true }));
    const r = run([...usage(), ...drops]);
    expect(r.sse.cut?.n).toBe(8);
    expect(r.findings[0]).toEqual(expect.objectContaining({ id: "sse-cut", severity: "high" }));
    expect(r.findings[0]!.suggest).toContain("EVENT_KEEPALIVE_MS");
  });

  test("slow wakes and timeouts are named with the knob to turn", () => {
    const wakes = Array.from({ length: 10 }, (_, i) => phone(T0 + (i + 1) * 20 * MIN, { kind: "wake", hiddenMs: 600_000, liveMs: i < 4 ? 6_000 : 900 }));
    const timeouts = phone(T0 + 400 * MIN, { kind: "window", visibleMs: 0, stats: { pane: stats(400, 90, { ok: 100, timeout: 300 }) } });
    const r = run([...usage(), ...wakes, timeouts]);
    expect(r.wakes).toEqual(expect.objectContaining({ n: 10, overTrouble: 4, failed: 0 }));
    const f = r.findings.map((x) => x.id);
    expect(f).toContain("wake-slow");
    expect(f).toContain("pane-timeouts");
    expect(r.findings.find((x) => x.id === "pane-timeouts")!.suggest).toContain("GET_TIMEOUT_MS");
  });

  test("failed writes are high severity", () => {
    const w = phone(T0 + 400 * MIN, { kind: "window", visibleMs: 0, stats: { write: stats(20, 300, { ok: 18, network: 2 }) } });
    expect(run([...usage(), w]).findings[0]).toEqual(expect.objectContaining({ id: "write-fail", severity: "high" }));
  });

  test("lines outside the window are ignored", () => {
    const r = analyseConn([...usage(), phone(T0 - 10 * 86_400_000, { kind: "lost" })], { from: T0 - MIN, to: T0 + 86_400_000 });
    expect(r.lines.phone).toBe(usage().length);
  });

  test("the text report carries every section", () => {
    const text = formatConnReport(run([...usage(), phone(T0 + 60 * MIN, { kind: "gap", ms: 6_000, lost: false, ended: "live" })]));
    for (const s of ["Live ", "gaps:", "cause:", "Wake → live", "Stream (SSE)", "Bridge:", "requests", "snapshot", "Findings"]) expect(text).toContain(s);
  });
});

describe("sightr-ctl conn", () => {
  test("reads a file and prints JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-conn-"));
    try {
      const file = join(dir, "conn.log");
      const recent = Date.now() - 60 * MIN;
      await writeFile(file, [phone(recent, { kind: "lost" }), bridge(recent, { kind: "bridge.start", version: "x" })].map((l) => JSON.stringify(l)).join("\n"));
      const logs: string[] = [];
      const orig = console.log;
      console.log = (s: string) => logs.push(s);
      try {
        expect(await conn(["--file", file, "--json", "--since", "1d"])).toBe(0);
      } finally {
        console.log = orig;
      }
      const out = JSON.parse(logs.join("\n"));
      expect(out.lines).toEqual(expect.objectContaining({ phone: 1, bridge: 1 }));
      expect(out.files).toEqual([file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads the directory exec-bridge gives the bridge, unless Herdr named one", () => {
    expect(bridgeStateDir({ LOCALAPPDATA: "C:/L" }, "C:/home")).toBe(join("C:/L", "herdr", "plugins", "herdr.sightr"));
    expect(bridgeStateDir({ LOCALAPPDATA: "C:/L", SIGHTR_STATE_DIR: "C:/own" }, "C:/home")).toBe(join("C:/L", "herdr", "plugins", "herdr.sightr"));
    expect(bridgeStateDir({ HERDR_PLUGIN_STATE_DIR: "C:/herdr-said" }, "C:/home")).toBe("C:/herdr-said");
  });

  test("rejects unknown flags", async () => {
    await expect(conn(["--nope"])).rejects.toThrow("usage");
  });
});
