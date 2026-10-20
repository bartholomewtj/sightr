import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  NO_CAPABILITIES,
  type ChatAttachment,
  type Command,
  type QueuedMessage,
  type RuntimeRequest,
  type ThreadCapabilities,
  type ThreadEvent,
  type ThreadStatus,
} from "../../shared/v2/contracts.ts";
import type { Config } from "../config.ts";
import { createGuardedSender } from "../guarded-send-route.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { createPaneQueue } from "../pane-queue.ts";
import type { AgentView, EngineSnapshot } from "../state-engine.ts";
import { createProject, createThread, thread } from "../test/thread-fixtures.ts";
import { createDispatcher, messageText, STEER_WAIT_MS, type Dispatcher } from "./dispatch.ts";
import { createJournalIngestor, createThreadWatchers } from "./journal-ingest.ts";
import { DRAIN_RETRY_MS, MAX_DRAIN_FAILURES, type DrainTimers } from "./queue-drain.ts";
import { requestEvents } from "./request-items.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";
import { createV2Gate } from "./herdr-floor.ts";
import { createV2Routes, type EffectContext, type EffectOutcome } from "./v2-routes.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const RAW_EMPTY_BOX = fixture("claude--draft-footer-empty.txt");
// Default EMPTY_BOX strips the background-agents line so standard tests test the ordinary non-background paths
const EMPTY_BOX = RAW_EMPTY_BOX.replace(/.*Waiting for.*background agent.*/i, "");
const PERMISSION = fixture("claude--permission-bash.txt");
// Claude's prompt row: a dim `❯`, a no-break space, then whatever is in the box.
const PROMPT_ROW = /(\x1b\[0m\x1b\[38;2;153;153;153m❯ \x1b\[0m)[^\r\n]*/;

const T0 = 1_800_000_000_000;
const PANE = "w1:p-t1";
const cfg = { submitKeys: ["Enter"], readLines: 200, deviceAllowlist: [], notifyDelayMs: 0 } as unknown as Config;
const noSleep = async () => {};

const CLAUDE_CAPS: ThreadCapabilities = {
  ...NO_CAPABILITIES,
  hasJournal: true,
  canQueueDrain: true,
  canInterrupt: true,
  interruptKeys: ["Escape"],
};

/** A Claude pane: typed text lands in the box, Enter submits it, Escape is recorded. */
class FakeClaude {
  draft = "";
  dialog = false;
  backgroundAgents = false;
  swallowText = false;
  submitted: string[] = [];
  texts: string[] = [];
  keys: string[] = [];
  log: string[] = [];
  screen(): string {
    if (this.dialog) return PERMISSION;
    const base = this.backgroundAgents ? RAW_EMPTY_BOX : EMPTY_BOX;
    return base.replace(PROMPT_ROW, (_m, prompt: string) => prompt + this.draft);
  }
  readPane(paneId: string) {
    return Promise.resolve({ pane_id: paneId, text: this.screen(), truncated: false, revision: 0 });
  }
  sendPaneText(_paneId: string, text: string) {
    this.texts.push(text);
    this.log.push(`text:${text}`);
    if (!this.swallowText && !this.dialog) this.draft += text;
    return Promise.resolve();
  }
  sendPaneKeys(_paneId: string, keys: string[]) {
    for (const k of keys) {
      this.keys.push(k);
      this.log.push(`key:${k}`);
      if (this.dialog) continue;
      if (k === "Enter" && this.draft) {
        this.submitted.push(this.draft);
        this.draft = "";
      }
      if (k === "Backspace") this.draft = [...this.draft].slice(0, -1).join("");
    }
    return Promise.resolve();
  }
}

/** Timers the test advances by hand. */
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
  count(): number {
    return this.pending.size;
  }
}

interface Rig {
  store: ThreadStore;
  pane: FakeClaude;
  timers: FakeTimers;
  dispatcher: Dispatcher;
  events: ThreadEvent[];
  marked: string[];
  view: AgentView;
  run(command: Record<string, unknown>): Promise<EffectOutcome>;
  setStatus(status: ThreadStatus): Promise<void>;
  queue(): QueuedMessage[];
  idle(): Promise<void>;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function rig(opts: { status?: ThreadStatus; caps?: ThreadCapabilities; harness?: string; started?: boolean; store?: ThreadStore } = {}): Rig {
  let n = 0;
  const clock = { now: T0 };
  const store =
    opts.store ??
    openThreadStore(":memory:", { now: () => clock.now, newId: () => `id${++n}`, log: () => {} });
  if (!opts.store) {
    store.append([
      createProject(),
      createThread(
        thread("t1", {
          paneId: PANE,
          terminalId: "term-t1",
          harness: opts.harness ?? "claude",
          status: opts.status ?? "idle",
          capabilities: opts.caps ?? CLAUDE_CAPS,
        }),
      ),
    ]);
  }
  const pane = new FakeClaude();
  const view: AgentView = {
    paneId: PANE,
    terminalId: "term-t1",
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "C:\\code\\demo",
    focused: false,
    kind: "agent",
  };
  const snap = (): EngineSnapshot => ({ agents: [view], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" });
  const engine = { current: snap };
  const queue = createPaneQueue();
  const timers = new FakeTimers();
  const marked: string[] = [];
  const herdr = pane as unknown as HerdrClient;
  const dispatcher = createDispatcher({
    store,
    sender: createGuardedSender(herdr, cfg, engine, queue, noSleep),
    herdr,
    engine,
    queue,
    journal: { markInterrupted: (runId) => void marked.push(runId) },
    timers,
    sleep: noSleep,
    log: () => {},
  });
  const events: ThreadEvent[] = [];
  const off = store.onCommitted((batch) => events.push(...batch));
  if (opts.started !== false) dispatcher.start();
  cleanups.push(() => {
    dispatcher.stop();
    off();
    if (!opts.store) store.close();
  });
  let cmd = 0;
  const r: Rig = {
    store,
    pane,
    timers,
    dispatcher,
    events,
    marked,
    view,
    async run(command) {
      const commandId = `c${++cmd}`;
      const full = { commandId, ...command } as unknown as Command;
      const handler = dispatcher.effects[full.type]!;
      const ctx: EffectContext = { commandId, receipt: { type: full.type, result: { hash: "h" } } };
      const out = await handler(full, ctx);
      await r.idle();
      return out;
    },
    async setStatus(status) {
      store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { status }, at: clock.now } }]);
      await r.idle();
    },
    queue: () => store.listQueued("t1"),
    // Background work (drain passes, a steer's send) runs on promises; a steer waiting for its
    // thread to settle is not awaited (its timeout is on the fake timers).
    async idle() {
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await dispatcher.drainer.settled();
      }
    },
  };
  return r;
}

const types = (events: ThreadEvent[]) => events.map((e) => e.type);
const failed = (events: ThreadEvent[]) =>
  events.filter((e): e is Extract<ThreadEvent, { type: "dispatch.failed" }> => e.type === "dispatch.failed").map((e) => e.payload);
const changes = (events: ThreadEvent[]) =>
  events.flatMap((e) => (e.type === "queue.updated" && e.payload.change ? [e.payload.change] : []));

/** A `user_message` item (the text that opened a run), as the journal or dispatch writes it. */
function compactItem(id: string, runId: string | null, text: string, attachments: ChatAttachment[] = []): ThreadEvent {
  return {
    type: "turn-item.updated",
    threadId: "t1",
    payload: {
      item: {
        id,
        threadId: "t1",
        runId,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        createdAt: T0,
        updatedAt: T0,
        type: "user_message",
        messageId: id,
        text,
        attachments,
      },
    },
  } as ThreadEvent;
}

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

// ── start ────────────────────────────────────────────────────────────────────────────────────────

describe("message.dispatch start", () => {
  test("on an idle thread it types, verifies and submits, and emits no run event", async () => {
    const r = rig();
    const out = await r.run({ type: "message.dispatch", threadId: "t1", text: "ship the changelog", mode: "start" });
    expect(out).toEqual(expect.objectContaining({ ok: true }));
    expect(r.pane.texts).toEqual(["ship the changelog"]);
    expect(r.pane.submitted).toEqual(["ship the changelog"]);
    expect(types(r.events).filter((t) => t.startsWith("run."))).toEqual([]);
    // A thread with a journal gets its user item from T03, not from dispatch.
    expect(types(r.events)).not.toContain("turn-item.updated");
    expect(r.store.receipt("c1")).not.toBeNull();
  });

  test("attachments are appended as paths, the way v1's composer does", async () => {
    const r = rig();
    await r.run({
      type: "message.dispatch",
      threadId: "t1",
      text: "look at this ",
      mode: "start",
      attachments: [{ path: "C:\\state\\uploads\\a.png", name: "a.png" }],
    });
    expect(r.pane.submitted).toEqual(["look at this C:\\state\\uploads\\a.png"]);
    expect(messageText("", [{ path: "/x.png", name: "x" }])).toBe("/x.png");
  });

  test("a thread with no journal gets the user message from dispatch", async () => {
    const r = rig({ caps: { ...CLAUDE_CAPS, hasJournal: false } });
    await r.run({ type: "message.dispatch", threadId: "t1", text: "hello agy", mode: "start" });
    const item = r.events.find((e) => e.type === "turn-item.updated");
    expect(item?.type === "turn-item.updated" && item.payload.item).toEqual(
      expect.objectContaining({ type: "user_message", text: "hello agy", runId: null, inputIntent: "turn_start" }),
    );
  });

  test("working is thread-busy; a blocked thread is needs-response with nothing written; archived refuses", async () => {
    const busy = rig({ status: "working" });
    expect(await busy.run({ type: "message.dispatch", threadId: "t1", text: "hi there", mode: "start" })).toEqual(
      expect.objectContaining({ ok: false, status: 409, error: "thread-busy" }),
    );
    for (const status of ["approval", "input"] as const) {
      const blocked = rig({ status });
      expect(await blocked.run({ type: "message.dispatch", threadId: "t1", text: "hi there", mode: "start" })).toEqual(
        expect.objectContaining({ ok: false, error: "needs-response" }),
      );
      expect(blocked.pane.log).toEqual([]);
    }
    const open = rig();
    open.store.append(requestEvents(pendingRequest()));
    expect(await open.run({ type: "message.dispatch", threadId: "t1", text: "hi there", mode: "start" })).toEqual(
      expect.objectContaining({ ok: false, error: "needs-response" }),
    );
    expect(open.pane.log).toEqual([]);
    const gone = rig();
    gone.store.append([{ type: "thread.archived", threadId: "t1", payload: { reason: "user", at: T0 } }]);
    expect(await gone.run({ type: "message.dispatch", threadId: "t1", text: "hi there", mode: "start" })).toEqual(
      expect.objectContaining({ ok: false, error: "thread-archived" }),
    );
    expect(busy.pane.log).toEqual([]);
  });

  test("failed is allowed like idle; starting is busy", async () => {
    const f = rig({ status: "failed" });
    expect(await f.run({ type: "message.dispatch", threadId: "t1", text: "try again", mode: "start" })).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(f.pane.submitted).toEqual(["try again"]);
    const s = rig({ status: "starting" });
    expect(await s.run({ type: "message.dispatch", threadId: "t1", text: "first", mode: "start" })).toEqual(
      expect.objectContaining({ ok: false, error: "thread-busy" }),
    );
    expect(await s.run({ type: "message.dispatch", threadId: "t1", text: "first", mode: "steer" })).toEqual(
      expect.objectContaining({ ok: false, error: "thread-busy" }),
    );
    expect(await s.run({ type: "message.dispatch", threadId: "t1", text: "first", mode: "queue" })).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(s.queue().map((q) => q.text)).toEqual(["first"]);
  });

  test("a guard refusal is answered as dispatch.failed, and the text stays out of the queue", async () => {
    const r = rig();
    r.pane.dialog = true;
    const out = await r.run({ type: "message.dispatch", threadId: "t1", text: "into a dialog", mode: "start" });
    expect(out).toEqual(expect.objectContaining({ ok: true }));
    expect(failed(r.events)).toEqual([expect.objectContaining({ reason: "blocked" })]);
    expect(r.pane.texts).toEqual([]);
    expect(r.queue()).toEqual([]);
  });

  test("a reused pane (new terminal) is not typed into", async () => {
    const r = rig();
    r.view.terminalId = "term-other";
    expect(await r.run({ type: "message.dispatch", threadId: "t1", text: "hello there", mode: "start" })).toEqual(
      expect.objectContaining({ ok: false, error: "pane-gone" }),
    );
    expect(r.pane.log).toEqual([]);
    expect(r.store.receipt("c1")).toBeNull();
  });

  test("bad bodies are refused before anything happens", async () => {
    const r = rig();
    expect(await r.run({ type: "message.dispatch", threadId: "t1", text: "  ", mode: "start" })).toEqual(
      expect.objectContaining({ status: 400, error: "empty-text" }),
    );
    expect(await r.run({ type: "message.dispatch", threadId: "t1", text: "x", mode: "later" })).toEqual(
      expect.objectContaining({ status: 400, error: "bad-mode" }),
    );
    expect(await r.run({ type: "message.dispatch", threadId: "t1", text: "x", mode: "start", attachments: [{ path: 3 }] })).toEqual(
      expect.objectContaining({ status: 400, error: "bad-attachments" }),
    );
    expect(await r.run({ type: "message.dispatch", threadId: "nope", text: "x", mode: "start" })).toEqual(
      expect.objectContaining({ status: 404 }),
    );
    expect(r.pane.log).toEqual([]);
  });
});

// ── queue and drain ──────────────────────────────────────────────────────────────────────────────

describe("message.dispatch queue", () => {
  test("on a working thread it inserts a row and writes nothing", async () => {
    const r = rig({ status: "working" });
    const out = await r.run({ type: "message.dispatch", threadId: "t1", text: "after this", mode: "queue" });
    expect(out).toEqual(expect.objectContaining({ ok: true }));
    expect(r.queue()).toEqual([expect.objectContaining({ text: "after this", position: 0, mode: "queue", state: "queued" })]);
    expect(changes(r.events)).toEqual(["added"]);
    expect(r.pane.log).toEqual([]);
  });

  test("on an idle thread with an empty queue it degrades to start", async () => {
    const r = rig();
    await r.run({ type: "message.dispatch", threadId: "t1", text: "right now", mode: "queue" });
    expect(r.pane.submitted).toEqual(["right now"]);
    expect(r.queue()).toEqual([]);
    expect(types(r.events)).not.toContain("queue.updated");
  });

  test("on an idle thread whose composer is not drawn yet it queues, and sends once the box is there", async () => {
    // A new pane reads idle a second after it opens, before the agent draws its input box (the first
    // message of a new thread was refused as "blocked" and dropped).
    const r = rig();
    r.pane.dialog = true;
    const out = await r.run({ type: "message.dispatch", threadId: "t1", text: "first message", mode: "queue" });
    expect(out).toEqual(expect.objectContaining({ ok: true }));
    await r.idle();
    expect(failed(r.events)).toEqual([]);
    expect(r.queue()).toEqual([expect.objectContaining({ text: "first message", state: "queued" })]);
    expect(r.pane.submitted).toEqual([]);
    r.pane.dialog = false;
    r.timers.advance(DRAIN_RETRY_MS);
    await r.idle();
    expect(r.pane.submitted).toEqual(["first message"]);
    expect(r.queue()).toEqual([]);
  });

  test("a shell thread refuses queue", async () => {
    const r = rig({ caps: NO_CAPABILITIES, harness: "shell", status: "working" });
    expect(await r.run({ type: "message.dispatch", threadId: "t1", text: "ls -la", mode: "queue" })).toEqual(
      expect.objectContaining({ ok: false, error: "queue-unsupported" }),
    );
    expect(r.queue()).toEqual([]);
  });

  test("two queued rows drain one at a time: the second waits for the run the first started", async () => {
    const r = rig({ status: "working" });
    await r.run({ type: "message.dispatch", threadId: "t1", text: "first one", mode: "queue" });
    await r.run({ type: "message.dispatch", threadId: "t1", text: "second one", mode: "queue" });
    expect(r.queue().map((q) => [q.text, q.position])).toEqual([["first one", 0], ["second one", 1]]);

    await r.setStatus("done");
    expect(r.pane.submitted).toEqual(["first one"]);
    expect(r.queue().map((q) => q.text)).toEqual(["second one"]);
    expect(changes(r.events)).toEqual(["added", "added", "sent"]);

    // Still resting (the agent has not picked it up yet): the second one waits.
    await r.setStatus("idle");
    expect(r.pane.submitted).toEqual(["first one"]);

    await r.setStatus("working");
    expect(r.pane.submitted).toEqual(["first one"]);
    await r.setStatus("done");
    expect(r.pane.submitted).toEqual(["first one", "second one"]);
    expect(r.queue()).toEqual([]);
  });

  test("a status update that keeps working (the engine held a done) does not drain", async () => {
    const r = rig({ status: "working" });
    await r.run({ type: "message.dispatch", threadId: "t1", text: "queued text", mode: "queue" });
    r.store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { lastActivityAt: T0 + 5 }, at: T0 } }]);
    await r.setStatus("working");
    await r.idle();
    expect(r.pane.log).toEqual([]);
  });

  test("a run too quick to see still releases the next row after RUN_WAIT_MS", async () => {
    const r = rig({ status: "working" });
    await r.run({ type: "message.dispatch", threadId: "t1", text: "message one", mode: "queue" });
    await r.run({ type: "message.dispatch", threadId: "t1", text: "message two", mode: "queue" });
    await r.setStatus("done");
    expect(r.pane.submitted).toEqual(["message one"]);
    r.timers.advance(20_000);
    await r.idle();
    expect(r.pane.submitted).toEqual(["message one", "message two"]);
  });

  test("drain backs off while the composer is not on screen, then sends", async () => {
    const r = rig({ status: "working" });
    await r.run({ type: "message.dispatch", threadId: "t1", text: "when ready", mode: "queue" });
    r.pane.dialog = true;
    await r.setStatus("done");
    expect(r.pane.texts).toEqual([]);
    expect(r.queue()[0]!.state).toBe("queued");
    r.pane.dialog = false;
    r.timers.advance(DRAIN_RETRY_MS);
    await r.idle();
    expect(r.pane.submitted).toEqual(["when ready"]);
  });

  test("three stalled sends hold the row", async () => {
    const r = rig({ status: "working" });
    await r.run({ type: "message.dispatch", threadId: "t1", text: "never shows", mode: "queue" });
    r.pane.swallowText = true;
    await r.setStatus("done");
    for (let i = 1; i < MAX_DRAIN_FAILURES; i++) {
      expect(r.queue()[0]).toEqual(expect.objectContaining({ state: "queued" }));
      r.timers.advance(DRAIN_RETRY_MS);
      await r.idle();
    }
    expect(r.queue()[0]).toEqual(expect.objectContaining({ state: "held", heldReason: "stalled" }));
    expect(changes(r.events).at(-1)).toBe("held");
    expect(failed(r.events)).toEqual([expect.objectContaining({ reason: "stalled", queuedId: r.queue()[0]!.id })]);
    expect(r.pane.keys.filter((k) => k === "Enter")).toEqual([]);
    // Held rows are not retried.
    r.timers.advance(DRAIN_RETRY_MS * 3);
    await r.setStatus("idle");
    expect(r.pane.texts.length).toBe(MAX_DRAIN_FAILURES);
  });

  test("an error after the text reached the box deletes the row; a blocked send leaves it", async () => {
    const r = rig({ status: "working" });
    await r.run({ type: "message.dispatch", threadId: "t1", text: "half sent", mode: "queue" });
    // Enter fails after the text is in the box.
    const realKeys = r.pane.sendPaneKeys.bind(r.pane);
    r.pane.sendPaneKeys = (paneId, keys) => (keys.includes("Enter") ? Promise.reject(new Error("rpc down")) : realKeys(paneId, keys));
    await r.setStatus("done");
    expect(r.queue()).toEqual([]);
    expect(failed(r.events)).toEqual([expect.objectContaining({ textDelivered: true })]);

    const b = rig({ status: "working" });
    await b.run({ type: "message.dispatch", threadId: "t1", text: "keep me", mode: "queue" });
    // The composer is there for the pre-check, then a dialog comes up before the send's own read.
    let reads = 0;
    const realRead = b.pane.readPane.bind(b.pane);
    b.pane.readPane = (paneId) => {
      reads += 1;
      if (reads === 2) b.pane.dialog = true;
      return realRead(paneId);
    };
    await b.setStatus("done");
    expect(b.pane.texts).toEqual([]);
    expect(b.queue()).toEqual([expect.objectContaining({ text: "keep me", state: "queued", position: 0 })]);
  });

  test("restart: rows load held, nothing is sent, and queue.resume releases them in order", async () => {
    const r = rig({ status: "working", started: false });
    const base = { threadId: "t1", attachments: [], mode: "queue" as const, createdAt: T0 };
    r.store.append([
      {
        type: "queue.updated",
        threadId: "t1",
        payload: {
          messages: [
            { ...base, id: "q1", text: "was sending", position: 0, state: "sending" },
            { ...base, id: "q2", text: "was queued", position: 1, state: "queued" },
          ],
        },
      },
    ]);
    r.dispatcher.start();
    expect(r.queue()).toEqual([
      expect.objectContaining({ id: "q1", state: "held", heldReason: "restart" }),
      expect.objectContaining({ id: "q2", state: "held", heldReason: "restart" }),
    ]);
    await r.setStatus("idle");
    expect(r.pane.log).toEqual([]);

    await r.run({ type: "queue.resume", threadId: "t1" });
    expect(changes(r.events).slice(-2)).toEqual(["resumed", "sent"]);
    expect(r.pane.submitted).toEqual(["was sending"]);
    await r.setStatus("working");
    await r.setStatus("done");
    expect(r.pane.submitted).toEqual(["was sending", "was queued"]);
  });

  test("a closed pane holds its rows", async () => {
    const r = rig({ status: "working" });
    await r.run({ type: "message.dispatch", threadId: "t1", text: "orphan", mode: "queue" });
    r.store.append([{ type: "thread.archived", threadId: "t1", payload: { reason: "pane-closed", at: T0 } }]);
    await r.idle();
    expect(r.queue()).toEqual([expect.objectContaining({ state: "held", heldReason: "pane-closed" })]);
  });
});

// ── steer and interrupt ──────────────────────────────────────────────────────────────────────────

describe("steer", () => {
  test("the interrupt key goes out once; the text is sent only after the thread settles", async () => {
    const r = rig({ status: "working" });
    r.store.append([{ type: "run.started", threadId: "t1", payload: { run: { id: "run1", threadId: "t1", ordinal: 1, status: "running", startedAt: T0 } } }]);
    await r.run({ type: "message.dispatch", threadId: "t1", text: "change of plan", mode: "queue" });
    const out = await r.run({ type: "message.dispatch", threadId: "t1", text: "stop and do this", mode: "steer" });
    expect(out).toEqual(expect.objectContaining({ ok: true }));
    expect(r.pane.keys).toEqual(["Escape"]);
    expect(r.marked).toEqual(["run1"]);
    expect(r.pane.texts).toEqual([]);
    expect(r.queue().map((q) => [q.text, q.mode, q.state, q.position])).toEqual([
      ["stop and do this", "steer", "sending", 0],
      ["change of plan", "queue", "queued", 1],
    ]);

    await r.setStatus("idle");
    // The steer goes; the plain queued row does not overtake it, and waits for the steered run.
    expect(r.pane.submitted).toEqual(["stop and do this"]);
    expect(r.pane.keys.filter((k) => k === "Escape")).toEqual(["Escape"]);
    expect(r.queue().map((q) => q.text)).toEqual(["change of plan"]);
    await r.setStatus("working");
    await r.setStatus("done");
    expect(r.pane.submitted).toEqual(["stop and do this", "change of plan"]);
  });

  test("a timeout holds the row at position 0", async () => {
    const r = rig({ status: "working" });
    await r.run({ type: "message.dispatch", threadId: "t1", text: "queued first", mode: "queue" });
    const pending = r.run({ type: "message.dispatch", threadId: "t1", text: "steer me", mode: "steer" });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    r.timers.advance(STEER_WAIT_MS);
    await pending;
    expect(r.queue().map((q) => [q.text, q.state, q.position, q.heldReason])).toEqual([
      ["steer me", "held", 0, "interrupt-timeout"],
      ["queued first", "queued", 1, undefined],
    ]);
    expect(failed(r.events)).toEqual([expect.objectContaining({ reason: "interrupt-timeout", queuedId: r.queue()[0]!.id })]);
    expect(r.pane.texts).toEqual([]);
  });

  test("steer on an idle thread degrades to start", async () => {
    const r = rig();
    await r.run({ type: "message.dispatch", threadId: "t1", text: "just send", mode: "steer" });
    expect(r.pane.keys).toEqual(["Enter"]);
    expect(r.pane.submitted).toEqual(["just send"]);
  });

  test("a steer while the open run started from /compact becomes a queued row and presses no interrupt key", async () => {
    const r = rig({ status: "working" });
    r.store.append([
      compactItem("u1", "run1", "/compact"),
      { type: "run.started", threadId: "t1", payload: { run: { id: "run1", threadId: "t1", ordinal: 1, userItemId: "u1", status: "running", startedAt: T0 } } },
    ]);
    const out = await r.run({ type: "message.dispatch", threadId: "t1", text: "after it, do this", mode: "steer" });
    expect(out).toEqual(expect.objectContaining({ ok: true }));
    expect(r.pane.keys).toEqual([]);
    expect(r.marked).toEqual([]);
    expect(r.queue().map((q) => [q.text, q.mode, q.state])).toEqual([["after it, do this", "queue", "queued"]]);
    expect(changes(r.events)).toEqual(["added"]);

    await r.setStatus("idle");
    expect(r.pane.submitted).toEqual(["after it, do this"]);
    expect(r.pane.keys).toEqual(["Enter"]);
  });

  test("an unlinked /compact message (trimmed, any case) still counts; one with attachments does not", async () => {
    const r = rig({ status: "working" });
    r.store.append([
      compactItem("u1", null, "  /COMPACT \n"),
      { type: "run.started", threadId: "t1", payload: { run: { id: "run1", threadId: "t1", ordinal: 1, status: "running", startedAt: T0 } } },
    ]);
    await r.run({ type: "message.dispatch", threadId: "t1", text: "later", mode: "steer" });
    expect(r.pane.keys).toEqual([]);
    expect(r.queue().map((q) => q.mode)).toEqual(["queue"]);

    const s = rig({ status: "working" });
    s.store.append([
      compactItem("u1", "run1", "/compact", [{ path: "C:\\a.png", name: "a.png" }]),
      { type: "run.started", threadId: "t1", payload: { run: { id: "run1", threadId: "t1", ordinal: 1, userItemId: "u1", status: "running", startedAt: T0 } } },
    ]);
    await s.run({ type: "message.dispatch", threadId: "t1", text: "steer now", mode: "steer" });
    expect(s.pane.keys).toEqual(["Escape"]);
    expect(s.queue().map((q) => [q.mode, q.state])).toEqual([["steer", "sending"]]);
  });

  test("a /compact from an older run does not stop a steer into the current one", async () => {
    const r = rig({ status: "working" });
    r.store.append([
      compactItem("u0", "run0", "/compact"),
      { type: "run.started", threadId: "t1", payload: { run: { id: "run1", threadId: "t1", ordinal: 2, status: "running", startedAt: T0 } } },
    ]);
    await r.run({ type: "message.dispatch", threadId: "t1", text: "steer now", mode: "steer" });
    expect(r.pane.keys).toEqual(["Escape"]);
  });

  test("an auto-compaction (Thread.compacting, no /compact message) queues a steer like /compact", async () => {
    const r = rig({ status: "working" });
    r.store.append([
      compactItem("u1", "run1", "fix the tests"),
      { type: "run.started", threadId: "t1", payload: { run: { id: "run1", threadId: "t1", ordinal: 1, userItemId: "u1", status: "running", startedAt: T0 } } },
      { type: "thread.updated", threadId: "t1", payload: { patch: { compacting: true }, at: T0 } },
    ]);
    const out = await r.run({ type: "message.dispatch", threadId: "t1", text: "after it, this", mode: "steer" });
    expect(out).toEqual(expect.objectContaining({ ok: true }));
    expect(r.pane.keys).toEqual([]);
    expect(r.queue().map((q) => [q.text, q.mode, q.state])).toEqual([["after it, this", "queue", "queued"]]);
    await r.setStatus("idle");
    expect(r.pane.submitted).toEqual(["after it, this"]);
  });

  test("the compaction row on screen at the steer's key (flag not yet set) requeues it; no Escape", async () => {
    const r = rig({ status: "working" });
    r.store.append([
      compactItem("u1", "run1", "fix the tests"),
      { type: "run.started", threadId: "t1", payload: { run: { id: "run1", threadId: "t1", ordinal: 1, userItemId: "u1", status: "running", startedAt: T0 } } },
    ]);
    const compacting = readFileSync(join(FIXTURES, "..", "live-free-text", "claude--compacting.txt"), "utf8");
    r.pane.screen = () => compacting;
    await r.run({ type: "message.dispatch", threadId: "t1", text: "steer now", mode: "steer" });
    expect(r.pane.keys).toEqual([]);
    expect(r.marked).toEqual([]);
    expect(r.queue().map((q) => [q.text, q.mode, q.state])).toEqual([["steer now", "queue", "queued"]]);
  });

  test("steer with an open runtime request is refused", async () => {
    const r = rig({ status: "working" });
    r.store.append(requestEvents(pendingRequest()));
    expect(await r.run({ type: "message.dispatch", threadId: "t1", text: "go around it", mode: "steer" })).toEqual(
      expect.objectContaining({ ok: false, error: "needs-response" }),
    );
    expect(r.pane.log).toEqual([]);
    expect(r.queue()).toEqual([]);
  });

  test("steer when waiting for background agents delivers directly without interrupt", async () => {
    const r = rig({ status: "working" });
    r.pane.backgroundAgents = true;
    const out = await r.run({ type: "message.dispatch", threadId: "t1", text: "direct send", mode: "steer" });
    expect(out).toEqual(expect.objectContaining({ ok: true }));
    expect(r.pane.keys).toEqual(["Enter"]);
    expect(r.pane.submitted).toEqual(["direct send"]);
  });
});

describe("run.interrupt", () => {
  test("sends the thread's interrupt keys once and marks the open run", async () => {
    const r = rig({ status: "working" });
    r.store.append([{ type: "run.started", threadId: "t1", payload: { run: { id: "run1", threadId: "t1", ordinal: 1, status: "running", startedAt: T0 } } }]);
    expect(await r.run({ type: "run.interrupt", threadId: "t1" })).toEqual(expect.objectContaining({ ok: true }));
    expect(r.pane.keys).toEqual(["Escape"]);
    expect(r.marked).toEqual(["run1"]);
    // No run event of its own.
    expect(types(r.events).filter((t) => t.startsWith("run.") && t !== "run.started")).toEqual([]);
  });

  test("a second press while the thread still reads working is refused (Claude's double Escape opens rewind)", async () => {
    const r = rig({ status: "working" });
    expect(await r.run({ type: "run.interrupt", threadId: "t1" })).toEqual(expect.objectContaining({ ok: true }));
    expect(await r.run({ type: "run.interrupt", threadId: "t1" })).toEqual(
      expect.objectContaining({ ok: false, status: 409, error: "already-interrupting" }),
    );
    expect(r.pane.keys).toEqual(["Escape"]);
    // A steer right after a Stop waits for the stop instead of pressing again.
    await r.run({ type: "message.dispatch", threadId: "t1", text: "then do this instead", mode: "steer" });
    expect(r.pane.keys).toEqual(["Escape"]);
    await r.setStatus("idle");
    expect(r.pane.submitted).toEqual(["then do this instead"]);
    // Once the status has moved on, the next run can be stopped again.
    await r.setStatus("working");
    expect(await r.run({ type: "run.interrupt", threadId: "t1" })).toEqual(expect.objectContaining({ ok: true }));
    expect(r.pane.keys.filter((k) => k === "Escape")).toEqual(["Escape", "Escape"]);
  });

  test("a harness without canInterrupt, a resting thread and an open request are refused", async () => {
    const unsupported = rig({ status: "working", caps: { ...CLAUDE_CAPS, canInterrupt: false } });
    expect(await unsupported.run({ type: "run.interrupt", threadId: "t1" })).toEqual(
      expect.objectContaining({ ok: false, error: "interrupt-unsupported" }),
    );
    const resting = rig({ status: "idle" });
    expect(await resting.run({ type: "run.interrupt", threadId: "t1" })).toEqual(
      expect.objectContaining({ ok: false, error: "not-working" }),
    );
    const asking = rig({ status: "working" });
    asking.store.append(requestEvents(pendingRequest()));
    expect(await asking.run({ type: "run.interrupt", threadId: "t1" })).toEqual(
      expect.objectContaining({ ok: false, error: "needs-response" }),
    );
    for (const r of [unsupported, resting, asking]) expect(r.pane.log).toEqual([]);
  });

  test("the marked run ends interrupted when the status leaves working (T03)", async () => {
    let n = 0;
    const store = openThreadStore(":memory:", { now: () => T0, newId: () => `j${++n}`, log: () => {} });
    store.append([
      createProject(),
      createThread(thread("t1", { paneId: PANE, terminalId: "term-t1", status: "working", capabilities: CLAUDE_CAPS })),
    ]);
    const pane = new FakeClaude();
    const view = { paneId: PANE, terminalId: "term-t1", agent: "claude", kind: "agent", status: "working" } as AgentView;
    const engine = {
      current: (): EngineSnapshot => ({ agents: [view], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }),
      onUpdate: () => () => {},
    };
    const journal = createJournalIngestor({
      store,
      engine,
      herdr: pane as unknown as HerdrClient,
      journals: null,
      transcripts: null,
      watchers: createThreadWatchers(),
      now: () => T0,
      log: () => {},
      pollMs: 60_000,
    });
    const queue = createPaneQueue();
    const dispatcher = createDispatcher({
      store,
      sender: createGuardedSender(pane as unknown as HerdrClient, cfg, engine, queue, noSleep),
      herdr: pane as unknown as HerdrClient,
      engine,
      queue,
      journal,
      timers: new FakeTimers(),
      sleep: noSleep,
      log: () => {},
    });
    journal.start();
    dispatcher.start();
    cleanups.push(() => {
      journal.stop();
      dispatcher.stop();
      store.close();
    });
    await journal.settled();
    const run = store.openRun("t1");
    expect(run).not.toBeNull();

    const out = await dispatcher.effects["run.interrupt"]!(
      { commandId: "c1", type: "run.interrupt", threadId: "t1" },
      { commandId: "c1", receipt: { type: "run.interrupt", result: { hash: "h" } } },
    );
    expect(out.ok).toBe(true);
    store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { status: "idle" }, at: T0 } }]);
    await journal.settled();
    expect(store.getRun(run!.id)?.status).toBe("interrupted");
  });
});

// ── queued.* ─────────────────────────────────────────────────────────────────────────────────────

describe("queued.reorder, queued.edit, queued.cancel", () => {
  async function three() {
    const r = rig({ status: "working" });
    for (const text of ["a", "b", "c"]) await r.run({ type: "message.dispatch", threadId: "t1", text: `msg ${text}`, mode: "queue" });
    return r;
  }

  test("reorder rewrites positions and emits reordered; a stale list is refused", async () => {
    const r = await three();
    const [a, b, c] = r.queue().map((q) => q.id);
    expect(await r.run({ type: "queued.reorder", threadId: "t1", ids: [c, a, b] })).toEqual(expect.objectContaining({ ok: true }));
    expect(r.queue().map((q) => [q.text, q.position])).toEqual([["msg c", 0], ["msg a", 1], ["msg b", 2]]);
    expect(changes(r.events).at(-1)).toBe("reordered");
    expect(await r.run({ type: "queued.reorder", threadId: "t1", ids: [a, b] })).toEqual(
      expect.objectContaining({ ok: false, error: "queue-changed" }),
    );
  });

  test("edit changes the text; cancel removes the row and closes the gap", async () => {
    const r = await three();
    const [a, b] = r.queue().map((q) => q.id);
    await r.run({ type: "queued.edit", id: b, text: "msg B!" });
    expect(r.queue().map((q) => q.text)).toEqual(["msg a", "msg B!", "msg c"]);
    await r.run({ type: "queued.cancel", id: a });
    expect(r.queue().map((q) => [q.text, q.position])).toEqual([["msg B!", 0], ["msg c", 1]]);
    expect(changes(r.events).slice(-2)).toEqual(["edited", "cancelled"]);
  });

  test("a sending row cannot be edited or cancelled", async () => {
    const r = rig({ status: "working" });
    await r.run({ type: "message.dispatch", threadId: "t1", text: "steering", mode: "steer" });
    const id = r.queue()[0]!.id;
    expect(r.queue()[0]!.state).toBe("sending");
    expect(await r.run({ type: "queued.edit", id, text: "other" })).toEqual(expect.objectContaining({ ok: false, error: "already-sending" }));
    expect(await r.run({ type: "queued.cancel", id })).toEqual(expect.objectContaining({ ok: false, error: "already-sending" }));
  });
});

// ── through the command route ────────────────────────────────────────────────────────────────────

describe("POST /api/v2/command", () => {
  test("an idempotent replay of the same commandId inserts one row", async () => {
    const r = rig({ status: "working" });
    const gate = createV2Gate({ log: () => {} });
    await gate.check({ serverVersion: async () => "0.9.0" });
    const routes = createV2Routes({
      cfg: { allowAnyHost: true, allowedOrigins: [], publicHosts: [], tailscaleHosts: [], deviceAllowlist: [] } as unknown as Config,
      store: r.store,
      gate,
      engine: { current: () => ({ agents: [r.view], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }) },
      activity: { noteSeen: () => false, noteUnseen: () => false },
      queue: createPaneQueue(),
      effects: r.dispatcher.effects,
    });
    cleanups.push(() => routes.close());
    const post = () =>
      new Request("http://localhost/api/v2/command", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
        body: JSON.stringify({ commandId: "same-1", type: "message.dispatch", threadId: "t1", text: "once only", mode: "queue" }),
      });
    const first = await routes.handle(post(), new URL("http://localhost/api/v2/command"))!;
    const second = await routes.handle(post(), new URL("http://localhost/api/v2/command"))!;
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(r.queue().map((q) => q.text)).toEqual(["once only"]);
  });
});
