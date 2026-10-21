import { afterEach, describe, expect, test } from "bun:test";

import { NO_CAPABILITIES, type QueuedMessage, type RuntimeRequest, type ThreadEvent, type ThreadStatus } from "../../shared/v2/contracts.ts";
import type { AgentStatus } from "../../shared/wire.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { StateEngine, STATUS_HOLD_MS } from "../state-engine.ts";
import { createProject, createThread, thread } from "../test/thread-fixtures.ts";
import { createHerdIngestor } from "./herd-ingest.ts";
import {
  createQueueDrainer,
  DRAIN_RETRY_MS,
  isNativeMaintenanceCommand,
  normalizeQueue,
  openRunIsMaintenance,
  queueEvent,
  type DeliverResult,
  type DrainTimers,
  type QueueDrainer,
} from "./queue-drain.ts";
import { openThreadStore } from "./store.ts";

const T0 = 1_800_000_000_000;
const CAPS = { ...NO_CAPABILITIES, hasJournal: true, canQueueDrain: true };

class FakeTimers implements DrainTimers {
  now = 0;
  private next = 1;
  private pending = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= this.now).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      this.pending.delete(due[0]);
      due[1].fn();
    }
  }
}

const row = (id: string, position: number, over: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id,
  threadId: "t1",
  text: `text ${id}`,
  attachments: [],
  position,
  mode: "queue",
  state: "queued",
  createdAt: T0,
  ...over,
});

const flush = async (drainer: QueueDrainer) => {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await drainer.settled();
  }
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function rig(status: ThreadStatus = "working") {
  const store = openThreadStore(":memory:", { now: () => T0, log: () => {} });
  store.append([createProject(), createThread(thread("t1", { status, capabilities: CAPS }))]);
  const sent: string[] = [];
  const intents: string[] = [];
  const results: DeliverResult[] = [];
  let ready = true;
  const timers = new FakeTimers();
  const drainer = createQueueDrainer({
    store,
    deliver: async (_t, text, _attachments, intent) => {
      sent.push(text);
      intents.push(intent);
      return results.shift() ?? { kind: "sent", events: [] };
    },
    composerReady: async () => ready,
    timers,
    log: () => {},
  });
  drainer.start();
  cleanups.push(() => {
    drainer.stop();
    store.close();
  });
  const setStatus = async (s: ThreadStatus) => {
    store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { status: s }, at: T0 } }]);
    await flush(drainer);
  };
  return {
    store,
    drainer,
    sent,
    intents,
    results,
    timers,
    setStatus,
    setReady: (v: boolean) => {
      ready = v;
    },
    queue: () => store.listQueued("t1"),
  };
}

describe("normalizeQueue", () => {
  test("positions become 0..n-1 in order, ties kept by list order", () => {
    expect(normalizeQueue([row("b", 5), row("a", -1), row("c", 5)]).map((r) => [r.id, r.position])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });
});

function pendingRequest(): RuntimeRequest {
  return {
    id: "req1",
    threadId: "t1",
    kind: "permission",
    prompt: "Run ls?",
    options: [{ label: "Yes", keys: ["1"] }],
    status: "pending",
    bindingHash: "b",
    createdAt: T0,
    updatedAt: T0,
  };
}

/**
 * A drainer whose store already holds rows, as it does after a bridge restart: `start()` holds every
 * row, and the tests watch what lifts the hold.
 */
function restartRig(rows: QueuedMessage[], opts: { status?: ThreadStatus; pending?: RuntimeRequest; ready?: boolean } = {}) {
  const store = openThreadStore(":memory:", { now: () => T0, log: () => {} });
  store.append([createProject(), createThread(thread("t1", { status: opts.status ?? "idle", capabilities: CAPS }))]);
  store.append([queueEvent("t1", rows, "added")]);
  if (opts.pending) store.append([{ type: "runtime-request.updated", threadId: "t1", payload: { request: opts.pending } }]);
  const sent: string[] = [];
  let ready = opts.ready ?? true;
  const timers = new FakeTimers();
  const events: ThreadEvent[] = [];
  const off = store.onCommitted((batch) => events.push(...batch));
  const drainer = createQueueDrainer({
    store,
    deliver: async (_t, text) => {
      sent.push(text);
      return { kind: "sent", events: [] };
    },
    composerReady: async () => ready,
    timers,
    log: () => {},
  });
  drainer.start();
  cleanups.push(() => {
    drainer.stop();
    off();
    store.close();
  });
  // Only the changes that carry a `change` word: the "sending" mark is a plain queue write.
  const queueChanges = (): { change: string; reason?: string }[] =>
    events.flatMap((e) =>
      e.type === "queue.updated" && e.payload.change
        ? [{ change: e.payload.change, ...(e.payload.reason ? { reason: e.payload.reason } : {}) }]
        : [],
    );
  return {
    store,
    drainer,
    sent,
    timers,
    events,
    changes: queueChanges,
    queue: () => store.listQueued("t1"),
    setReady: (v: boolean) => {
      ready = v;
    },
    async setStatus(s: ThreadStatus) {
      store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { status: s }, at: T0 } }]);
      await flush(drainer);
    },
  };
}

const userItem = (id: string, runId: string | null, text: string, attachments: QueuedMessage["attachments"] = []) => ({
  type: "turn-item.updated" as const,
  threadId: "t1",
  payload: {
    item: {
      id,
      threadId: "t1",
      runId,
      status: "completed" as const,
      title: null,
      startedAt: null,
      completedAt: null,
      createdAt: T0,
      updatedAt: T0,
      type: "user_message" as const,
      messageId: id,
      text,
      attachments,
    },
  },
});
const runStarted = (id: string, userItemId?: string) => ({
  type: "run.started" as const,
  threadId: "t1",
  payload: { run: { id, threadId: "t1", ordinal: 1, ...(userItemId ? { userItemId } : {}), status: "running" as const, startedAt: T0 } },
});

describe("maintenance commands (T3 #20184)", () => {
  test("isNativeMaintenanceCommand: /compact and /logout, trimmed, any case, no attachments", () => {
    expect(isNativeMaintenanceCommand({ text: "/compact", attachments: [] })).toBe(true);
    expect(isNativeMaintenanceCommand({ text: "  /Compact\n", attachments: [] })).toBe(true);
    expect(isNativeMaintenanceCommand({ text: "/logout", attachments: [] })).toBe(true);
    expect(isNativeMaintenanceCommand({ text: "/compact keep the plan", attachments: [] })).toBe(false);
    expect(isNativeMaintenanceCommand({ text: "/compact", attachments: [{ path: "C:\\a.png", name: "a.png" }] })).toBe(false);
  });

  test("openRunIsMaintenance reads the open run's message: linked, attributed, or the newest unclaimed one", () => {
    const linked = rig();
    expect(openRunIsMaintenance(linked.store, "t1")).toBe(false);
    linked.store.append([userItem("u1", "run1", "/compact"), runStarted("run1", "u1")]);
    expect(openRunIsMaintenance(linked.store, "t1")).toBe(true);
    linked.store.append([{ type: "run.ended", threadId: "t1", payload: { runId: "run1", status: "completed", completedAt: T0 } }]);
    expect(openRunIsMaintenance(linked.store, "t1")).toBe(false);

    const attributed = rig();
    attributed.store.append([runStarted("run1"), userItem("u1", "run1", "/compact")]);
    expect(openRunIsMaintenance(attributed.store, "t1")).toBe(true);

    const unclaimed = rig();
    unclaimed.store.append([userItem("u1", null, "/compact"), runStarted("run1")]);
    expect(openRunIsMaintenance(unclaimed.store, "t1")).toBe(true);

    const plain = rig();
    plain.store.append([userItem("u1", null, "fix the tests"), runStarted("run1")]);
    expect(openRunIsMaintenance(plain.store, "t1")).toBe(false);
  });

  test("a resumed steer row during /compact waits for the settle and goes as a queued turn", async () => {
    const r = rig();
    r.store.append([userItem("u1", "run1", "/compact"), runStarted("run1", "u1")]);
    r.store.append([queueEvent("t1", [row("s", 0, { mode: "steer", state: "queued" })], "resumed")]);
    await flush(r.drainer);
    expect(r.sent).toEqual([]);
    await r.setStatus("idle");
    expect(r.sent).toEqual(["text s"]);
    expect(r.intents).toEqual(["queued_turn"]);
  });
});

describe("QueueDrainer", () => {
  test("held rows are skipped; a sending row blocks the queue", async () => {
    const r = rig();
    r.store.append([queueEvent("t1", [row("h", 0, { state: "held", heldReason: "stalled" }), row("q", 1)], "added")]);
    await r.setStatus("idle");
    expect(r.sent).toEqual(["text q"]);

    const s = rig();
    s.store.append([queueEvent("t1", [row("steer", 0, { state: "sending", mode: "steer" }), row("q", 1)])]);
    s.store.append([queueEvent("t1", s.queue(), "added")]);
    await s.setStatus("idle");
    expect(s.sent).toEqual([]);
  });

  test("a thread without canQueueDrain is never drained", async () => {
    const r = rig();
    r.store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { capabilities: NO_CAPABILITIES }, at: T0 } }]);
    r.store.append([queueEvent("t1", [row("q", 0)], "added")]);
    await r.setStatus("idle");
    expect(r.sent).toEqual([]);
  });

  test("a late run.ended from the run before the send does not release the next row", async () => {
    const r = rig();
    r.store.append([{ type: "run.started", threadId: "t1", payload: { run: { id: "old", threadId: "t1", ordinal: 1, status: "running", startedAt: T0 } } }]);
    r.store.append([queueEvent("t1", [row("a", 0), row("b", 1)], "added")]);
    await r.setStatus("done");
    expect(r.sent).toEqual(["text a"]);
    r.store.append([{ type: "run.ended", threadId: "t1", payload: { runId: "old", status: "completed", completedAt: T0 } }]);
    await flush(r.drainer);
    expect(r.sent).toEqual(["text a"]);
  });

  test("a working seen while the send was still verifying counts toward its run", async () => {
    const r = rig("done");
    const finish = r.drainer.beginSend("t1");
    r.store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { status: "working" }, at: T0 } }]);
    finish(true);
    r.store.append([queueEvent("t1", [row("a", 0)], "added")]);
    await flush(r.drainer);
    expect(r.sent).toEqual([]);
    await r.setStatus("done");
    expect(r.sent).toEqual(["text a"]);
  });

  test("waitSettled resolves on a settle, on a timeout, and on archive", async () => {
    const r = rig();
    const a = r.drainer.waitSettled("t1", 1000);
    await r.setStatus("idle");
    expect(await a).toBe("settled");
    await r.setStatus("working");
    const b = r.drainer.waitSettled("t1", 1000);
    r.timers.advance(1000);
    expect(await b).toBe("timeout");
    const c = r.drainer.waitSettled("t1", 1000);
    r.store.append([{ type: "thread.archived", threadId: "t1", payload: { reason: "pane-closed", at: T0 } }]);
    expect(await c).toBe("gone");
  });
});

describe("restart auto-resume (Phase 5.3)", () => {
  test("a held queue lifts itself once the pane rests, with `resumed` reason `auto`, then drains", async () => {
    const r = restartRig([row("a", 0), row("b", 1)], { status: "idle" });
    await flush(r.drainer);
    expect(r.changes()).toEqual([
      { change: "held", reason: "restart" },
      { change: "resumed", reason: "auto" },
      { change: "sent" },
    ]);
    expect(r.sent).toEqual(["text a"]);
    expect(r.queue().map((q) => [q.id, q.state])).toEqual([["b", "queued"]]);
    // The next row waits for the run the first one started, as any drained row does.
    r.timers.advance(60_000);
    await flush(r.drainer);
    expect(r.sent).toEqual(["text a", "text b"]);
  });

  test("only the restart hold lifts: a row held for another reason stays held", async () => {
    const r = restartRig([row("stalled", 0, { state: "held", heldReason: "stalled" }), row("q", 1)], { status: "idle" });
    await flush(r.drainer);
    // `q` lifted itself and went; the stalled row is still held, exactly as the operator left it.
    expect(r.queue().map((q) => [q.id, q.state, q.heldReason])).toEqual([["stalled", "held", "stalled"]]);
    expect(r.sent).toEqual(["text q"]);
    r.timers.advance(60_000);
    await flush(r.drainer);
    expect(r.sent).toEqual(["text q"]);
  });

  test("it stays held while the thread works, and its settle lifts it", async () => {
    const r = restartRig([row("q", 0)], { status: "working" });
    await flush(r.drainer);
    expect(r.queue()).toEqual([expect.objectContaining({ state: "held", heldReason: "restart" })]);
    expect(r.sent).toEqual([]);
    r.timers.advance(DRAIN_RETRY_MS * 3);
    await flush(r.drainer);
    expect(r.queue()[0]!.state).toBe("held");

    await r.setStatus("done");
    expect(r.sent).toEqual(["text q"]);
  });

  test("it stays held while a request is pending, and the answer lifts it", async () => {
    const r = restartRig([row("q", 0)], { status: "idle", pending: pendingRequest() });
    await flush(r.drainer);
    expect(r.queue()).toEqual([expect.objectContaining({ state: "held", heldReason: "restart" })]);
    expect(r.sent).toEqual([]);

    r.store.append([
      { type: "runtime-request.updated", threadId: "t1", payload: { request: { ...pendingRequest(), status: "resolved", updatedAt: T0 } } },
    ]);
    await flush(r.drainer);
    expect(r.sent).toEqual(["text q"]);
  });

  test("a composer that is not on screen backs off and lifts on a later try", async () => {
    const r = restartRig([row("q", 0)], { status: "idle", ready: false });
    await flush(r.drainer);
    expect(r.queue()[0]!.state).toBe("held");
    expect(r.sent).toEqual([]);
    r.timers.advance(DRAIN_RETRY_MS);
    await flush(r.drainer);
    expect(r.sent).toEqual([]);

    r.setReady(true);
    r.timers.advance(DRAIN_RETRY_MS);
    await flush(r.drainer);
    expect(r.sent).toEqual(["text q"]);
    expect(r.changes()).toContainEqual({ change: "resumed", reason: "auto" });
  });
});

// ── With the real engine hold ─────────────────────────────────────────────────────────────────────

class FakeHerdr {
  status: AgentStatus = "working";
  sessionSnapshot() {
    return Promise.resolve({
      version: "0.9.0",
      protocol: 16,
      workspaces: [{ workspace_id: "w1", number: 1, label: "w1", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: this.status }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "1", focused: false, pane_count: 1, agent_status: this.status }],
      panes: [
        { pane_id: "w1:p1", terminal_id: "term", workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/demo", agent: "grok", agent_status: this.status, revision: 0 },
      ],
      agents: [],
    });
  }
}

describe("QueueDrainer with the engine's working hold", () => {
  test("a done that flips back to working inside the hold does not drain; one that lasts does", async () => {
    let now = T0;
    const herdr = new FakeHerdr();
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500, () => now);
    const poll = () => (engine as unknown as { poll(): Promise<void> }).poll();
    const store = openThreadStore(":memory:", { now: () => now, log: () => {} });
    const ingest = createHerdIngestor({ store, engine, activity: { get: () => undefined }, journals: null, now: () => now, log: () => {} });
    const sent: string[] = [];
    const drainer = createQueueDrainer({
      store,
      deliver: async (_t, text) => (sent.push(text), { kind: "sent", events: [] }),
      composerReady: async () => true,
      timers: new FakeTimers(),
      log: () => {},
    });
    ingest.start();
    drainer.start();
    cleanups.push(() => {
      ingest.stop();
      drainer.stop();
      store.close();
    });

    await poll();
    const t = store.listThreads()[0]!;
    expect(t.status).toBe("working");
    store.append([queueEvent(t.id, [row("q", 0, { threadId: t.id })], "added")]);
    await flush(drainer);

    herdr.status = "done";
    await poll();
    now += 400;
    herdr.status = "working";
    await poll();
    herdr.status = "done";
    await poll();
    now += STATUS_HOLD_MS - 1;
    await poll();
    await flush(drainer);
    expect(store.getThread(t.id)?.status).toBe("working");
    expect(sent).toEqual([]);

    now += 1;
    await poll();
    await flush(drainer);
    expect(store.getThread(t.id)?.status).not.toBe("working");
    expect(sent).toEqual(["text q"]);
  });
});
