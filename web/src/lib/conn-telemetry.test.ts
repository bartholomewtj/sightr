import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { CONN_PATH } from "@shared/conn";
import {
  __pendingConn,
  __resetConnTelemetry,
  fetchClassOf,
  flushConn,
  noteConn,
  noteFetch,
  noteLive,
  noteTrouble,
  outcomeOfError,
  outcomeOfStatus,
  SESSION_ID,
  startConnTelemetry,
  timedFetch,
} from "./conn-telemetry";
import { latchLost, markLive } from "./connection-health";

function captureBatches(status = 204) {
  const batches: Array<Array<Record<string, unknown>>> = [];
  server.use(
    http.post(CONN_PATH, async ({ request }) => {
      batches.push(((await request.json()) as { events: Array<Record<string, unknown>> }).events);
      return new HttpResponse(null, { status });
    }),
  );
  return batches;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

describe("conn-telemetry", () => {
  beforeEach(() => {
    setVisibility("visible");
    __resetConnTelemetry();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetConnTelemetry();
  });

  it("classifies bridge requests", () => {
    expect(fetchClassOf("/api/snapshot")).toBe("snapshot");
    expect(fetchClassOf("/api/pane/w1%3Ap1?lines=50")).toBe("pane");
    expect(fetchClassOf("/api/pane/w1%3Ap1/history")).toBe("history");
    expect(fetchClassOf("/api/config")).toBe("read");
    expect(fetchClassOf("/api/pane/w1/reply", "POST")).toBe("write");
  });

  it("maps outcomes, and ignores a superseded fetch", () => {
    expect(outcomeOfStatus(200)).toBe("ok");
    expect(outcomeOfStatus(304)).toBe("ok");
    expect(outcomeOfStatus(403)).toBe("http4");
    expect(outcomeOfStatus(502)).toBe("http5");
    expect(outcomeOfError(new DOMException("t", "TimeoutError"))).toBe("timeout");
    expect(outcomeOfError(new TypeError("Failed to fetch"))).toBe("network");
    expect(outcomeOfError(new DOMException("a", "AbortError"))).toBeNull();
  });

  it("folds requests into one window event per flush", async () => {
    const batches = captureBatches();
    noteFetch("snapshot", "ok", 80);
    noteFetch("snapshot", "timeout", 10_000);
    noteFetch("pane", "network", 3);
    noteFetch("pane", null, 5);
    await flushConn();
    const window = batches.flat().find((e) => e.kind === "window");
    expect(window).toMatchObject({
      sid: SESSION_ID,
      stats: {
        snapshot: { n: 2, ok: 1, timeout: 1, maxMs: 10_000, buckets: [1, 0, 0, 0, 0, 0, 1, 0] },
        pane: { n: 1, network: 1, buckets: [0, 0, 0, 0, 0, 0, 0, 0] },
      },
    });
    expect(__pendingConn()).toEqual([]);
  });

  it("timedFetch records the status and passes the response through", async () => {
    const batches = captureBatches();
    server.use(http.get("/api/thing", () => new HttpResponse("x", { status: 503 })));
    const res = await timedFetch("read", () => fetch("/api/thing"));
    expect(res.status).toBe(503);
    await flushConn();
    expect(batches.flat().find((e) => e.kind === "window")).toMatchObject({ stats: { read: { n: 1, http5: 1 } } });
  });

  it("keeps the batch when the bridge cannot take it, and sends it next time", async () => {
    server.use(http.post(CONN_PATH, () => HttpResponse.error()));
    noteConn({ kind: "online", on: false });
    await flushConn();
    expect(__pendingConn().map((e) => e.kind)).toContain("online");
    expect(JSON.parse(localStorage.getItem("sightr.conn.pending") ?? "[]").length).toBeGreaterThan(0);
    const batches = captureBatches();
    await flushConn();
    expect(batches.flat().map((e) => e.kind)).toContain("online");
    expect(__pendingConn()).toEqual([]);
    expect(localStorage.getItem("sightr.conn.pending")).toBeNull();
  });

  it("holds the batch while locked (401)", async () => {
    captureBatches(401);
    noteConn({ kind: "lost" });
    await flushConn();
    expect(__pendingConn().map((e) => e.kind)).toContain("lost");
  });

  it("an amber stretch becomes one gap, marked red if it escalated", () => {
    vi.useFakeTimers();
    const anchor = Date.now();
    vi.advanceTimersByTime(4_000);
    noteTrouble(true, false, anchor);
    vi.advanceTimersByTime(11_000);
    noteTrouble(true, true, anchor);
    vi.advanceTimersByTime(5_000);
    noteTrouble(false, false, anchor);
    noteTrouble(false, false, anchor);
    expect(__pendingConn().filter((e) => e.kind === "gap")).toEqual([
      expect.objectContaining({ kind: "gap", ms: 20_000, lost: true, ended: "live" }),
    ]);
  });

  it("a wake reports how long until live data arrived", async () => {
    vi.useFakeTimers();
    captureBatches();
    startConnTelemetry();
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(60_000);
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1_200);
    noteLive(Date.now());
    noteLive(Date.now());
    expect(__pendingConn().filter((e) => e.kind === "wake")).toEqual([
      expect.objectContaining({ hiddenMs: 60_000, liveMs: 1_200 }),
    ]);
  });

  it("connection-health feeds it: a latch is one `lost`", () => {
    latchLost();
    latchLost();
    markLive();
    expect(__pendingConn().filter((e) => e.kind === "lost").length).toBe(1);
  });
});
