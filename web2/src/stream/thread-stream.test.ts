import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeEventSource } from "@/test/fake-event-source";
import { itemEvent, renamed, thread, threadSnapshot, userItem } from "@/test/fixtures";
import { setVisibility, testDeps } from "@/test/stream-deps";

import { useThreadStore } from "./stores";
import { createThreadStream, type ThreadStream } from "./thread-stream";

let stream: ThreadStream | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
});
afterEach(() => {
  stream?.close();
  stream = null;
  vi.useRealTimers();
});

const current = () => useThreadStore.getState().current;

describe("thread stream", () => {
  it("is syncing until `synchronized`, applying the snapshot and replayed events", () => {
    stream = createThreadStream(testDeps());
    stream.open("t1");
    const es = FakeEventSource.latest();
    expect(new URL(es.url, "http://x").pathname).toBe("/api/v2/thread/t1");
    expect(current()).toMatchObject({ threadId: "t1", syncing: true });

    es.emit("snapshot", threadSnapshot(20, thread("t1"), [userItem("i1", "t1", "hello")]));
    es.emit("event", itemEvent(21, userItem("i2", "t1", "again", 1)));
    expect(current()).toMatchObject({ syncing: true, sequence: 21 });
    es.emit("synchronized", { sequence: 21 });
    expect(current()?.syncing).toBe(false);
    expect(Object.keys(current()?.items ?? {})).toEqual(["i1", "i2"]);
  });

  it("closes the old stream and clears its store when the thread changes", () => {
    stream = createThreadStream(testDeps());
    stream.open("t1");
    const first = FakeEventSource.latest();
    first.emit("snapshot", threadSnapshot(5, thread("t1")));
    stream.open("t2");
    expect(first.closed).toBe(true);
    expect(FakeEventSource.open()).toHaveLength(1);
    expect(current()).toMatchObject({ threadId: "t2", thread: null, syncing: true });
    first.emit("event", renamed(6, "t1", "late")); // a late frame from the closed source
    expect(current()?.threadId).toBe("t2");
  });

  it("opening the same thread twice keeps one stream", () => {
    stream = createThreadStream(testDeps());
    stream.open("t1");
    stream.open("t1");
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("reconnects from its sequence and syncs again", async () => {
    stream = createThreadStream(testDeps());
    stream.open("t1");
    const es = FakeEventSource.latest();
    es.emit("snapshot", threadSnapshot(30, thread("t1")));
    es.emit("synchronized", { sequence: 30 });
    es.fail();
    expect(current()?.syncing).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    const next = FakeEventSource.latest();
    expect(next.after).toBe(30);
    next.emit("synchronized", { sequence: 30 });
    expect(current()?.syncing).toBe(false);
  });

  it("marks the thread missing on a 404 and stops", async () => {
    const deps = testDeps();
    deps.fetch.mockImplementation(async () => new Response("not found", { status: 404 }));
    stream = createThreadStream(deps);
    stream.open("gone");
    FakeEventSource.latest().fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(useThreadStore.getState()).toMatchObject({ current: null, missing: "gone" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("close() closes the source and clears the store", () => {
    stream = createThreadStream(testDeps());
    stream.open("t1");
    stream.close();
    expect(FakeEventSource.open()).toHaveLength(0);
    expect(current()).toBeNull();
  });
});
