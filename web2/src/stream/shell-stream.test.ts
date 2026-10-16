import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __pendingConn, SESSION_ID } from "@v1/lib/conn-telemetry";

import { FakeEventSource } from "@/test/fake-event-source";
import { renamed, shellSnapshot, thread } from "@/test/fixtures";
import { blockingResponse, setVisibility, testDeps } from "@/test/stream-deps";

import { backoffBase, jittered, SILENCE_MS } from "./connection";
import { createShellStream, type ShellStream } from "./shell-stream";
import { useBridgeInfo, useShell, useStreamHealth } from "./stores";

let stream: ShellStream | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
});
afterEach(() => {
  stream?.stop();
  stream = null;
  vi.useRealTimers();
});

function start(deps = testDeps()) {
  stream = createShellStream(deps);
  stream.start();
  return { deps, es: FakeEventSource.latest() };
}

/** Let the post-error probe settle so the reconnect timer is armed. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("shell stream", () => {
  it("opens with the page's client id and no cursor", () => {
    const { es } = start();
    const url = new URL(es.url, "http://x");
    expect(url.pathname).toBe("/api/v2/shell");
    expect(url.searchParams.get("client")).toBe(SESSION_ID);
    expect(es.after).toBeNull();
  });

  it("applies a snapshot, then events above its sequence only", () => {
    const { es } = start();
    es.emit("snapshot", shellSnapshot(10));
    es.emit("synchronized", { sequence: 10 });
    es.emit("event", renamed(11, "t1", "first"));
    es.emit("event", renamed(11, "t1", "duplicate"));
    es.emit("event", renamed(7, "t1", "stale"));
    expect(useShell.getState()).toMatchObject({ loaded: true, sequence: 11 });
    expect(useShell.getState().threads.t1?.title).toBe("first");
    expect(useStreamHealth.getState().status).toBe("live");
  });

  it("reads the herdr link from the snapshot, synchronized and ping, and the device from the snapshot (T12)", () => {
    const { es } = start();
    es.emit("snapshot", { ...shellSnapshot(10), herdr: "connected", device: { enforced: true, device: "laptop", authorized: false } });
    expect(useBridgeInfo.getState()).toEqual({ herdr: "connected", readOnly: true });
    es.emit("ping", { sequence: 10, herdr: "disconnected" });
    expect(useBridgeInfo.getState().herdr).toBe("disconnected");
    es.emit("synchronized", { sequence: 10, herdr: "connected" });
    expect(useBridgeInfo.getState().herdr).toBe("connected");
    es.emit("snapshot", shellSnapshot(11));
    expect(useBridgeInfo.getState().readOnly).toBe(false);
  });

  it("resumes from the last sequence after a reconnect", async () => {
    const { es } = start();
    es.emit("snapshot", shellSnapshot(10));
    es.emit("event", renamed(14, "t1", "x"));
    es.fail();
    expect(es.closed).toBe(true);
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    const next = FakeEventSource.latest();
    expect(next).not.toBe(es);
    expect(next.after).toBe(14);
    expect(new URL(next.url, "http://x").searchParams.get("client")).toBe(SESSION_ID);
  });

  it("replaces the store when a reconnect answers with a snapshot", async () => {
    const { es } = start();
    es.emit("snapshot", shellSnapshot(10, [thread("t1"), thread("t2")]));
    es.fail();
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    FakeEventSource.latest().emit("snapshot", shellSnapshot(500, [thread("t1")]));
    expect(Object.keys(useShell.getState().threads)).toEqual(["t1"]);
    expect(useShell.getState().sequence).toBe(500);
  });

  it("backs off 1, 2, 4, 8 then 15 s", async () => {
    start();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      const before = FakeEventSource.instances.length;
      FakeEventSource.latest().fail();
      await settle();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeEventSource.instances.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeEventSource.instances.length).toBe(before + 1);
    }
  });

  it("keeps jitter within ±20%", async () => {
    expect(jittered(1_000, 0)).toBe(800);
    expect(jittered(1_000, 0.999999)).toBe(1_200);
    expect(jittered(15_000, 0.5)).toBe(15_000);
    expect(backoffBase(0)).toBe(1_000);
    expect(backoffBase(9)).toBe(15_000);

    start(testDeps({ random: () => 0 }));
    FakeEventSource.latest().fail();
    await settle();
    const before = FakeEventSource.instances.length;
    await vi.advanceTimersByTimeAsync(799);
    expect(FakeEventSource.instances.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances.length).toBe(before + 1);
  });

  it("starts the backoff over once a frame arrives", async () => {
    start();
    FakeEventSource.latest().fail();
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    FakeEventSource.latest().fail();
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    FakeEventSource.latest().emit("ping", { sequence: 3 });
    FakeEventSource.latest().fail();
    await settle();
    const before = FakeEventSource.instances.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.instances.length).toBe(before + 1);
  });

  it("reconnects after 45 s with no frame", async () => {
    const { es } = start();
    es.emit("snapshot", shellSnapshot(10));
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1_000);
    es.emit("ping", { sequence: 10 }); // a ping counts as life
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1);
    expect(es.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(es.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.latest()).not.toBe(es);
    expect(FakeEventSource.latest().after).toBe(10);
  });

  it("reconnects at once when the page returns to the foreground", () => {
    const { es } = start();
    es.emit("snapshot", shellSnapshot(10));
    setVisibility("hidden");
    expect(FakeEventSource.open()).toEqual([es]);
    setVisibility("visible");
    expect(es.closed).toBe(true);
    expect(FakeEventSource.open()).toHaveLength(1);
    expect(FakeEventSource.latest().after).toBe(10);
  });

  it("records sse.open and sse.drop with the page's SESSION_ID", async () => {
    const { es } = start();
    await vi.advanceTimersByTimeAsync(120);
    es.emit("snapshot", shellSnapshot(10));
    await vi.advanceTimersByTimeAsync(5_000);
    es.fail();
    const notes = __pendingConn().filter((e) => e.kind === "sse.open" || e.kind === "sse.drop");
    expect(notes).toEqual([
      expect.objectContaining({ kind: "sse.open", connectMs: 120, sid: SESSION_ID }),
      expect.objectContaining({ kind: "sse.drop", upMs: 5_000, opened: true, sid: SESSION_ID }),
    ]);
  });

  it("marks a watchdog drop stale", async () => {
    const { es } = start();
    es.emit("snapshot", shellSnapshot(1));
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(__pendingConn().find((e) => e.kind === "sse.drop")).toMatchObject({ stale: true });
  });

  it("goes lost after 15 s down", async () => {
    const { es } = start();
    es.emit("snapshot", shellSnapshot(1));
    es.fail();
    await settle();
    expect(useStreamHealth.getState().status).toBe("connecting");
    // Keep failing so it never comes back.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(4_000);
      FakeEventSource.latest().fail();
      await settle();
    }
    expect(useStreamHealth.getState().status).toBe("lost");
    FakeEventSource.latest().emit("ping", { sequence: 1 });
    expect(useStreamHealth.getState().status).toBe("lost"); // the closed source is ignored
  });

  it("turns a blocking 503 into the blocked state, retries once a minute, and clears on the next frame", async () => {
    const deps = testDeps();
    deps.fetch.mockImplementation(async () => blockingResponse());
    const { es } = start(deps);
    es.fail();
    await settle();
    expect(deps.fetch).toHaveBeenCalledWith(es.url, expect.anything());
    expect(useStreamHealth.getState().blocked).toMatchObject({ code: "herdr-too-old", have: "0.8.2", need: "0.9.0" });
    const before = FakeEventSource.instances.length;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(FakeEventSource.instances.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances.length).toBe(before + 1);
    FakeEventSource.latest().emit("snapshot", shellSnapshot(1));
    expect(useStreamHealth.getState().blocked).toBeNull();
  });

  it("treats a non-blocking 503 as an ordinary reconnect", async () => {
    const deps = testDeps();
    deps.fetch.mockImplementation(async () => blockingResponse("v2-starting"));
    const { es } = start(deps);
    es.fail();
    await settle();
    expect(useStreamHealth.getState().blocked).toBeNull();
    const before = FakeEventSource.instances.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.instances.length).toBe(before + 1);
  });
});
