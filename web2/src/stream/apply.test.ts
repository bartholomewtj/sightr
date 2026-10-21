import { describe, expect, it, vi } from "vitest";

import type { ThreadEvent } from "@shared/v2/contracts";

import { itemEvent, project, renamed, shellSnapshot, thread, threadSnapshot, userItem } from "@/test/fixtures";

import { applyShellEvent, applyThreadEvent, emptyThread, shellFromSnapshot, threadFromSnapshot } from "./apply";

describe("applyShellEvent", () => {
  const base = shellFromSnapshot(shellSnapshot(10));

  it("applies events in order and advances the sequence", () => {
    const a = applyShellEvent(base, renamed(11, "t1", "one"));
    const b = applyShellEvent(a, renamed(12, "t1", "two"));
    expect(b.threads.t1?.title).toBe("two");
    expect(b.sequence).toBe(12);
    expect(b.threads.t1?.updatedAt).toBe(2_012);
  });

  it("accepts a gap in sequences", () => {
    const next = applyShellEvent(base, renamed(40, "t1", "later"));
    expect(next.sequence).toBe(40);
    expect(next.threads.t1?.title).toBe("later");
  });

  it("ignores a duplicate or stale sequence and returns the same object", () => {
    const a = applyShellEvent(base, renamed(11, "t1", "one"));
    const onDrop = vi.fn();
    expect(applyShellEvent(a, renamed(11, "t1", "dup"), onDrop)).toBe(a);
    expect(applyShellEvent(a, renamed(3, "t1", "old"), onDrop)).toBe(a);
    expect(a.threads.t1?.title).toBe("one");
    expect(onDrop).toHaveBeenCalledTimes(2);
    expect(onDrop.mock.calls[0]?.[0]).toBe("stale");
  });

  it("ignores an unknown event type", () => {
    const onDrop = vi.fn();
    const next = applyShellEvent(base, { sequence: 11, type: "thread.teleported", payload: {}, ts: 1 }, onDrop);
    expect(next).toBe(base);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("drops a malformed payload without throwing", () => {
    const onDrop = vi.fn();
    for (const bad of [
      null,
      "x",
      { type: "thread.updated" },
      { sequence: 11, type: "thread.updated", payload: null },
      { sequence: 11, type: "thread.updated", threadId: "t1", payload: { patch: "nope", at: 1 } },
      { sequence: 11, type: "project.upserted", payload: { project: {} } },
      { sequence: 11, type: "queue.updated", threadId: "t1", payload: { messages: [1] } },
    ]) {
      expect(applyShellEvent(base, bad, onDrop)).toBe(base);
    }
    expect(onDrop).toHaveBeenCalledTimes(7);
    expect(onDrop.mock.calls.every(([reason]) => reason === "malformed")).toBe(true);
  });

  it("returns the same object for an event the shell does not keep", () => {
    expect(applyShellEvent(base, itemEvent(11, userItem("i1", "t1", "hi")))).toBe(base);
  });

  it("projects shelf changes like the bridge store", () => {
    const pinned = applyShellEvent(base, {
      sequence: 11,
      threadId: "t1",
      type: "thread.shelf-changed",
      payload: { shelf: "pinned", pinOrder: 2, at: 5_000 },
      ts: 5_000,
    } satisfies ThreadEvent);
    expect(pinned.threads.t1).toMatchObject({ shelf: "pinned", pinnedAt: 5_000, pinOrder: 2 });
    const archived = applyShellEvent(pinned, {
      sequence: 12,
      threadId: "t1",
      type: "thread.archived",
      payload: { reason: "user", at: 6_000 },
      ts: 6_000,
    } satisfies ThreadEvent);
    expect(archived.threads.t1).toMatchObject({ shelf: "archived", archivedAt: 6_000, archiveReason: "user" });
    expect(archived.threads.t1?.pinnedAt).toBeUndefined();
  });

  it("thread.deleted drops the thread and its request summaries", () => {
    const withRequest = applyShellEvent(base, {
      sequence: 11,
      threadId: "t1",
      type: "runtime-request.updated",
      payload: {
        request: { id: "r1", threadId: "t1", kind: "question", prompt: "?", options: [], status: "pending", bindingHash: "h", createdAt: 1, updatedAt: 1 },
      },
      ts: 1,
    } satisfies ThreadEvent);
    expect(Object.keys(withRequest.requests)).toEqual(["r1"]);
    const gone = applyShellEvent(withRequest, { sequence: 12, threadId: "t1", type: "thread.deleted", payload: { at: 7_000 }, ts: 7_000 } satisfies ThreadEvent);
    expect(gone.threads.t1).toBeUndefined();
    expect(gone.requests).toEqual({});
    expect(gone.sequence).toBe(12);
  });

  it("adds projects and threads, and keeps request summaries without options", () => {
    const withProject = applyShellEvent(base, {
      sequence: 11,
      type: "project.upserted",
      payload: { project: project("w2", { label: "Two" }) },
      ts: 1,
    } satisfies ThreadEvent);
    const withThread = applyShellEvent(withProject, {
      sequence: 12,
      threadId: "t2",
      type: "thread.created",
      payload: { thread: thread("t2", { projectId: "w2" }) },
      ts: 1,
    } satisfies ThreadEvent);
    const withRequest = applyShellEvent(withThread, {
      sequence: 13,
      threadId: "t2",
      type: "runtime-request.updated",
      payload: {
        request: {
          id: "r1",
          threadId: "t2",
          kind: "permission",
          prompt: "Run ls?",
          options: [{ label: "Yes", keys: ["1"] }],
          status: "pending",
          bindingHash: "h",
          createdAt: 1,
          updatedAt: 1,
        },
      },
      ts: 1,
    } satisfies ThreadEvent);
    expect(withRequest.projects.w2?.label).toBe("Two");
    expect(withRequest.threads.t2?.projectId).toBe("w2");
    expect(withRequest.requests.r1).toMatchObject({ prompt: "Run ls?", status: "pending" });
    expect(withRequest.requests.r1).not.toHaveProperty("options");
  });
});

describe("applyThreadEvent", () => {
  const t1 = thread("t1");
  const base = threadFromSnapshot(threadSnapshot(10, t1, [userItem("i1", "t1", "hello", 0)]), false);

  it("upserts turn items in order", () => {
    const a = applyThreadEvent(base, itemEvent(11, userItem("i2", "t1", "second", 1)));
    const b = applyThreadEvent(a, itemEvent(12, { ...userItem("i2", "t1", "second, edited", 1) }));
    expect(Object.keys(b.items)).toEqual(["i1", "i2"]);
    expect(b.items.i2).toMatchObject({ type: "user_message", text: "second, edited" });
    expect(b.sequence).toBe(12);
  });

  it("ignores duplicate and stale sequences", () => {
    const a = applyThreadEvent(base, itemEvent(11, userItem("i2", "t1", "x", 1)));
    expect(applyThreadEvent(a, itemEvent(11, userItem("i2", "t1", "dup", 1)))).toBe(a);
    expect(applyThreadEvent(a, itemEvent(9, userItem("i3", "t1", "old", 2)))).toBe(a);
  });

  it("ignores unknown types and events of another thread", () => {
    expect(applyThreadEvent(base, { sequence: 11, type: "turn-item.exploded", payload: {} })).toBe(base);
    expect(applyThreadEvent(base, renamed(11, "t2", "not mine"))).toBe(base);
  });

  it("drops a malformed payload", () => {
    const onDrop = vi.fn();
    expect(applyThreadEvent(base, { sequence: 11, type: "turn-item.updated", threadId: "t1", payload: { item: { id: "x" } } }, onDrop)).toBe(base);
    expect(onDrop).toHaveBeenCalledWith("malformed", expect.anything());
  });

  it("tracks runs and the queue", () => {
    const started = applyThreadEvent(emptyThread("t1"), {
      sequence: 1,
      threadId: "t1",
      type: "run.started",
      payload: { run: { id: "r1", threadId: "t1", ordinal: 0, status: "running", startedAt: 1 } },
      ts: 1,
    } satisfies ThreadEvent);
    const ended = applyThreadEvent(started, {
      sequence: 2,
      threadId: "t1",
      type: "run.ended",
      payload: { runId: "r1", status: "completed", completedAt: 9 },
      ts: 9,
    } satisfies ThreadEvent);
    expect(ended.runs.r1).toMatchObject({ status: "completed", completedAt: 9 });
    const queued = applyThreadEvent(ended, {
      sequence: 3,
      threadId: "t1",
      type: "queue.updated",
      payload: {
        messages: [
          { id: "q2", threadId: "t1", text: "b", attachments: [], position: 2, mode: "queue", state: "queued", createdAt: 1 },
          { id: "q1", threadId: "t1", text: "a", attachments: [], position: 1, mode: "queue", state: "queued", createdAt: 1 },
        ],
      },
      ts: 9,
    } satisfies ThreadEvent);
    expect(queued.queue.map((m) => m.id)).toEqual(["q1", "q2"]);
  });

  it("marks a restart hold the bridge lifted by itself, and counts what it put back (Phase 5.3)", () => {
    const held = (id: string, position: number) => ({
      id,
      threadId: "t1",
      text: id,
      attachments: [],
      position,
      mode: "queue" as const,
      state: "held" as const,
      heldReason: "restart",
      createdAt: 1,
    });
    let s = applyThreadEvent(emptyThread("t1"), {
      sequence: 1,
      threadId: "t1",
      type: "queue.updated",
      payload: { messages: [held("q1", 0), held("q2", 1)], change: "held", reason: "restart" },
      ts: 1,
    } satisfies ThreadEvent);
    const auto = applyThreadEvent(s, {
      sequence: 2,
      threadId: "t1",
      type: "queue.updated",
      payload: { messages: [{ ...held("q1", 0), state: "queued", heldReason: undefined }, { ...held("q2", 1), state: "queued", heldReason: undefined }], change: "resumed", reason: "auto" },
      ts: 2,
    } satisfies ThreadEvent);
    expect(auto.queueAutoResume).toEqual({ sequence: 2, count: 2 });

    // A manual resume (no `auto`) leaves the notice as it was; a snapshot clears it.
    const manual = applyThreadEvent(auto, {
      sequence: 3,
      threadId: "t1",
      type: "queue.updated",
      payload: { messages: [{ ...held("q1", 0), state: "queued", heldReason: undefined }], change: "resumed" },
      ts: 3,
    } satisfies ThreadEvent);
    expect(manual.queueAutoResume).toEqual({ sequence: 2, count: 2 });
    expect(threadFromSnapshot(threadSnapshot(4, thread("t1")), false).queueAutoResume).toBeNull();
  });

  it("keeps a run's checkpoint through captured, run end, expiry and a repeated start (T31)", () => {
    const run = { id: "r1", threadId: "t1", ordinal: 0, status: "running" as const, startedAt: 1 };
    const checkpoint = { runId: "r1", threadId: "t1", appRunOrdinal: 0, status: "pending" as const, files: [], additions: 0, deletions: 0 };
    let s = applyThreadEvent(emptyThread("t1"), { sequence: 1, threadId: "t1", type: "run.started", payload: { run }, ts: 1 });
    s = applyThreadEvent(s, { sequence: 2, threadId: "t1", type: "checkpoint.captured", payload: { checkpoint, phase: "start" }, ts: 2 });
    expect(s.runs.r1?.checkpoint?.status).toBe("pending");
    s = applyThreadEvent(s, { sequence: 3, threadId: "t1", type: "run.ended", payload: { runId: "r1", status: "completed", completedAt: 9 }, ts: 9 });
    expect(s.runs.r1?.checkpoint?.status).toBe("pending");
    const ready = { ...checkpoint, status: "ready" as const, live: true, files: [{ path: "a.ts", kind: "modified" as const, additions: 1, deletions: 0 }], additions: 1 };
    s = applyThreadEvent(s, { sequence: 4, threadId: "t1", type: "checkpoint.captured", payload: { checkpoint: ready, phase: "end" }, ts: 10 });
    expect(s.runs.r1?.checkpoint).toMatchObject({ status: "ready", additions: 1 });
    s = applyThreadEvent(s, { sequence: 5, threadId: "t1", type: "run.started", payload: { run }, ts: 11 });
    expect(s.runs.r1?.checkpoint?.status).toBe("ready");
    s = applyThreadEvent(s, { sequence: 6, threadId: "t1", type: "checkpoint.expired", payload: { runId: "r1" }, ts: 12 });
    expect(s.runs.r1?.checkpoint).toMatchObject({ status: "ready", live: false, files: ready.files });
  });

  it("ignores a start phase that arrives after the end", () => {
    const run = { id: "r1", threadId: "t1", ordinal: 0, status: "completed" as const, startedAt: 1, completedAt: 5 };
    const base1 = { runId: "r1", threadId: "t1", appRunOrdinal: 0, files: [], additions: 0, deletions: 0 };
    let s = applyThreadEvent(emptyThread("t1"), { sequence: 1, threadId: "t1", type: "run.started", payload: { run }, ts: 1 });
    s = applyThreadEvent(s, { sequence: 2, threadId: "t1", type: "checkpoint.captured", payload: { checkpoint: { ...base1, status: "ready" as const }, phase: "end" }, ts: 2 });
    const late = applyThreadEvent(s, { sequence: 3, threadId: "t1", type: "checkpoint.captured", payload: { checkpoint: { ...base1, status: "pending" as const }, phase: "start" }, ts: 3 });
    expect(late.runs.r1?.checkpoint?.status).toBe("ready");
    s = applyThreadEvent(emptyThread("t1"), { sequence: 1, threadId: "t1", type: "run.started", payload: { run }, ts: 1 });
    s = applyThreadEvent(s, { sequence: 2, threadId: "t1", type: "checkpoint.captured", payload: { checkpoint: { ...base1, status: "absent" as const, reason: "no-repo" as const }, phase: "start" }, ts: 2 });
    s = applyThreadEvent(s, { sequence: 3, threadId: "t1", type: "checkpoint.captured", payload: { checkpoint: { ...base1, status: "pending" as const }, phase: "start" }, ts: 3 });
    expect(s.runs.r1?.checkpoint?.status).toBe("absent");
  });

  it("ignores a checkpoint for a run it does not hold, and drops a malformed one", () => {
    const onDrop = vi.fn();
    const checkpoint = { runId: "nope", threadId: "t1", appRunOrdinal: 0, status: "ready", files: [], additions: 0, deletions: 0 };
    const same = applyThreadEvent(base, { sequence: 11, threadId: "t1", type: "checkpoint.captured", payload: { checkpoint, phase: "end" }, ts: 1 });
    expect(same).toBe(base);
    expect(applyThreadEvent(base, { sequence: 11, threadId: "t1", type: "checkpoint.expired", payload: { runId: "nope" }, ts: 1 })).toBe(base);
    applyThreadEvent(base, { sequence: 11, threadId: "t1", type: "checkpoint.captured", payload: { checkpoint: {}, phase: "end" }, ts: 1 }, onDrop);
    expect(onDrop).toHaveBeenCalledWith("malformed", expect.anything());
  });

  it("fills a missing ordinal with the next one", () => {
    const { ordinal: _o, ...noOrdinal } = userItem("i9", "t1", "late", 0);
    const next = applyThreadEvent(base, { sequence: 11, threadId: "t1", type: "turn-item.updated", payload: { item: noOrdinal }, ts: 1 });
    expect(next.items.i9?.ordinal).toBe(1);
  });
});

describe("applyThreadEvent: dispatch.failed (T12)", () => {
  it("keeps the newest failure with its commandId; a snapshot clears it", () => {
    const base = threadFromSnapshot(threadSnapshot(10, thread("t1")), false);
    const next = applyThreadEvent(base, {
      sequence: 11,
      threadId: "t1",
      commandId: "c1",
      type: "dispatch.failed",
      payload: { reason: "stalled", message: "no echo" },
      ts: 5,
    });
    expect(next.dispatchFailure).toEqual({ sequence: 11, commandId: "c1", reason: "stalled", message: "no echo", ts: 5 });
    expect(threadFromSnapshot(threadSnapshot(12, thread("t1")), false).dispatchFailure).toBeNull();
  });
});
