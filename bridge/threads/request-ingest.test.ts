import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimeRequest, ThreadStatus, TurnItem } from "../../shared/v2/contracts.ts";
import { ACTIVITY_KEY } from "../activity.ts";
import { AuditLog } from "../audit.ts";
import type { Config } from "../config.ts";
import type { HerdrClient, PaneRead } from "../herdr-client.ts";
import { createPaneQueue, paneKey, type PaneQueue } from "../pane-queue.ts";
import { keysPane } from "../pane-write-routes.ts";
import type { AgentView, EngineSnapshot } from "../state-engine.ts";
import { createProject, createThread, project, thread } from "../test/thread-fixtures.ts";
import { createHerdIngestor } from "./herd-ingest.ts";
import { bindingHash, createRequestIngestor, REQUEST_READ_LINES, RESOLVED_GRACE_MS, type RequestIngestor } from "./request-ingest.ts";
import { requestItemId } from "./request-items.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const PERMISSION = fixture("claude--permission-bash.txt");
const PERMISSION_EDIT = fixture("claude--permission-edit.txt");
const SELECT = fixture("claude--select-menu.txt");
const DONE = fixture("claude--done.txt");
const WORKING = fixture("claude--working.txt");
const MARKER = "whistlr.decision thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee run=5a81defb";

const T0 = 1_800_000_000_000;
const PANE = "w1:p-t1";
const cfg = { submitKeys: ["Enter"], readLines: 200, deviceAllowlist: [], notifyDelayMs: 0 } as unknown as Config;
const noSleep = async () => {};

/** A pane whose screen the test sets; records every read and key write, in order. */
class FakePane {
  screen: string;
  log: string[] = [];
  reads: { source: string; lines: number; format: string }[] = [];
  keyWrites: string[][] = [];
  /** Called after each key write (e.g. the dialog goes away). */
  onKey: ((key: string) => void) | null = null;
  failReads = false;
  constructor(screen: string) {
    this.screen = screen;
  }
  async readPane(paneId: string, source: string, lines: number, format = "text"): Promise<PaneRead> {
    this.reads.push({ source, lines, format });
    this.log.push(`read:${source}`);
    if (this.failReads) throw new Error("herdr down");
    return { pane_id: paneId, text: this.screen, truncated: false, revision: 0 };
  }
  async sendPaneKeys(_paneId: string, keys: string[]): Promise<void> {
    this.keyWrites.push([...keys]);
    for (const k of keys) {
      this.log.push(`key:${k}`);
      this.onKey?.(k);
    }
  }
  async sendPaneText(_paneId: string, text: string): Promise<void> {
    this.log.push(`text:${text}`);
  }
}

interface Rig {
  store: ThreadStore;
  pane: FakePane;
  view: AgentView;
  ingestor: RequestIngestor;
  queue: PaneQueue;
  clock: { now: number };
  audit: string[];
  setStatus(status: ThreadStatus): void;
  pending(): RuntimeRequest[];
  item(requestId: string): TurnItem | null;
}

const stores: ThreadStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function rig(opts: { screen?: string; agent?: string; status?: ThreadStatus } = {}): Rig {
  const clock = { now: T0 };
  let n = 0;
  const newId = () => `id${++n}`;
  const store = openThreadStore(":memory:", { now: () => clock.now, newId });
  stores.push(store);
  const agent = opts.agent ?? "claude";
  store.append([
    createProject(project()),
    createThread(thread("t1", { paneId: PANE, terminalId: "term-t1", harness: agent, status: opts.status ?? "input" })),
  ]);
  const pane = new FakePane(opts.screen ?? PERMISSION);
  const view: AgentView = {
    paneId: PANE,
    terminalId: "term-t1",
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent,
    status: "blocked",
    cwd: "C:\\code\\demo",
    focused: false,
    kind: "agent",
  };
  const snap = (): EngineSnapshot => ({ agents: [view], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" });
  const queue = createPaneQueue();
  const audit: string[] = [];
  const ingestor = createRequestIngestor({
    store,
    engine: { current: snap, onUpdate: () => () => {} },
    herdr: pane as unknown as HerdrClient,
    queue,
    cfg,
    audit: new AuditLog((line) => void audit.push(line)),
    now: () => clock.now,
    newId,
    log: () => {},
    sleep: noSleep,
  });
  return {
    store,
    pane,
    view,
    ingestor,
    queue,
    clock,
    audit,
    setStatus(status) {
      store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { status }, at: clock.now } }]);
    },
    pending: () => store.pendingRequests(),
    item: (requestId) => store.getTurnItem(requestItemId(requestId)),
  };
}

const respond = (r: Rig, requestId: string, optionIndex?: number, commandId?: string) =>
  r.ingestor.respond({ requestId, ...(optionIndex !== undefined ? { optionIndex } : {}) }, commandId ? { commandId } : {});

describe("request ingest — open and update", () => {
  test("a Claude permission opens one pending request; the thread goes to approval", async () => {
    const r = rig();
    const before = r.store.lastSequence();
    await r.ingestor.poll();

    expect(r.pane.reads).toEqual([{ source: "visible", lines: REQUEST_READ_LINES, format: "ansi" }]);
    const [req, ...rest] = r.pending();
    expect(rest).toEqual([]);
    expect(req).toMatchObject({
      threadId: "t1",
      kind: "permission",
      prompt: "Do you want to proceed?",
      status: "pending",
      createdAt: T0,
    });
    expect(req!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(r.store.getThread("t1")!.status).toBe("approval");

    // The bound text stays on the bridge; the wire carries only its hash.
    const bound = r.store.requestBoundText(req!.id)!;
    expect(bound.split("\n")).toHaveLength(12);
    expect(req!.bindingHash).toBe(bindingHash(bound));
    const wire = r.store.eventsAfter(before);
    expect(wire.map((e) => e.type)).toEqual(["runtime-request.updated", "turn-item.updated", "thread.updated"]);
    expect(JSON.stringify(wire)).not.toContain("boundText");
    expect(bound).toContain("This command requires approval");
    expect(JSON.stringify(wire)).not.toContain("This command requires approval");

    // The timeline item mirrors T3's approval_request.
    expect(r.item(req!.id)).toMatchObject({
      type: "approval_request",
      requestId: req!.id,
      requestKind: "permission",
      prompt: "Do you want to proceed?",
      status: "waiting",
      runId: null,
      completedAt: null,
      options: [{ label: "Yes" }, { label: expect.stringContaining("Yes, and don") }, { label: "No" }],
    });
  });

  test("the same screen next poll writes nothing", async () => {
    const r = rig();
    await r.ingestor.poll();
    const seq = r.store.lastSequence();
    await r.ingestor.poll();
    await r.ingestor.poll();
    expect(r.store.lastSequence()).toBe(seq);
    expect(r.pane.reads).toHaveLength(3);
  });

  test("a different dialog expires the old request and opens a new one", async () => {
    const r = rig();
    await r.ingestor.poll();
    const first = r.pending()[0]!;
    r.pane.screen = PERMISSION_EDIT;
    r.clock.now += 1_000;
    await r.ingestor.poll();

    const second = r.pending()[0]!;
    expect(r.pending()).toHaveLength(1);
    expect(second.id).not.toBe(first.id);
    expect(second.prompt).toBe("Do you want to create hello.txt?");
    expect(r.store.getRequest(first.id)).toMatchObject({ status: "expired", updatedAt: T0 + 1_000 });
    expect(r.item(first.id)).toMatchObject({ status: "cancelled", completedAt: T0 + 1_000 });
    expect(r.item(second.id)).toMatchObject({ status: "waiting" });
  });

  test("a question stays input and becomes a user_input_request item", async () => {
    const r = rig({ screen: SELECT, status: "input" });
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(req.kind).toBe("question");
    expect(r.store.getThread("t1")!.status).toBe("input");
    expect(r.item(req.id)).toMatchObject({
      type: "user_input_request",
      requestId: req.id,
      questions: [
        {
          question: "Which color theme should the dashboard use?",
          options: [
            { label: "Red", description: expect.stringContaining("warm") },
            { label: "Green" },
            { label: "Blue" },
            { label: "Chat about this" },
          ],
        },
      ],
    });
  });

  test("the request belongs to the open run", async () => {
    const r = rig();
    r.store.append([
      { type: "run.started", threadId: "t1", payload: { run: { id: "r1", threadId: "t1", ordinal: 1, status: "running", startedAt: T0 } } },
    ]);
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(req.runId).toBe("r1");
    expect(r.item(req.id)!.runId).toBe("r1");
  });

  test("a failed read keeps the request and tries again next poll", async () => {
    const r = rig();
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    const seq = r.store.lastSequence();
    r.pane.failReads = true;
    await r.ingestor.poll();
    expect(r.store.lastSequence()).toBe(seq);
    expect(r.pending()).toEqual([req]);
    r.pane.failReads = false;
    await r.ingestor.poll();
    expect(r.pending()).toEqual([req]);
  });

  test("a resting thread is not read", async () => {
    const r = rig({ status: "idle" });
    await r.ingestor.poll();
    expect(r.pane.reads).toEqual([]);
    expect(r.pending()).toEqual([]);
  });
});

describe("request ingest — parse miss", () => {
  test("a blocked pane whose screen does not parse makes no request and stays input", async () => {
    const r = rig({ screen: WORKING, status: "approval" });
    await r.ingestor.poll();
    expect(r.pending()).toEqual([]);
    expect(r.store.getThread("t1")!.status).toBe("input");
    expect(r.pane.keyWrites).toEqual([]);
  });

  test("an agent with no parser makes no request", async () => {
    const r = rig({ agent: "codex" });
    await r.ingestor.poll();
    expect(r.pending()).toEqual([]);
  });
});

describe("request ingest — close", () => {
  test("dialog gone after a respond: resolved, and stays resolved", async () => {
    const r = rig();
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    r.pane.onKey = () => {
      r.pane.screen = WORKING;
    };
    const res = await respond(r, req.id, 0);
    expect(res.ok).toBe(true);
    r.setStatus("working");
    await r.ingestor.poll();
    expect(r.store.getRequest(req.id)).toMatchObject({ status: "resolved", optionIndex: 0 });
    expect(r.item(req.id)).toMatchObject({ status: "completed" });
  });

  test("dialog gone with no respond: expired, thread back to input", async () => {
    const r = rig();
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    r.pane.screen = DONE;
    r.clock.now += 500;
    await r.ingestor.poll();
    expect(r.store.getRequest(req.id)).toMatchObject({ status: "expired", updatedAt: T0 + 500 });
    expect(r.item(req.id)).toMatchObject({ status: "cancelled" });
    expect(r.store.getThread("t1")!.status).toBe("input");
  });

  test("the thread stops waiting (answered at the desk): expired without a read", async () => {
    const r = rig();
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    r.setStatus("working");
    const reads = r.pane.reads.length;
    await r.ingestor.poll();
    expect(r.pane.reads.length).toBe(reads);
    expect(r.store.getRequest(req.id)!.status).toBe("expired");
    expect(r.store.getThread("t1")!.status).toBe("working");
  });

  test("the pane closing archives the thread and expires the request and its item (T02)", async () => {
    const r = rig();
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    const herd = createHerdIngestor({
      store: r.store,
      engine: { onUpdate: () => () => {}, onTransition: () => () => {} },
      activity: { get: (_key: typeof ACTIVITY_KEY, _pane: string) => undefined },
      journals: null,
      now: () => r.clock.now,
      log: () => {},
    });
    const gone: EngineSnapshot = { agents: [], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" };
    herd.reconcile(gone); // the first reconcile treats a missing pane as closed while down
    expect(r.store.getThread("t1")!.shelf).toBe("archived");
    expect(r.store.getRequest(req.id)!.status).toBe("expired");
    expect(r.item(req.id)).toMatchObject({ status: "cancelled" });
  });

  test("the screen right after a respond does not reopen the answered dialog", async () => {
    const r = rig();
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    await respond(r, req.id, 0); // the keys do nothing: the dialog is still on screen
    await r.ingestor.poll();
    expect(r.pending()).toEqual([]);
    // Still there past the grace: the keys did not take, so it can be answered again.
    r.clock.now += RESOLVED_GRACE_MS;
    await r.ingestor.poll();
    expect(r.pending()).toHaveLength(1);
    expect(r.pending()[0]!.id).not.toBe(req.id);
  });
});

describe("runtime-request.respond", () => {
  test("happy: keys go out one per write, in order; resolved with the receipt and an audit line", async () => {
    const r = rig({ agent: "cursor", screen: fixture("cursor--ask-fruit.txt") });
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(req.options[2]!.keys).toEqual(["Down", "Down", "Enter"]);
    const reads = r.pane.reads.length;

    const res = await respond(r, req.id, 2, "cmd-1");
    expect(res).toMatchObject({ ok: true, request: { status: "resolved", optionIndex: 2 } });
    expect(r.pane.reads.slice(reads)).toEqual([{ source: "visible", lines: 200, format: "ansi" }]);
    expect(r.pane.keyWrites).toEqual([["Down"], ["Down"], ["Enter"]]);
    expect(r.store.getRequest(req.id)).toMatchObject({ status: "resolved", optionIndex: 2 });
    expect(r.item(req.id)).toMatchObject({ status: "completed", completedAt: T0 });
    expect(r.store.receipt("cmd-1")).toMatchObject({ type: "runtime-request.respond", result: { requestId: req.id, optionIndex: 2 } });
    expect(res.ok && res.sequence).toBe(r.store.lastSequence());
    await Bun.sleep(0);
    expect(r.audit).toHaveLength(1);
    expect(JSON.parse(r.audit[0]!)).toMatchObject({
      action: "keys",
      paneId: PANE,
      detail: { keys: ["Down", "Down", "Enter"], promptBinding: { checked: true, passed: true } },
    });
  });

  test("Pi's ask (live 2026-10-18): a question card walked by arrows, answered by Down then Enter", async () => {
    const r = rig({ agent: "pi", screen: fixture("pi--ask-radio-recommended.txt") });
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(req).toMatchObject({ kind: "question", prompt: "Pick an animal" });
    expect(req.options.map((o) => [o.label, o.keys])).toEqual([
      ["Cat (Recommended)", ["Enter"]],
      ["Dog", ["Down", "Enter"]],
    ]);
    expect(r.store.getThread("t1")!.status).toBe("input");
    const res = await respond(r, req.id, 1, "cmd-pi");
    expect(res).toMatchObject({ ok: true, request: { status: "resolved", optionIndex: 1 } });
    expect(r.pane.keyWrites).toEqual([["Down"], ["Enter"]]);
  });

  test("stale: the screen changed since the read, so nothing is sent and the request expires", async () => {
    const r = rig();
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    r.pane.screen = PERMISSION_EDIT;
    const res = await respond(r, req.id, 0, "cmd-2");
    expect(res).toEqual({ ok: false, code: "prompt-changed", reason: "prompt changed" });
    expect(r.pane.keyWrites).toEqual([]);
    expect(r.store.getRequest(req.id)!.status).toBe("expired");
    expect(r.item(req.id)).toMatchObject({ status: "cancelled" });
    await Bun.sleep(0);
    expect(JSON.parse(r.audit[0]!)).toMatchObject({ action: "keys", detail: { sent: false, promptBinding: { passed: false } } });
  });

  test("bad requests send nothing", async () => {
    const r = rig();
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(await respond(r, "nope", 0)).toMatchObject({ ok: false, code: "not_found" });
    expect(await respond(r, req.id, 3)).toMatchObject({ ok: false, code: "invalid", reason: "bad-option" });
    expect(await respond(r, req.id, -1)).toMatchObject({ ok: false, code: "invalid" });
    expect(await respond(r, req.id, 0.5)).toMatchObject({ ok: false, code: "invalid" });
    expect(await respond(r, req.id)).toMatchObject({ ok: false, code: "invalid" });
    expect(await r.ingestor.respond({ requestId: req.id, optionIndices: [0, 1] })).toMatchObject({ ok: false, code: "invalid" });
    expect(r.pane.keyWrites).toEqual([]);

    expect((await respond(r, req.id, 0)).ok).toBe(true);
    expect(await respond(r, req.id, 0)).toMatchObject({ ok: false, code: "conflict", reason: "not-pending" });
    expect(r.pane.keyWrites).toEqual([["1"]]);
  });

  test("a password prompt cannot be answered with respond", async () => {
    const r = rig({ screen: DONE + "\n$ sudo ls\n[sudo] password for bart: " });
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(req).toMatchObject({ kind: "password", options: [] });
    expect(r.store.getThread("t1")!.status).toBe("input");
    expect(await respond(r, req.id, 0)).toMatchObject({ ok: false, code: "invalid", reason: "password" });
    expect(r.pane.keyWrites).toEqual([]);
  });

  test("a respond and a concurrent write on the same pane run one after the other", async () => {
    const r = rig();
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Stands in for T06's message.dispatch, which takes the same pane queue.
    const dispatch = r.queue.run(paneKey(PANE), async () => {
      r.pane.log.push("dispatch:start");
      await gate;
      r.pane.log.push("dispatch:end");
    });
    const answered = respond(r, req.id, 0);
    await Bun.sleep(5);
    expect(r.pane.log.at(-1)).toBe("dispatch:start");
    release();
    await Promise.all([dispatch, answered]);
    expect(r.pane.log.slice(r.pane.log.indexOf("dispatch:start"))).toEqual(["dispatch:start", "dispatch:end", "read:visible", "key:1"]);
  });

  test("a request the ingestor expired while respond waited for the pane sends nothing", async () => {
    const r = rig();
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const busy = r.queue.run(paneKey(PANE), () => gate);
    const answered = respond(r, req.id, 0);
    r.setStatus("working");
    const polled = r.ingestor.poll();
    release();
    await Promise.all([busy, polled]);
    expect(await answered).toMatchObject({ ok: false, code: "conflict" });
    expect(r.pane.keyWrites).toEqual([]);
  });
});

describe("whistlr-marked draftr cards", () => {
  test("published via whistlr with the decision and no keys; respond is refused", async () => {
    const r = rig({ screen: `${SELECT}\n${MARKER}\n` });
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(req).toMatchObject({
      kind: "question",
      via: "whistlr",
      decision: { thread: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", run: "5a81defb" },
    });
    expect(req.options.length).toBeGreaterThan(0);
    expect(req.options.every((o) => o.keys.length === 0)).toBe(true);
    expect(await respond(r, req.id, 0)).toMatchObject({ ok: false, code: "invalid", reason: "whistlr-card" });
    expect(r.pane.keyWrites).toEqual([]);
    expect(r.pane.log.filter((l) => l.startsWith("text:"))).toEqual([]);
  });
});

describe("v1 keys route (regression)", () => {
  test("keysPane with expected_prompt still reads recent and 409s on a changed screen", async () => {
    const pane = new FakePane(PERMISSION_EDIT);
    const req = new Request(`http://127.0.0.1:8787/api/pane/${PANE}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["1"], expected_prompt: " Do you want to proceed?\n ❯ 1. Yes" }),
    });
    const res = await keysPane(pane as unknown as HerdrClient, cfg, PANE, req, createPaneQueue(), undefined, noSleep);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "prompt_changed" });
    expect(pane.reads.map((x) => x.source)).toEqual(["recent"]);
    expect(pane.keyWrites).toEqual([]);
  });
});

// ── T17: wizard, checkbox and preview dialogs ───────────────────────────────────────────────────

const TOPPINGS = ["Cheese", "Mushrooms", "Olives", "Peppers"];
/** Rows the ❯ pointer walks on Claude's checkbox ask: the boxes, Type something, Submit, Chat. */
const ROW_SUBMIT = TOPPINGS.length + 1;
const ROW_CHAT = TOPPINGS.length + 2;

/** Claude's single-question checkbox ask as plain text, in any box and pointer state. */
function claudeCheckbox(checked: readonly boolean[], row: number): string {
  const rows = ["❯ order a pizza", "", "─".repeat(60), `←  ${checked.some(Boolean) ? "☒" : "☐"} Toppings  ✔ Submit  →`, ""];
  rows.push("Which pizza toppings do you want?", "");
  TOPPINGS.forEach((label, i) => {
    rows.push(`${row === i ? "❯" : " "} ${i + 1}. [${checked[i] ? "✔" : " "}] ${label}`, `     ${label} on top.`);
  });
  rows.push(`${row === TOPPINGS.length ? "❯" : " "} 5. [ ] Type something`, `${row === ROW_SUBMIT ? "❯" : " "}    Submit`);
  rows.push("─".repeat(60), `${row === ROW_CHAT ? "❯" : " "} 6. Chat about this`, "", "Enter to select · ↑/↓ to navigate · Esc to cancel");
  return rows.join("\n");
}

/** Wire `r.pane` to a Claude checkbox ask that reacts to keys like the TUI. */
function claudeCheckboxSim(r: Rig, start: boolean[], row = 0) {
  const state = { checked: [...start], row, submitted: false };
  const draw = () => {
    r.pane.screen = state.submitted ? fixture("claude--select-multiselect-review.txt") : claudeCheckbox(state.checked, state.row);
  };
  draw();
  r.pane.onKey = (key) => {
    // A digit toggles its box and leaves the pointer where it is (seen live on Claude Code 2.1.301).
    if (/^[1-4]$/.test(key)) {
      state.checked[Number(key) - 1] = !state.checked[Number(key) - 1];
    } else if (key === "Down") state.row = Math.min(state.row + 1, ROW_CHAT);
    else if (key === "Up") state.row = Math.max(state.row - 1, 0);
    else if (key === "Enter" && state.row === ROW_SUBMIT) state.submitted = true;
    draw();
  };
  return state;
}

const respondMany = (r: Rig, requestId: string, optionIndices: number[], commandId?: string) =>
  r.ingestor.respond({ requestId, optionIndices }, commandId ? { commandId } : {});

describe("T17 — checkbox (multi-select) asks", () => {
  test("published with its boxes; the timeline item is a T3 multiSelect question", async () => {
    const r = rig({ screen: claudeCheckbox([false, true, false, false], 0) });
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(req).toMatchObject({
      kind: "question",
      prompt: "Which pizza toppings do you want?",
      multiSelect: { checked: [false, true, false, false], advanceLabel: "Submit" },
    });
    expect(req.options.map((o) => o.label)).toEqual([...TOPPINGS, "Chat about this"]);
    expect(req.options.at(-1)).toMatchObject({ keys: ["6"], destructive: true });
    // The binding is the dialog's own region, not a 12-line tail.
    expect(r.store.requestBoundText(req.id)).toContain("Which pizza toppings do you want?");
    expect(r.item(req.id)).toMatchObject({
      type: "user_input_request",
      questions: [{ id: "q1", header: "Question", question: "Which pizza toppings do you want?", multiSelect: true }],
    });
    const item = r.item(req.id)!;
    expect(item.type === "user_input_request" && item.questions[0]!.options.map((o) => o.label)).toEqual(TOPPINGS);
  });

  test("optionIndices toggles only the boxes that differ, walks to Submit, verifies, then Enter", async () => {
    const r = rig();
    const sim = claudeCheckboxSim(r, [false, true, false, false]);
    await r.ingestor.poll();
    const req = r.pending()[0]!;

    const res = await respondMany(r, req.id, [2, 0], "cmd-m");
    expect(res).toMatchObject({ ok: true, request: { status: "resolved", optionIndices: [0, 2] } });
    // 1 on, 2 off, 3 on, then Down from the first row past Type something to Submit, and Enter.
    expect(r.pane.keyWrites).toEqual([["1"], ["2"], ["3"], ["Down"], ["Down"], ["Down"], ["Down"], ["Down"], ["Enter"]]);
    expect(sim).toMatchObject({ checked: [true, false, true, false], submitted: true });
    expect(r.store.receipt("cmd-m")).toMatchObject({ result: { requestId: req.id, optionIndices: [0, 2] } });
    await Bun.sleep(0);
    expect(JSON.parse(r.audit.at(-1)!)).toMatchObject({
      action: "keys",
      detail: { keys: ["1", "2", "3", "Down", "Down", "Down", "Down", "Down", "Enter"], recipe: "multi-select" },
    });
  });

  test("a box flipped at the desk during the walk: no Enter, prompt-changed, the request expires", async () => {
    const r = rig();
    const sim = claudeCheckboxSim(r, [false, false, false, false]);
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    const press = r.pane.onKey!;
    r.pane.onKey = (key) => {
      press(key);
      if (key === "Down") {
        sim.checked[3] = true;
        r.pane.screen = claudeCheckbox(sim.checked, sim.row);
      }
    };
    expect(await respondMany(r, req.id, [0])).toEqual({ ok: false, code: "prompt-changed", reason: "prompt changed" });
    expect(r.pane.keyWrites.flat()).not.toContain("Enter");
    expect(r.store.getRequest(req.id)!.status).toBe("expired");
  });

  test("a screen that changed before the answer sends nothing", async () => {
    const r = rig();
    claudeCheckboxSim(r, [false, false, false, false]);
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    r.pane.screen = claudeCheckbox([false, false, true, false], 2);
    expect(await respondMany(r, req.id, [0])).toMatchObject({ ok: false, code: "prompt-changed" });
    expect(r.pane.keyWrites).toEqual([]);
  });

  test("bad answers: a box by optionIndex, indices out of range or repeated, both fields", async () => {
    const r = rig();
    claudeCheckboxSim(r, [false, false, false, false]);
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(await respond(r, req.id, 0)).toMatchObject({ ok: false, code: "invalid", reason: "use-option-indices" });
    expect(await respondMany(r, req.id, [4])).toMatchObject({ ok: false, code: "invalid", reason: "bad-option" });
    expect(await respondMany(r, req.id, [1, 1])).toMatchObject({ ok: false, code: "invalid", reason: "bad-option" });
    expect(await r.ingestor.respond({ requestId: req.id, optionIndex: 4, optionIndices: [0] })).toMatchObject({
      ok: false,
      code: "invalid",
      reason: "both-answers",
    });
    expect(r.pane.keyWrites).toEqual([]);
    // Chat about this is a plain option: its digit.
    expect(await respond(r, req.id, 4)).toMatchObject({ ok: true });
    expect(r.pane.keyWrites).toEqual([["6"]]);
  });

  test("optionIndices on a permission request is invalid", async () => {
    const r = rig();
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(await respondMany(r, req.id, [0])).toMatchObject({ ok: false, code: "invalid", reason: "not-multi-select" });
    expect(r.pane.keyWrites).toEqual([]);
  });

  test("the review step is Submit and Cancel with the echoed answers", async () => {
    const r = rig({ screen: fixture("claude--select-multiselect-review.txt") });
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(req.answers).toEqual([{ question: "Which pizza toppings do you want?", answer: "Cheese, Pepperoni" }]);
    expect(req.options.map((o) => o.label)).toEqual(["Submit", "Cancel"]);
    expect(await respond(r, req.id, 0)).toMatchObject({ ok: true });
    expect(r.pane.keyWrites).toEqual([["1"]]);
  });
});

describe("T17 — wizard asks", () => {
  test("a step carries the stepper and is answered by its digit", async () => {
    const r = rig({ screen: fixture("claude--wizard-q2.txt") });
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(req.steps).toEqual([
      { label: "Focus area", answered: true, current: false },
      { label: "Scope", answered: false, current: true },
      { label: "Workflow", answered: false, current: false },
    ]);
    expect(r.item(req.id)).toMatchObject({ questions: [{ id: "q2", header: "Scope" }] });
    expect(await respond(r, req.id, 1)).toMatchObject({ ok: true, request: { optionIndex: 1 } });
    expect(r.pane.keyWrites).toEqual([["2"]]);
  });

  test("the review submits with its own key", async () => {
    const r = rig({ screen: fixture("claude--wizard-submit.txt") });
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(req.answers).toHaveLength(3);
    expect(req.options).toEqual([
      { label: "Submit", keys: ["1"] },
      { label: "Cancel", keys: ["2"], destructive: true },
    ]);
    expect(await respond(r, req.id, 0)).toMatchObject({ ok: true });
    expect(r.pane.keyWrites).toEqual([["1"]]);
  });
});

describe("T17 — preview selects", () => {
  const PREVIEW = fixture("claude--select-preview.txt");
  /** The preview screen with the ❯ pointer moved from Boxy to Rounded. */
  const pointedAtRounded = () => {
    const lines = PREVIEW.split("\n");
    const i = lines.findIndex((l) => l.includes(" 1.") && l.includes("Boxy"));
    lines[i] = lines[i]!.replace("❯", " ");
    lines[i + 1] = "❯" + lines[i + 1]!.slice(1);
    return lines.join("\n");
  };

  test("the digit moves the pointer; Enter goes out only once a read shows it on that option", async () => {
    const r = rig({ screen: PREVIEW });
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(req.preview).toMatchObject({ optionIndex: 0 });
    expect(req.preview!.lines.length).toBeGreaterThan(3);
    r.pane.onKey = (key) => {
      if (key === "2") r.pane.screen = pointedAtRounded();
      if (key === "Enter") r.pane.screen = DONE;
    };
    expect(await respond(r, req.id, 1, "cmd-p")).toMatchObject({ ok: true, request: { status: "resolved", optionIndex: 1 } });
    expect(r.pane.keyWrites).toEqual([["2"], ["Enter"]]);
  });

  test("a pointer that never moves: no Enter, prompt-changed", async () => {
    const r = rig({ screen: PREVIEW });
    await r.ingestor.poll();
    const req = r.pending()[0]!;
    expect(await respond(r, req.id, 2)).toMatchObject({ ok: false, code: "prompt-changed" });
    expect(r.pane.keyWrites).toEqual([["3"]]);
    expect(r.store.getRequest(req.id)!.status).toBe("expired");
  });
});
