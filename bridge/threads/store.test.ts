import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProject, createThread, project, textItem, thread } from "../test/thread-fixtures.ts";
import type { EventDraft } from "./events.ts";
import {
  MAX_ITEMS_PER_THREAD,
  openThreadStore,
  RETAIN_ARCHIVED_MS,
  RETAIN_EVENTS_MS,
  SCHEMA_VERSION,
  StoreTooNewError,
  type ThreadStore,
} from "./store.ts";

const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
const stores: ThreadStore[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sightr-threads-"));
  dirs.push(dir);
  return dir;
}

function open(path = ":memory:", now = () => 1_000_000): ThreadStore {
  const store = openThreadStore(path, { now, log: () => {} });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every projection table, as plain rows, for comparing two stores. */
function dumpProjection(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  const out: Record<string, unknown[]> = {};
  for (const table of ["projects", "threads", "runs", "turn_items", "runtime_requests", "queued_messages"]) {
    out[table] = db.query(`SELECT * FROM ${table} ORDER BY id`).all();
  }
  db.close();
  return out;
}

describe("migrations", () => {
  test("a fresh open reaches the latest version, and reopening is a no-op", () => {
    const path = join(tempDir(), "threads.sqlite");
    open(path).close();
    const db = new Database(path);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
    expect(db.query("SELECT version FROM migrations").all()).toEqual([{ version: SCHEMA_VERSION }]);
    db.close();

    const again = open(path);
    again.append([createProject()]);
    again.close();
    const db2 = new Database(path);
    expect(db2.query("SELECT version FROM migrations").all()).toEqual([{ version: SCHEMA_VERSION }]);
    expect(db2.query("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 1 });
    db2.close();
  });

  test("a database stamped with a newer version refuses to open", () => {
    const path = join(tempDir(), "threads.sqlite");
    open(path).close();
    const db = new Database(path);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openThreadStore(path, { log: () => {} })).toThrow(StoreTooNewError);
    // Not treated as corruption: the file stays where it was.
    expect(readdirSync(join(path, "..")).filter((f) => f.includes("corrupt"))).toEqual([]);
  });

  test("a truncated file is moved aside and replaced with an empty store", () => {
    const dir = tempDir();
    const path = join(dir, "threads.sqlite");
    const first = open(path);
    first.append([createProject(), createThread()]);
    first.close();
    const bytes = readFileSync(path);
    writeFileSync(path, bytes.subarray(0, 60));
    const logs: string[] = [];
    const store = openThreadStore(path, { now: () => 42, log: (m) => logs.push(m) });
    stores.push(store);
    expect(existsSync(join(dir, "threads.sqlite.corrupt-42"))).toBe(true);
    expect(store.listThreads()).toEqual([]);
    expect(store.lastSequence()).toBe(0);
    expect(logs).toHaveLength(1);
  });

  test("a file of garbage is moved aside too", () => {
    const dir = tempDir();
    const path = join(dir, "threads.sqlite");
    writeFileSync(path, "this is not a database, it is a sentence that runs on for a while ".repeat(40));
    const store = openThreadStore(path, { now: () => 7, log: () => {} });
    stores.push(store);
    expect(existsSync(join(dir, "threads.sqlite.corrupt-7"))).toBe(true);
    expect(store.snapshotShell().threads).toEqual([]);
  });
});

describe("append", () => {
  test("a batch gets consecutive sequences and is applied", () => {
    const store = open();
    const { first, last } = store.append([createProject(), createThread(), createThread(thread("t2"))]);
    expect([first, last]).toEqual([1, 3]);
    expect(store.lastSequence()).toBe(3);
    expect(store.listThreads().map((t) => t.id)).toEqual(["t1", "t2"]);
    const next = store.append([{ type: "thread.archived", threadId: "t2", payload: { reason: "user", at: 5 } }]);
    expect(next).toEqual({ first: 4, last: 4 });
  });

  test("a failing projection leaves no event row", () => {
    const store = open();
    store.append([createProject()]);
    // A thread that names a project that does not exist breaks the foreign key.
    expect(() => store.append([createThread(thread("t1")), createThread(thread("t2", { projectId: "nope" }))])).toThrow();
    expect(store.lastSequence()).toBe(1);
    expect(store.eventsAfter(0)).toHaveLength(1);
    expect(store.listThreads()).toEqual([]);
  });

  test("a duplicate commandId receipt fails the second append and writes nothing", () => {
    const store = open();
    store.append([createProject()]);
    store.append([createThread()], { commandId: "c1", receipt: { type: "thread.create", result: { threadId: "t1" } } });
    expect(store.receipt("c1")).toEqual({ commandId: "c1", type: "thread.create", sequence: 2, result: { threadId: "t1" }, ts: 1_000_000 });
    expect(() =>
      store.append([createThread(thread("t2"))], { commandId: "c1", receipt: { type: "thread.create" } }),
    ).toThrow();
    expect(store.lastSequence()).toBe(2);
    expect(store.getThread("t2")).toBeNull();
  });

  test("listeners get client-form events after commit, and a throwing listener rolls nothing back", () => {
    const store = open();
    const seen: string[] = [];
    store.onCommitted(() => {
      throw new Error("boom");
    });
    store.onCommitted((events) => seen.push(...events.map((e) => `${e.sequence}:${e.type}`)));
    store.append([createProject(), createThread(thread("t1", { sessionRef: { kind: "path", value: "C:/secret.jsonl" } }))]);
    expect(seen).toEqual(["1:project.upserted", "2:thread.created"]);
    expect(store.listThreads()).toHaveLength(1);
    const created = store.eventsAfter(1)[0]!;
    expect(created.type === "thread.created" && created.payload.thread.sessionRef).toBeUndefined();
  });

  test("a new turn item takes the next ordinal; an update keeps its own", () => {
    const store = open();
    store.append([createProject(), createThread(), { type: "turn-item.updated", threadId: "t1", payload: { item: textItem("a") } }]);
    store.append([
      { type: "turn-item.updated", threadId: "t1", payload: { item: textItem("b") } },
      { type: "turn-item.updated", threadId: "t1", payload: { item: textItem("a", "t1", null, "edited") } },
    ]);
    const items = store.snapshotThread("t1")!.items;
    expect(items.map((i) => [i.id, i.ordinal])).toEqual([["a", 0], ["b", 1]]);
    expect(items[0]!.type === "assistant_message" && items[0]!.text).toBe("edited");
    const last = store.eventsAfter(4)[0]!;
    expect(last.type === "turn-item.updated" && last.payload.item.ordinal).toBe(0);
  });

  test("offsets commit with the batch", () => {
    const store = open();
    const offset = { threadId: "t1", path: "C:/log.jsonl", offset: 10, size: 10, mtimeMs: 5, sessionKey: "s" };
    store.append([createProject(), createThread()], { offsets: [offset] });
    expect(store.offsets.get("t1")).toEqual(offset);
    store.offsets.set({ ...offset, offset: 20, size: 20 });
    expect(store.offsets.get("t1")?.offset).toBe(20);
  });
});

/** A scripted history that touches every projection-writing event type. */
function script(): EventDraft[][] {
  return [
    [createProject(), createProject(project("w2", { number: 2, order: 2, worktreeOf: "repo" }))],
    [createThread(), createThread(thread("t2", { projectId: "w2", sessionRef: { kind: "id", value: "sess-1" } }))],
    [{ type: "thread.updated", threadId: "t1", payload: { patch: { title: "renamed", titleSource: "user", status: "working" }, at: 2_000 } }],
    [{ type: "run.started", threadId: "t1", payload: { run: { id: "r1", threadId: "t1", ordinal: 1, status: "running", startedAt: 2_000 } } }],
    [
      { type: "turn-item.updated", threadId: "t1", payload: { item: textItem("i1", "t1", "r1") } },
      { type: "turn-item.updated", threadId: "t1", payload: { item: textItem("i2", "t1", "r1") } },
    ],
    [{ type: "run.ended", threadId: "t1", payload: { runId: "r1", status: "completed", completedAt: 3_000 } }],
    [
      {
        type: "runtime-request.updated",
        threadId: "t2",
        payload: {
          request: {
            id: "q1",
            threadId: "t2",
            kind: "permission",
            prompt: "Allow?",
            options: [{ label: "Yes", keys: ["1"] }],
            status: "pending",
            bindingHash: "h1",
            createdAt: 3_000,
            updatedAt: 3_000,
          },
          boundText: "Allow?\n1. Yes",
        },
      },
    ],
    [
      {
        type: "queue.updated",
        threadId: "t1",
        payload: {
          change: "added",
          messages: [
            { id: "m1", threadId: "t1", text: "next", attachments: [], position: 0, mode: "queue", state: "queued", createdAt: 3_000 },
          ],
        },
      },
    ],
    [{ type: "thread.shelf-changed", threadId: "t1", payload: { shelf: "pinned", pinOrder: 1, at: 3_500 } }],
    [{ type: "thread.shelf-changed", threadId: "t2", payload: { shelf: "snoozed", snoozedUntil: 9_000, at: 3_500 } }],
    [{ type: "project.closed", payload: { projectId: "w2", closedAt: 4_000 } }],
    [{ type: "thread.archived", threadId: "t2", payload: { reason: "pane-closed", at: 4_000 } }],
    [{ type: "thread.updated", threadId: "t2", payload: { patch: { sessionRef: null }, at: 4_100 } }],
    [{ type: "command.rejected", threadId: "t1", payload: { reason: "prompt-changed" } }],
  ];
}

describe("replay equivalence", () => {
  test("rebuilding from the stored events reaches the same projection", () => {
    const dir = tempDir();
    const a = open(join(dir, "a.sqlite"));
    for (const batch of script()) a.append(batch);
    const events = a.storedEventsAfter(0);
    a.close();

    const b = open(join(dir, "b.sqlite"));
    b.append(events.map(({ type, threadId, payload }) => ({ type, threadId, payload }) as EventDraft));
    expect(b.lastSequence()).toBe(events.length);
    b.close();

    expect(dumpProjection(join(dir, "b.sqlite"))).toEqual(dumpProjection(join(dir, "a.sqlite")));
  });
});

describe("reads", () => {
  test("eventsAfter honours threadId and limit", () => {
    const store = open();
    for (const batch of script()) store.append(batch);
    expect(store.eventsAfter(0, { limit: 3 }).map((e) => e.sequence)).toEqual([1, 2, 3]);
    const t2 = store.eventsAfter(0, { threadId: "t2" });
    expect(t2.length).toBeGreaterThan(0);
    expect(t2.every((e) => e.threadId === "t2")).toBe(true);
    expect(store.eventsAfter(store.lastSequence())).toEqual([]);
  });

  test("bound text and path refs never reach a snapshot or a client event", () => {
    const store = open();
    for (const batch of script()) store.append(batch);
    store.append([createThread(thread("t3", { sessionRef: { kind: "path", value: "C:/x/secret.jsonl" } }))]);
    const all = JSON.stringify([store.snapshotShell(), store.snapshotThread("t2"), store.snapshotThread("t3"), store.eventsAfter(0)]);
    expect(all).not.toContain("Allow?\\n1. Yes");
    expect(all).not.toContain("secret.jsonl");
    // The server form keeps them.
    expect(JSON.stringify(store.storedEventsAfter(0))).toContain("secret.jsonl");
    expect(store.getThread("t3")?.sessionRef).toEqual({ kind: "path", value: "C:/x/secret.jsonl" });
  });

  test("snapshots", () => {
    const store = open();
    for (const batch of script()) store.append(batch);
    const shell = store.snapshotShell();
    expect(shell.sequence).toBe(store.lastSequence());
    expect(shell.projects.map((p) => p.id)).toEqual(["w1", "w2"]);
    expect(shell.projects[1]).toMatchObject({ closedAt: 4_000, worktreeOf: "repo" });
    expect(shell.requests).toEqual([
      expect.objectContaining({ id: "q1", kind: "permission", prompt: "Allow?", status: "pending" }),
    ]);
    expect("options" in shell.requests[0]!).toBe(false);

    const t1 = store.snapshotThread("t1")!;
    expect(t1.thread).toMatchObject({ title: "renamed", titleSource: "user", shelf: "pinned", pinOrder: 1, pinnedAt: 3_500 });
    expect(t1.runs).toEqual([{ id: "r1", threadId: "t1", ordinal: 1, status: "completed", startedAt: 2_000, completedAt: 3_000 }]);
    expect(t1.items.map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(t1.queue.map((m) => m.id)).toEqual(["m1"]);
    expect(t1.historyCursor).toBeNull();

    const t2 = store.snapshotThread("t2")!;
    expect(t2.thread).toMatchObject({ shelf: "archived", archiveReason: "pane-closed", archivedAt: 4_000 });
    expect(t2.thread.snoozedUntil).toBeUndefined();
    expect(t2.thread.sessionRef).toBeUndefined();
    expect(store.snapshotThread("nope")).toBeNull();
  });

  test("a thread snapshot keeps the last N runs and offers a cursor for older items", () => {
    const store = open();
    store.append([createProject(), createThread()]);
    for (let n = 1; n <= 3; n++) {
      store.append([
        { type: "run.started", threadId: "t1", payload: { run: { id: `r${n}`, threadId: "t1", ordinal: n, status: "running", startedAt: n } } },
        { type: "turn-item.updated", threadId: "t1", payload: { item: textItem(`i${n}`, "t1", `r${n}`) } },
        { type: "run.ended", threadId: "t1", payload: { runId: `r${n}`, status: "completed", completedAt: n } },
      ]);
    }
    const snap = store.snapshotThread("t1", { runs: 2 })!;
    expect(snap.runs.map((r) => r.id)).toEqual(["r2", "r3"]);
    expect(snap.items.map((i) => i.id)).toEqual(["i2", "i3"]);
    expect(snap.historyCursor).toBe(btoa("1"));
  });

  test("openRuns and pendingRequests list only the live ones", () => {
    const store = open();
    store.append([createProject(), createThread()]);
    const request = (id: string, status: "pending" | "resolved") => ({
      id,
      threadId: "t1",
      kind: "permission" as const,
      prompt: "Allow?",
      options: [{ label: "Yes", keys: ["1"] }],
      status,
      bindingHash: "h",
      createdAt: 1,
      updatedAt: 1,
    });
    store.append([
      { type: "run.started", threadId: "t1", payload: { run: { id: "r1", threadId: "t1", ordinal: 1, status: "running", startedAt: 1 } } },
      { type: "run.ended", threadId: "t1", payload: { runId: "r1", status: "completed", completedAt: 2 } },
      { type: "run.started", threadId: "t1", payload: { run: { id: "r2", threadId: "t1", ordinal: 2, status: "running", startedAt: 3 } } },
      { type: "runtime-request.updated", threadId: "t1", payload: { request: request("q1", "resolved") } },
      { type: "runtime-request.updated", threadId: "t1", payload: { request: request("q2", "pending") } },
    ]);
    expect(store.openRuns().map((r) => r.id)).toEqual(["r2"]);
    expect(store.pendingRequests().map((r) => r.id)).toEqual(["q2"]);
    expect(store.pendingRequests()[0]!.options).toHaveLength(1);
  });

  test("shelf changes clear the previous shelf's fields; unarchive clears the archive", () => {
    const store = open();
    store.append([createProject(), createThread()]);
    store.append([{ type: "thread.shelf-changed", threadId: "t1", payload: { shelf: "settled", at: 10 } }]);
    expect(store.getThread("t1")).toMatchObject({ shelf: "settled", settledAt: 10 });
    store.append([{ type: "thread.archived", threadId: "t1", payload: { reason: "user", at: 11 } }]);
    expect(store.getThread("t1")?.settledAt).toBeUndefined();
    store.append([{ type: "thread.shelf-changed", threadId: "t1", payload: { shelf: "active", at: 12 } }]);
    const t = store.getThread("t1")!;
    expect(t.shelf).toBe("active");
    expect(t.archivedAt).toBeUndefined();
    expect(t.archiveReason).toBeUndefined();
    expect(t.updatedAt).toBe(12);
  });
});

describe("retention", () => {
  test("old events, old receipts, items over the cap and long-archived threads go; an open run's items stay", () => {
    let now = 0;
    const store = open(join(tempDir(), "threads.sqlite"), () => now);
    store.append([createProject(), createThread(), createThread(thread("old"))], { commandId: "c-old", receipt: { type: "x" } });
    store.append([{ type: "thread.archived", threadId: "old", payload: { reason: "pane-closed", at: 0 } }]);
    // One open run whose items are the oldest in the thread, then enough loose items to pass the cap.
    store.append([
      { type: "run.started", threadId: "t1", payload: { run: { id: "open", threadId: "t1", ordinal: 1, status: "running", startedAt: 0 } } },
      { type: "turn-item.updated", threadId: "t1", payload: { item: textItem("keep", "t1", "open") } },
    ]);
    const filler: EventDraft[] = [];
    for (let n = 0; n < MAX_ITEMS_PER_THREAD + 5; n++) {
      filler.push({ type: "turn-item.updated", threadId: "t1", payload: { item: textItem(`f${n}`) } });
    }
    store.append(filler);

    now = 91 * DAY;
    store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { status: "working" }, at: now } }], {
      commandId: "c-new",
      receipt: { type: "y" },
    });
    const before = store.lastSequence();
    const result = store.prune(now);

    // Fewer than 50 000 events exist, so age alone does not remove them.
    expect(result.events).toBe(0);
    expect(store.eventsAfter(0).length).toBe(before);
    expect(store.receipt("c-old")).toBeNull();
    expect(store.receipt("c-new")).not.toBeNull();
    expect(result.items).toBe(6);
    const items = store.snapshotThread("t1")!.items.map((i) => i.id);
    expect(items).toContain("keep");
    expect(items).not.toContain("f5");
    expect(items).toContain("f6");
    expect(items).toHaveLength(MAX_ITEMS_PER_THREAD);
    expect(store.getThread("old")).toBeNull();
    expect(result.threads).toBe(1);
  });

  test("events older than seven days and beyond the newest 50 000 go, and minSequence moves", () => {
    let now = 0;
    const store = open(":memory:", () => now);
    store.append([createProject()]);
    expect(store.minSequence()).toBe(0);
    // 50 010 cheap events at t=0, then one recent one.
    const batch: EventDraft[] = [];
    for (let n = 0; n < 50_010; n++) batch.push({ type: "command.rejected", payload: { reason: `r${n}` } });
    store.append(batch);
    now = RETAIN_EVENTS_MS + DAY;
    store.append([{ type: "command.rejected", payload: { reason: "recent" } }]);
    const last = store.lastSequence();

    const result = store.prune(now);
    // Keep the newest 50 000 (the last one included).
    expect(result.events).toBe(last - 50_000);
    expect(store.minSequence()).toBe(last - 50_000 + 1);
    expect(store.eventsAfter(0)[0]!.sequence).toBe(store.minSequence());
    // The sequence never goes back.
    expect(store.lastSequence()).toBe(last);
    expect(store.append([{ type: "command.rejected", payload: { reason: "after" } }]).first).toBe(last + 1);
  });

  test("an archived thread younger than 90 days stays", () => {
    const store = open();
    store.append([createProject(), createThread()]);
    store.append([{ type: "thread.archived", threadId: "t1", payload: { reason: "user", at: 0 } }]);
    expect(store.prune(RETAIN_ARCHIVED_MS - 1).threads).toBe(0);
    expect(store.prune(RETAIN_ARCHIVED_MS + 1).threads).toBe(1);
  });
});
