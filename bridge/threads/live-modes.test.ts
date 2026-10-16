import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { capabilitiesFor } from "../../shared/agents.ts";
import { NO_CAPABILITIES, type Command, type RuntimeRequest, type ThreadCapabilities, type ThreadEvent, type ThreadStatus } from "../../shared/v2/contracts.ts";
import type { Config } from "../config.ts";
import { createGuardedSender } from "../guarded-send-route.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { createPaneQueue } from "../pane-queue.ts";
import type { AgentView, EngineSnapshot } from "../state-engine.ts";
import { createProject, createThread, thread } from "../test/thread-fixtures.ts";
import { createV2Gate } from "./herdr-floor.ts";
import { BYPASS_MODE, createLiveModes, MAX_PRESSES, MODE_CYCLE_KEY } from "./live-modes.ts";
import { requestEvents } from "./request-items.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";
import { createV2Routes, type EffectContext, type EffectOutcome, type EffectRegistry } from "./v2-routes.ts";

// The live switches (T08) against a fake Claude pane whose footer advances one mode per shift+tab.
// The screens are live captures (Claude Code 2.1.301), read through the real guarded sender and the
// real composer kit, so the footer reader and the cycle loop are tested together.

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const AUTO = fixture("claude--mode-auto.txt");
const SCREENS: Record<string, string> = {
  auto: AUTO,
  manual: fixture("claude--mode-manual.txt"),
  acceptEdits: fixture("claude--mode-accept-edits.txt"),
  plan: fixture("claude--mode-plan.txt"),
  bypassPermissions: AUTO.replace("auto mode on", "bypass permissions on"),
  // A footer that names no mode: unreadable.
  unknown: AUTO.replace("⏵⏵ auto mode on", "? for shortcuts"),
};
const PERMISSION = fixture("claude--permission-bash.txt");
// The prompt row in these captures: `❯`, a no-break space, then the box's text.
const PROMPT_ROW = /❯\u00a0[^\n]*/;

const T0 = 1_800_000_000_000;
const PANE = "w1:p-t1";
const cfg = { submitKeys: ["Enter"], readLines: 200, deviceAllowlist: [], notifyDelayMs: 0 } as unknown as Config;
const noSleep = async () => {};
const CLAUDE_CAPS = capabilitiesFor("claude");

/** A Claude pane: shift+tab moves along `cycle`; typed text lands in the box; Enter submits it. */
class FakeClaude {
  cycle = ["auto", "manual", "acceptEdits", "plan"];
  at = 0;
  draft = "";
  dialog = false;
  /** A dialog appears after this many presses. */
  dialogAfter = Infinity;
  keys: string[] = [];
  submitted: string[] = [];
  failKeys = false;
  get mode(): string {
    return this.cycle[this.at]!;
  }
  set mode(m: string) {
    this.at = this.cycle.indexOf(m);
  }
  screen(): string {
    if (this.dialog) return PERMISSION;
    return SCREENS[this.mode]!.replace(PROMPT_ROW, `❯\u00a0${this.draft}`);
  }
  readPane(paneId: string) {
    return Promise.resolve({ pane_id: paneId, text: this.screen(), truncated: false, revision: 0 });
  }
  sendPaneText(_paneId: string, text: string) {
    if (!this.dialog) this.draft += text;
    return Promise.resolve();
  }
  sendPaneKeys(_paneId: string, keys: string[]) {
    if (this.failKeys) return Promise.reject(new Error("herdr pane.send_keys: socket closed"));
    for (const k of keys) {
      this.keys.push(k);
      if (this.dialog) continue;
      if (k === MODE_CYCLE_KEY) {
        this.at = (this.at + 1) % this.cycle.length;
        if (this.keys.filter((x) => x === MODE_CYCLE_KEY).length >= this.dialogAfter) this.dialog = true;
      }
      if (k === "Enter" && this.draft) {
        this.submitted.push(this.draft);
        this.draft = "";
      }
      if (k === "Backspace") this.draft = [...this.draft].slice(0, -1).join("");
    }
    return Promise.resolve();
  }
  presses(): number {
    return this.keys.filter((k) => k === MODE_CYCLE_KEY).length;
  }
}

interface Rig {
  store: ThreadStore;
  pane: FakeClaude;
  events: ThreadEvent[];
  effects: EffectRegistry;
  view: AgentView;
  begun: string[];
  run(command: Record<string, unknown>): Promise<EffectOutcome>;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function rig(opts: { status?: ThreadStatus; caps?: ThreadCapabilities; permissionMode?: string; agent?: string } = {}): Rig {
  let n = 0;
  const store = openThreadStore(":memory:", { now: () => T0, newId: () => `id${++n}`, log: () => {} });
  store.append([
    createProject(),
    createThread(
      thread("t1", {
        paneId: PANE,
        terminalId: "term-t1",
        status: opts.status ?? "idle",
        capabilities: opts.caps ?? CLAUDE_CAPS,
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      }),
    ),
  ]);
  const pane = new FakeClaude();
  const view: AgentView = {
    paneId: PANE,
    terminalId: "term-t1",
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: opts.agent ?? "claude",
    status: "idle",
    cwd: "C:\\code\\demo",
    focused: false,
    kind: "agent",
  };
  const snap = (): EngineSnapshot => ({ agents: [view], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" });
  const herdr = pane as unknown as HerdrClient;
  const begun: string[] = [];
  const { effects } = createLiveModes({
    store,
    sender: createGuardedSender(herdr, cfg, { current: snap }, createPaneQueue(), noSleep),
    herdr,
    drainer: { beginSend: (id) => (begun.push(id), () => {}) },
    sleep: noSleep,
  });
  const events: ThreadEvent[] = [];
  const off = store.onCommitted((batch) => events.push(...batch));
  cleanups.push(() => {
    off();
    store.close();
  });
  let cmd = 0;
  return {
    store,
    pane,
    events,
    effects,
    view,
    begun,
    run(command) {
      const commandId = `c${++cmd}`;
      const full = { commandId, ...command } as unknown as Command;
      const ctx: EffectContext = { commandId, receipt: { type: full.type, result: { hash: "h" } } };
      return effects[full.type]!(full, ctx);
    },
  };
}

const setMode = (mode: string, extra: Record<string, unknown> = {}) => ({ type: "thread.permissionMode.set", threadId: "t1", mode, ...extra });
const setModel = (model: string) => ({ type: "thread.model.set", threadId: "t1", model });

function pendingRequest(): RuntimeRequest {
  return {
    id: "req1",
    threadId: "t1",
    kind: "permission",
    prompt: "Run ls?",
    options: [{ label: "Yes" }],
    status: "pending",
    bindingHash: "h",
    createdAt: T0,
    updatedAt: T0,
  } as RuntimeRequest;
}

// ── thread.permissionMode.set ────────────────────────────────────────────────────────────────────

describe("thread.permissionMode.set", () => {
  test("reaches the target in as many presses as the cycle needs", async () => {
    const r = rig();
    const out = await r.run(setMode("plan"));
    expect(out).toMatchObject({ ok: true });
    expect(r.pane.presses()).toBe(3); // auto → manual → acceptEdits → plan
    expect(r.pane.mode).toBe("plan");
    expect(r.store.getThread("t1")?.permissionMode).toBe("plan");
    expect(r.begun).toEqual(["t1"]);
  });

  test("wraps around the cycle", async () => {
    const r = rig();
    r.pane.mode = "plan";
    expect(await r.run(setMode("manual"))).toMatchObject({ ok: true });
    expect(r.pane.presses()).toBe(2); // plan → auto → manual
  });

  test("already there: succeeds and sends nothing", async () => {
    const r = rig({ permissionMode: "auto" });
    expect(await r.run(setMode("auto"))).toMatchObject({ ok: true });
    expect(r.pane.keys).toEqual([]);
    expect(r.events.filter((e) => e.type === "thread.updated")).toEqual([]);
  });

  test("already there but recorded differently: the read corrects the record", async () => {
    const r = rig({ permissionMode: "plan" });
    expect(await r.run(setMode("auto"))).toMatchObject({ ok: true });
    expect(r.pane.keys).toEqual([]);
    expect(r.store.getThread("t1")?.permissionMode).toBe("auto");
  });

  test("gives up after MAX_PRESSES when the target is not in the cycle, reporting what it shows", async () => {
    const r = rig();
    r.pane.cycle = ["auto", "manual", "acceptEdits"]; // no plan (e.g. not offered on this launch)
    const out = await r.run(setMode("plan"));
    expect(out).toMatchObject({ ok: false, status: 409, error: "mode-not-reached", afterWork: true });
    expect(r.pane.presses()).toBe(MAX_PRESSES);
    const shown = (out as { shown?: string }).shown;
    expect(shown).toBe(r.pane.mode);
    expect(r.store.getThread("t1")?.permissionMode).toBe(shown);
  });

  test("stops on an unrequested bypass and never presses past it", async () => {
    const r = rig();
    r.pane.cycle = ["auto", "manual", BYPASS_MODE, "acceptEdits", "plan"];
    const out = await r.run(setMode("plan"));
    expect(out).toMatchObject({ ok: false, error: "bypass-reached", shown: BYPASS_MODE, afterWork: true });
    expect(r.pane.presses()).toBe(2);
    expect(r.pane.mode).toBe(BYPASS_MODE);
  });

  test("starting in bypass, it presses nothing toward another mode", async () => {
    const r = rig();
    r.pane.cycle = [BYPASS_MODE, "auto"];
    const out = await r.run(setMode("auto"));
    expect(out).toMatchObject({ ok: false, error: "bypass-reached" });
    expect(r.pane.keys).toEqual([]);
  });

  test("bypass as the target needs confirmBypass", async () => {
    const r = rig();
    r.pane.cycle = ["auto", BYPASS_MODE];
    expect(await r.run(setMode(BYPASS_MODE))).toMatchObject({ ok: false, status: 400, error: "bypass-needs-confirm" });
    expect(r.pane.keys).toEqual([]);
    expect(await r.run(setMode(BYPASS_MODE, { confirmBypass: true }))).toMatchObject({ ok: true });
    expect(r.pane.mode).toBe(BYPASS_MODE);
  });

  test("unknown-mode when the footer names no mode: nothing sent", async () => {
    const r = rig();
    r.pane.cycle = ["unknown"];
    expect(await r.run(setMode("plan"))).toMatchObject({ ok: false, status: 409, error: "unknown-mode" });
    expect(r.pane.keys).toEqual([]);
    expect(r.events).toEqual([]);
  });

  test("no keys when the composer is not on screen", async () => {
    const r = rig();
    r.pane.dialog = true;
    expect(await r.run(setMode("plan"))).toMatchObject({ ok: false, error: "blocked" });
    expect(r.pane.keys).toEqual([]);
  });

  test("a dialog that comes up mid-cycle stops the loop before another key", async () => {
    const r = rig();
    r.pane.dialogAfter = 1;
    expect(await r.run(setMode("plan"))).toMatchObject({ ok: false, error: "blocked", afterWork: true });
    expect(r.pane.presses()).toBe(1);
  });

  test.each([["working"], ["starting"], ["failed"]] as const)("refuses a %s thread", async (status) => {
    const r = rig({ status });
    expect(await r.run(setMode("plan"))).toMatchObject({ ok: false, status: 409, error: "thread-busy" });
    expect(r.pane.keys).toEqual([]);
  });

  test("refuses a blocked thread and one with an open request", async () => {
    const blocked = rig({ status: "approval" });
    expect(await blocked.run(setMode("plan"))).toMatchObject({ ok: false, error: "needs-response" });
    const open = rig();
    open.store.append(requestEvents(pendingRequest()));
    expect(await open.run(setMode("plan"))).toMatchObject({ ok: false, error: "needs-response" });
    expect(open.pane.keys).toEqual([]);
  });

  test("refuses an unsupported harness and a mode it does not list", async () => {
    const r = rig({ caps: { ...NO_CAPABILITIES, canQueueDrain: true } });
    expect(await r.run(setMode("plan"))).toMatchObject({ ok: false, status: 409, code: "unsupported" });
    const claude = rig();
    expect(await claude.run(setMode("dontAsk"))).toMatchObject({ ok: false, status: 400, error: "invalid-mode" });
    expect(claude.pane.keys).toEqual([]);
  });

  test("refuses when the pane's harness has no footer reader, even if the flag says yes", async () => {
    const r = rig({ agent: "pi" });
    expect(await r.run(setMode("plan"))).toMatchObject({ ok: false, code: "unsupported" });
    expect(r.pane.keys).toEqual([]);
  });

  test("a key that fails is a 502, not recorded when no press went out", async () => {
    const r = rig();
    r.pane.failKeys = true;
    expect(await r.run(setMode("plan"))).toMatchObject({ ok: false, status: 502, afterWork: false });
  });
});

// ── thread.model.set ─────────────────────────────────────────────────────────────────────────────

// Claude's live switch is off (`/model` also rewrites the user's global default), so the mechanism is
// exercised with a harness that has it on.
const MODEL_CAPS = { ...CLAUDE_CAPS, canSwitchModel: true };
const modelRig = (o: Parameters<typeof rig>[0] = {}) => rig({ caps: MODEL_CAPS, ...o });

describe("thread.model.set", () => {
  test("is off for Claude: refused with nothing typed", async () => {
    const r = rig();
    expect(await r.run(setModel("sonnet"))).toMatchObject({ ok: false, code: "unsupported", error: "model-unsupported" });
    expect(r.pane.submitted).toEqual([]);
  });

  test("types `/model <id>` through the guarded send and submits it", async () => {
    const r = modelRig();
    expect(await r.run(setModel("sonnet"))).toMatchObject({ ok: true });
    expect(r.pane.submitted).toEqual(["/model sonnet"]);
    // Requested only: the model field waits for a later source.
    expect(r.store.getThread("t1")?.model).toBeUndefined();
    expect(r.begun).toEqual(["t1"]);
  });

  test("refuses a bad id", async () => {
    const r = modelRig();
    for (const bad of ["", "-rf", "a b", "x;y", "a".repeat(81), "/model"]) {
      expect(await r.run(setModel(bad))).toMatchObject({ ok: false, status: 400, error: "invalid-model" });
    }
    expect(r.pane.submitted).toEqual([]);
  });

  test("refuses an unsupported harness", async () => {
    const r = rig({ caps: capabilitiesFor("pi") });
    expect(await r.run(setModel("claude-sonnet-5-5"))).toMatchObject({ ok: false, code: "unsupported", error: "model-unsupported" });
  });

  test("refuses a busy thread", async () => {
    const r = modelRig({ status: "working" });
    expect(await r.run(setModel("sonnet"))).toMatchObject({ ok: false, error: "thread-busy" });
    expect(r.pane.submitted).toEqual([]);
  });

  test("the guard applies: no composer, nothing typed", async () => {
    const r = modelRig();
    r.pane.dialog = true;
    expect(await r.run(setModel("sonnet"))).toMatchObject({ ok: false, error: "blocked" });
    expect(r.pane.submitted).toEqual([]);
  });
});

// ── through the command route ────────────────────────────────────────────────────────────────────

describe("POST /api/v2/command", () => {
  test("a mode that is not reached is recorded: command.rejected with what the footer showed", async () => {
    const r = rig();
    r.pane.cycle = ["auto", "manual"];
    const gate = createV2Gate({ log: () => {} });
    await gate.check({ serverVersion: async () => "0.9.0" });
    const routes = createV2Routes({
      cfg: { allowAnyHost: true, allowedOrigins: [], publicHosts: [], tailscaleHosts: [], deviceAllowlist: [] } as unknown as Config,
      store: r.store,
      gate,
      engine: { current: () => ({ agents: [r.view], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }) },
      activity: { noteSeen: () => false, noteUnseen: () => false },
      queue: createPaneQueue(),
      effects: r.effects,
    });
    cleanups.push(() => routes.close());
    const post = () =>
      new Request("http://localhost/api/v2/command", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
        body: JSON.stringify({ commandId: "m-1", ...setMode("plan") }),
      });
    const first = await routes.handle(post(), new URL("http://localhost/api/v2/command"))!;
    expect(first.status).toBe(409);
    const body = await first.json();
    expect(body).toMatchObject({ ok: false, code: "conflict", error: "mode-not-reached" });
    expect(["auto", "manual"]).toContain(body.shown);
    const rejected = r.events.find((e) => e.type === "command.rejected");
    expect(rejected?.payload).toMatchObject({ reason: "mode-not-reached", shown: body.shown });
    // A retry of the same id gets the same answer and presses nothing more.
    const presses = r.pane.presses();
    const second = await routes.handle(post(), new URL("http://localhost/api/v2/command"))!;
    expect(second.status).toBe(409);
    expect(r.pane.presses()).toBe(presses);
  });
});
