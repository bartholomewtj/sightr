import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeEventSource } from "@/test/fake-event-source";
import { setVisibility, testDeps } from "@/test/stream-deps";

import { createConnection, PROBE_TIMEOUT_MS, WAKE_COALESCE_MS, type Connection } from "./connection";

// The phone wake / network-change paths of the shared SSE connection (T09 mobile resilience).

let conn: Connection | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
  FakeEventSource.reset();
});
afterEach(() => {
  conn?.stop();
  conn = null;
  vi.useRealTimers();
});

function start(over: Parameters<typeof testDeps>[0] = {}) {
  const deps = testDeps({ window, ...over });
  conn = createConnection({ url: () => "/x", frames: {} }, deps);
  conn.start();
  return { deps, es: FakeEventSource.latest() };
}

describe("connection wake events", () => {
  it("reconnects at once when the network comes back", () => {
    const { es } = start();
    es.emit("ping", {});
    window.dispatchEvent(new Event("online"));
    expect(es.closed).toBe(true);
    expect(FakeEventSource.open()).toHaveLength(1);
  });

  it("reconnects on a page restored from the back/forward cache, not on a plain pageshow", () => {
    const { es } = start();
    window.dispatchEvent(new Event("pageshow"));
    expect(es.closed).toBe(false);
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    window.dispatchEvent(restored);
    expect(es.closed).toBe(true);
    expect(FakeEventSource.open()).toHaveLength(1);
  });

  it("folds a burst of wake events into one reopen", async () => {
    start();
    setVisibility("visible");
    const first = FakeEventSource.latest();
    window.dispatchEvent(new Event("online"));
    setVisibility("visible");
    expect(FakeEventSource.latest()).toBe(first);
    expect(FakeEventSource.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(WAKE_COALESCE_MS);
    window.dispatchEvent(new Event("online"));
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("closes at once when the radio goes, then retries on the backoff", async () => {
    const { es } = start();
    es.emit("ping", {});
    window.dispatchEvent(new Event("offline"));
    expect(es.closed).toBe(true);
    const before = FakeEventSource.instances.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.instances.length).toBe(before + 1);
  });

  it("stops listening once stopped", () => {
    start();
    conn?.stop();
    const before = FakeEventSource.instances.length;
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("offline"));
    expect(FakeEventSource.instances).toHaveLength(before);
  });
});

describe("connection status probe", () => {
  it("does not let a probe that never answers hold the reconnect", async () => {
    const deps = testDeps({ window });
    deps.fetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    conn = createConnection({ url: () => "/x", frames: {} }, deps);
    conn.start();
    const es = FakeEventSource.latest();
    es.fail();
    const before = FakeEventSource.instances.length;
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(FakeEventSource.instances.length).toBe(before);
    // The timeout aborts the probe; the first backoff step then opens the next source.
    await vi.advanceTimersByTimeAsync(1_000 + 1);
    expect(FakeEventSource.instances.length).toBe(before + 1);
  });
});
