import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeEventSource } from "@/test/fake-event-source";
import { itemEvent, renamed, thread, threadSnapshot, userItem } from "@/test/fixtures";
import { setVisibility, testDeps } from "@/test/stream-deps";

import { useStreamHealth, useThreadStore } from "./stores";
import { CACHE_MAX, CACHE_TTL_MS, createThreadStream, type ThreadStream } from "./thread-stream";

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

/** The `gz` frame the bridge sends for a snapshot: base64 gzip of its JSON. */
async function gzipBase64(data: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const gzip = new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const packed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(gzip);
  let binary = "";
  for (const b of new Uint8Array(await new Response(packed).arrayBuffer())) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Let the async gzip decode run until `pred` holds. `DecompressionStream` is native: its callback
 * lands on a real macrotask, which the fake clock does not flush. Advance the fake clock AND give
 * the real queue one turn each pass, so the test does not depend on timing under a loaded CI runner.
 */
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) {
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.useFakeTimers();
  }
}

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

  it("decodes a gzipped snapshot, unsyncing only after both it and `synchronized` land", async () => {
    stream = createThreadStream(testDeps());
    stream.open("t1");
    const es = FakeEventSource.latest();
    const gz = await gzipBase64(threadSnapshot(20, thread("t1"), [userItem("i1", "t1", "hello")]));
    es.emit("snapshot", { gz });
    // A live event lands before the decode finishes; it must survive the snapshot replacing the state.
    es.emit("event", itemEvent(21, userItem("i2", "t1", "again", 1)));
    es.emit("synchronized", { sequence: 21 });
    // The decode is still pending: the following `synchronized` must not unsync an empty timeline.
    expect(current()).toMatchObject({ syncing: true, sequence: 0 });
    expect(current()?.items).toEqual({});
    await until(() => current()?.sequence === 21);
    expect(current()).toMatchObject({ syncing: false, sequence: 21 });
    expect(Object.keys(current()?.items ?? {})).toEqual(["i1", "i2"]);
  });

  it("drops a gzipped payload that is not a thread snapshot", async () => {
    const dropped = useStreamHealth.getState().dropped;
    stream = createThreadStream(testDeps());
    stream.open("t1");
    const es = FakeEventSource.latest();
    es.emit("snapshot", { gz: await gzipBase64({ sequence: 5, items: [] }) });
    es.emit("synchronized", { sequence: 5 });
    await until(() => useStreamHealth.getState().dropped > dropped);
    expect(useStreamHealth.getState().dropped).toBe(dropped + 1);
    expect(current()).toMatchObject({ threadId: "t1", thread: null, syncing: false, sequence: 0 });
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

  it("reopening a cached thread paints it at once and resumes after its cursor", () => {
    stream = createThreadStream(testDeps());
    stream.open("t1");
    const first = FakeEventSource.latest();
    first.emit("snapshot", threadSnapshot(30, thread("t1"), [userItem("i1", "t1", "hi")]));
    first.emit("event", itemEvent(31, userItem("i2", "t1", "more", 1)));
    first.emit("synchronized", { sequence: 31 });
    expect(current()).toMatchObject({ syncing: false, sequence: 31 });

    stream.open("t2");
    expect(current()).toMatchObject({ threadId: "t2", thread: null, syncing: true });
    stream.open("t1");
    const back = FakeEventSource.latest();
    // The cached state is on screen before the stream says anything, and the cursor is its sequence.
    expect(back.after).toBe(31);
    expect(current()).toMatchObject({ threadId: "t1", sequence: 31, syncing: true });
    expect(Object.keys(current()?.items ?? {})).toEqual(["i1", "i2"]);

    // The bridge replays the delta; the cached state is replaced only by what arrives.
    back.emit("event", itemEvent(32, userItem("i3", "t1", "again", 2)));
    expect(Object.keys(current()?.items ?? {})).toEqual(["i1", "i2", "i3"]);
    back.emit("synchronized", { sequence: 32 });
    expect(current()).toMatchObject({ syncing: false, sequence: 32 });
  });

  it("keeps only the last few threads for a resume and forgets stale ones", () => {
    stream = createThreadStream(testDeps());
    const load = (id: string, seq: number) => {
      stream!.open(id);
      const es = FakeEventSource.latest();
      es.emit("snapshot", threadSnapshot(seq, thread(id)));
      es.emit("synchronized", { sequence: seq });
    };
    for (const id of ["a", "b", "c", "d"]) load(id, 10);
    expect(CACHE_MAX).toBe(3);
    // `a` fell out of the cache: it opens at cursor 0; the others resume at theirs.
    stream.open("a");
    expect(FakeEventSource.latest().after).toBeNull();
    stream.open("d");
    expect(FakeEventSource.latest().after).toBe(10);

    // Past the TTL an entry is not worth resuming: a fresh snapshot is at least as current.
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    stream.open("b");
    expect(FakeEventSource.latest().after).toBeNull();
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
