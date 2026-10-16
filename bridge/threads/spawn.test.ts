import { afterEach, describe, expect, test } from "bun:test";

import { buildLaunchArgs, LAUNCHABLE_AGENT_IDS, launchFor, MODEL_PATTERN } from "../../shared/agents.ts";
import type { ThreadEvent } from "../../shared/v2/contracts.ts";
import type { Config } from "../config.ts";
import type { CreatedShell, PaneInfo, StartedAgent } from "../herdr-client.ts";
import type { JournalAdapter } from "../journal/types.ts";
import { createPaneQueue } from "../pane-queue.ts";
import type { AgentView, EngineSnapshot } from "../state-engine.ts";
import { createProject, createThread, project, thread } from "../test/thread-fixtures.ts";
import { createV2Gate } from "./herdr-floor.ts";
import { diffHerd, STARTING_GRACE_MS } from "./herd-ingest.ts";
import { capabilitiesFor } from "./capabilities.ts";
import {
  agentNameFrom,
  BUSY_RETRIES,
  createSpawner,
  lastLine,
  resolveLocalDir,
  startFailureText,
  suffixedName,
  type Spawner,
} from "./spawn.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";
import { createV2Routes, type EffectOutcome } from "./v2-routes.ts";

// ── buildLaunchArgs ──────────────────────────────────────────────────────────────────────────────

describe("buildLaunchArgs", () => {
  test("every launchable harness builds with no options", () => {
    expect(LAUNCHABLE_AGENT_IDS).toEqual(["claude", "pi", "grok", "agy", "cursor", "codex"]);
    for (const id of LAUNCHABLE_AGENT_IDS) expect(buildLaunchArgs(id)).toEqual({ ok: true, args: [], destructive: false });
  });

  test("claude: model, effort and permission mode, in table order", () => {
    expect(buildLaunchArgs("claude", { model: "haiku", effort: "high", permissionMode: "acceptEdits" })).toEqual({
      ok: true,
      args: ["--model", "haiku", "--effort", "high", "--permission-mode", "acceptEdits"],
      destructive: false,
    });
  });

  test("pi: --model and --thinking; no permission mode", () => {
    expect(buildLaunchArgs("pi", { model: "anthropic/claude-sonnet-5-5:high", effort: "off" })).toEqual({
      ok: true,
      args: ["--model", "anthropic/claude-sonnet-5-5:high", "--thinking", "off"],
      destructive: false,
    });
    expect(buildLaunchArgs("pi", { permissionMode: "plan" })).toEqual({ ok: false, reason: "bad-mode" });
  });

  test("grok: -m and --permission-mode; its effort levels are unchecked, so none is accepted", () => {
    expect(buildLaunchArgs("grok", { model: "grok-4.7", permissionMode: "plan" })).toEqual({
      ok: true,
      args: ["-m", "grok-4.7", "--permission-mode", "plan"],
      destructive: false,
    });
    expect(buildLaunchArgs("grok", { effort: "high" })).toEqual({ ok: false, reason: "bad-effort" });
  });

  test("agy: --model, --effort, --mode", () => {
    expect(buildLaunchArgs("agy", { model: "claude-sonnet-4-6", effort: "max", permissionMode: "accept-edits" })).toEqual({
      ok: true,
      args: ["--model", "claude-sonnet-4-6", "--effort", "max", "--mode", "accept-edits"],
      destructive: false,
    });
    // Claude's mode names are not agy's.
    expect(buildLaunchArgs("agy", { permissionMode: "acceptEdits" })).toEqual({ ok: false, reason: "bad-mode" });
  });

  test("cursor and codex take no flags until someone checks their CLIs", () => {
    for (const id of ["cursor", "codex"]) {
      expect(buildLaunchArgs(id, { model: "gpt-5" })).toEqual({ ok: false, reason: "model-unsupported" });
      expect(buildLaunchArgs(id, { effort: "high" })).toEqual({ ok: false, reason: "bad-effort" });
      expect(buildLaunchArgs(id, { permissionMode: "auto" })).toEqual({ ok: false, reason: "bad-mode" });
    }
  });

  test("an unknown mode or effort is rejected, not passed through", () => {
    expect(buildLaunchArgs("claude", { permissionMode: "yolo" })).toEqual({ ok: false, reason: "bad-mode" });
    expect(buildLaunchArgs("claude", { permissionMode: "bypassPermissions --x" })).toEqual({ ok: false, reason: "bad-mode" });
    expect(buildLaunchArgs("claude", { effort: "ultra" })).toEqual({ ok: false, reason: "bad-effort" });
  });

  test("a free-text model must match the pattern and can never read as a flag", () => {
    expect(buildLaunchArgs("claude", { model: "claude-opus-5-5" })).toMatchObject({ ok: true });
    for (const bad of ["--dangerously-skip-permissions", "-m", "a b", "x;rm -rf", "a".repeat(81), "$(id)", "opus\n"]) {
      expect(MODEL_PATTERN.test(bad)).toBe(false);
      expect(buildLaunchArgs("claude", { model: bad })).toEqual({ ok: false, reason: "bad-model" });
    }
  });

  test("bypassPermissions is flagged destructive", () => {
    expect(buildLaunchArgs("claude", { permissionMode: "bypassPermissions" })).toEqual({
      ok: true,
      args: ["--permission-mode", "bypassPermissions"],
      destructive: true,
    });
    expect(buildLaunchArgs("grok", { permissionMode: "bypassPermissions" })).toMatchObject({ destructive: true });
    for (const id of LAUNCHABLE_AGENT_IDS) {
      for (const mode of launchFor(id)?.modes ?? []) {
        expect(mode.destructive === true).toBe(mode.id === "bypassPermissions");
      }
    }
  });

  test("an unknown harness has no launch", () => {
    expect(buildLaunchArgs("shell")).toEqual({ ok: false, reason: "no-launch" });
    expect(buildLaunchArgs("gemini")).toEqual({ ok: false, reason: "no-launch" });
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────

describe("names and prompts", () => {
  test("agent names follow herdr's rule", () => {
    expect(agentNameFrom("Fix login bug", "claude")).toBe("fix-login-bug");
    expect(agentNameFrom("42 things", "pi")).toBe("pi-42-things");
    expect(agentNameFrom("Ünïcode Ñame", "claude")).toBe("unicode-name");
    expect(agentNameFrom("!!!", "claude")).toBe("");
    expect(agentNameFrom("x".repeat(60), "claude")).toHaveLength(32);
    expect(suffixedName("claude-1", 2)).toBe("claude-1-2");
    expect(suffixedName("a".repeat(32), 12)).toBe(`${"a".repeat(29)}-12`);
  });

  test("lastLine skips blank rows", () => {
    expect(lastLine("PS C:\\x>\n\n   \n")).toBe("PS C:\\x>");
    expect(lastLine("\n\n")).toBe("");
  });

  test("startFailureText maps known codes and keeps herdr's words for the rest", () => {
    expect(startFailureText(new Error("herdr agent.start: agent_start_failed: agent process exited"))).toBe(
      "The agent exited before it was ready",
    );
    expect(startFailureText(new Error("herdr agent.start: weird_code: something odd"))).toBe("spawn-failed: something odd");
  });

  test("resolveLocalDir takes an existing absolute directory only", async () => {
    expect(await resolveLocalDir(import.meta.dir)).not.toBeNull();
    expect(await resolveLocalDir("relative\\dir")).toBeNull();
    expect(await resolveLocalDir(`${import.meta.dir}\\nope-not-here`)).toBeNull();
    expect(await resolveLocalDir(import.meta.path)).toBeNull();
    expect(await resolveLocalDir("\\\\server\\share")).toBeNull();
  });
});

// ── The handler, with a fake herdr ───────────────────────────────────────────────────────────────

const T0 = 1_800_000_000_000;
const journals = { claude: {} as JournalAdapter, pi: {} as JournalAdapter };
const PROMPT = "PS C:\\code\\demo>";

function view(paneId: string, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId,
    terminalId: `term-${paneId}`,
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "C:\\code\\demo",
    focused: false,
    kind: "agent",
    ...over,
  };
}

/** A herdr that makes panes, draws a prompt, and starts (or fails to start) agents. */
class FakeHerdr {
  calls: { method: string; params: unknown }[] = [];
  panes = new Map<string, { terminalId: string; agent: string | null; workspaceId: string }>();
  workspaces = new Map<string, { panes: number; tabs: number }>([["w1", { panes: 1, tabs: 1 }]]);
  next = 1;
  /** The screen each read returns, per pane (default: a stable prompt). */
  screen: (paneId: string, n: number) => string = () => PROMPT;
  reads = new Map<string, number>();
  /** What startAgent does; default: ready. */
  start: (opts: { paneId: string; name: string }) => Promise<StartedAgent> = async (opts) => {
    const pane = this.panes.get(opts.paneId)!;
    pane.agent = "claude";
    return { name: opts.name, paneId: opts.paneId, terminalId: pane.terminalId, agent: "claude", status: "idle" };
  };
  failCreate: Error | null = null;

  private make(workspaceId: string): CreatedShell {
    const n = this.next++;
    const paneId = `${workspaceId}:p${n}`;
    const terminalId = `term-${paneId}`;
    this.panes.set(paneId, { terminalId, agent: null, workspaceId });
    return { paneId, workspaceId, tabId: `${workspaceId}:t${n}`, cwd: "C:\\code\\demo", terminalId };
  }

  createTab = async (workspaceId: string, opts: { label?: string; cwd?: string } = {}) => {
    this.calls.push({ method: "tab.create", params: { workspaceId, ...opts } });
    if (this.failCreate) throw this.failCreate;
    const ws = this.workspaces.get(workspaceId)!;
    ws.panes++;
    ws.tabs++;
    return this.make(workspaceId);
  };
  createWorkspace = async (opts: { cwd: string; label?: string }) => {
    this.calls.push({ method: "workspace.create", params: opts });
    if (this.failCreate) throw this.failCreate;
    const id = `w${10 + this.workspaces.size}`;
    this.workspaces.set(id, { panes: 1, tabs: 1 });
    return { ...this.make(id), workspaceLabel: opts.label ?? "new", workspaceNumber: 7 };
  };
  splitPane = async (opts: { targetPaneId?: string; direction: "right" | "down" }) => {
    this.calls.push({ method: "pane.split", params: { ...opts, focus: false } });
    const target = this.panes.get(opts.targetPaneId!) ?? { workspaceId: "w1" };
    const ws = this.workspaces.get(target.workspaceId)!;
    ws.panes++;
    return this.make(target.workspaceId);
  };
  startAgent = async (opts: { paneId: string; name: string; kind: string; args: readonly string[]; timeoutMs?: number }) => {
    this.calls.push({ method: "agent.start", params: opts });
    return this.start(opts);
  };
  readPane = async (paneId: string) => {
    const n = (this.reads.get(paneId) ?? 0) + 1;
    this.reads.set(paneId, n);
    return { pane_id: paneId, text: this.screen(paneId, n), truncated: false, revision: n };
  };
  getPane = async (paneId: string): Promise<PaneInfo | null> => {
    const p = this.panes.get(paneId);
    return p ? { paneId, terminalId: p.terminalId, workspaceId: p.workspaceId, tabId: "t", agent: p.agent } : null;
  };
  closePane = async (paneId: string) => {
    this.calls.push({ method: "pane.close", params: { paneId } });
    this.panes.delete(paneId);
  };
  closeWorkspace = async (workspaceId: string) => {
    this.calls.push({ method: "workspace.close", params: { workspaceId } });
    this.workspaces.delete(workspaceId);
  };
  listWorkspaces = async () =>
    [...this.workspaces.entries()].map(([id, w]) => ({ workspace_id: id, pane_count: w.panes, tab_count: w.tabs })) as never;

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

interface Rig {
  store: ThreadStore;
  herdr: FakeHerdr;
  spawner: Spawner;
  events: ThreadEvent[];
  snap: EngineSnapshot;
  run(command: Record<string, unknown>, commandId?: string): Promise<EffectOutcome>;
  types(): string[];
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

let seq = 0;

function rig(opts: { clockStep?: number } = {}): Rig {
  let n = 0;
  const clock = { now: T0 };
  const store = openThreadStore(":memory:", { now: () => clock.now, newId: () => `id${++n}`, log: () => {} });
  store.append([createProject(project("w1", { label: "demo" })), createThread(thread("t1", { paneId: "w1:p0", terminalId: "term-w1:p0" }))]);
  const herdr = new FakeHerdr();
  herdr.panes.set("w1:p0", { terminalId: "term-w1:p0", agent: "claude", workspaceId: "w1" });
  const events: ThreadEvent[] = [];
  cleanups.push(store.onCommitted((e) => events.push(...e)));
  const snap: EngineSnapshot = { agents: [view("w1:p0")], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" };
  const spawner = createSpawner({
    store,
    herdr,
    engine: { current: () => snap, pokeNow: () => {}, onUpdate: () => () => {} },
    queue: createPaneQueue(),
    journals,
    // Each sleep moves the clock, so the prompt wait and the busy retries run out in fake time.
    sleep: async (ms) => {
      clock.now += opts.clockStep ?? ms;
    },
    log: () => {},
    resolveDir: async (cwd) => (cwd.startsWith("C:\\") ? cwd : null),
  });
  return {
    store,
    herdr,
    spawner,
    events,
    snap,
    run: (command, commandId = `c${++seq}`) => {
      const type = command.type as "thread.create";
      return spawner.effects[type]!({ commandId, ...command } as never, {
        commandId,
        receipt: { type, result: { hash: "h" } },
      });
    },
    types: () => events.map((e) => e.type),
  };
}

const created = (r: Rig) => r.events.find((e) => e.type === "thread.created") as Extract<ThreadEvent, { type: "thread.created" }>;

describe("thread.create", () => {
  test("tab path: createTab, prompt poll, startAgent with kind and args, then idle", async () => {
    const r = rig();
    const out = await r.run({ type: "thread.create", projectId: "w1", harness: "claude", model: "haiku", permissionMode: "plan", placement: "tab" });
    expect(out).toMatchObject({ ok: true });
    await r.spawner.settled();
    expect(r.herdr.methods()).toEqual(["tab.create", "agent.start"]);
    expect(r.herdr.calls[0]!.params).toEqual({ workspaceId: "w1", label: "claude-2" });
    expect(r.herdr.calls[1]!.params).toMatchObject({
      paneId: "w1:p1",
      name: "claude-2",
      kind: "claude",
      args: ["--model", "haiku", "--permission-mode", "plan"],
      timeoutMs: 45_000,
    });
    // Two equal reads of the prompt before the start.
    expect(r.herdr.reads.get("w1:p1")).toBe(2);
    const t = created(r).payload.thread;
    expect(t).toMatchObject({
      paneId: "w1:p1",
      terminalId: "term-w1:p1",
      projectId: "w1",
      harness: "claude",
      status: "starting",
      title: "claude-2",
      titleSource: "herd",
      model: "haiku",
      permissionMode: "plan",
      capabilities: capabilitiesFor("claude", journals),
    });
    expect(r.store.getThread(t.id)?.status).toBe("idle");
    expect(r.types()).toEqual(["thread.created", "thread.updated"]);
    expect(r.events.every((e) => e.commandId === r.events[0]!.commandId)).toBe(true);
  });

  test("a given name titles the thread (user) and is slugged for herdr", async () => {
    const r = rig();
    await r.run({ type: "thread.create", projectId: "w1", harness: "pi", placement: "tab", name: "Fix Login" });
    await r.spawner.settled();
    expect(created(r).payload.thread).toMatchObject({ title: "Fix Login", titleSource: "user", harness: "pi" });
    expect(r.herdr.calls.find((c) => c.method === "agent.start")!.params).toMatchObject({ name: "fix-login", kind: "pi", args: [] });
  });

  test("split path calls pane.split with focus:false next to the thread's pane", async () => {
    const r = rig();
    const out = await r.run({ type: "thread.create", harness: "pi", placement: "split", splitFrom: "t1", direction: "down" });
    expect(out).toMatchObject({ ok: true });
    await r.spawner.settled();
    expect(r.herdr.calls[0]).toEqual({ method: "pane.split", params: { targetPaneId: "w1:p0", direction: "down", focus: false } });
    expect(created(r).payload.thread).toMatchObject({ projectId: "w1", harness: "pi" });
  });

  test("thread.created is committed before startAgent resolves", async () => {
    const r = rig();
    let release!: () => void;
    r.herdr.start = (opts) =>
      new Promise((resolve) => {
        release = () => resolve({ name: opts.name, paneId: opts.paneId, terminalId: `term-${opts.paneId}`, status: "idle" });
      });
    await r.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" });
    for (let i = 0; i < 20 && !r.herdr.methods().includes("agent.start"); i++) await Promise.resolve();
    await Bun.sleep(0);
    expect(r.herdr.methods()).toContain("agent.start");
    expect(r.types()).toEqual(["thread.created"]);
    expect(r.store.getThread(created(r).payload.thread.id)?.status).toBe("starting");
    release();
    await r.spawner.settled();
    expect(r.store.getThread(created(r).payload.thread.id)?.status).toBe("idle");
  });

  test("prompt never appears: thread.create.failed stage prompt, the pane is closed, the thread archived", async () => {
    const r = rig();
    r.herdr.screen = (_p, n) => `loading ${n}`;
    await r.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" });
    await r.spawner.settled();
    expect(r.herdr.methods()).toEqual(["tab.create", "pane.close"]);
    const failed = r.events.find((e) => e.type === "thread.create.failed")!;
    expect(failed.payload).toMatchObject({ stage: "prompt" });
    const id = created(r).payload.thread.id;
    expect(r.store.getThread(id)).toMatchObject({ shelf: "archived", archiveReason: "spawn-failed" });
    expect(r.store.getTurnItem(`spawn:${id}`)).toMatchObject({ type: "system_notice", message: expect.stringContaining("prompt") });
  });

  test("startAgent hard error: the pane is closed when it has no agent and the same terminal", async () => {
    const r = rig();
    r.herdr.start = async () => {
      throw new Error("herdr agent.start: agent_start_failed: agent process exited before becoming interactive");
    };
    await r.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" });
    await r.spawner.settled();
    expect(r.herdr.methods()).toEqual(["tab.create", "agent.start", "pane.close"]);
    expect(r.events.find((e) => e.type === "thread.create.failed")!.payload).toMatchObject({
      stage: "agent",
      message: "The agent exited before it was ready",
    });
    expect(r.store.getThread(created(r).payload.thread.id)?.shelf).toBe("archived");
  });

  test("startAgent hard error: the pane is left when an agent is there or the terminal changed", async () => {
    for (const change of ["agent", "terminal"] as const) {
      const r = rig();
      r.herdr.start = async (opts) => {
        const pane = r.herdr.panes.get(opts.paneId)!;
        if (change === "agent") pane.agent = "claude";
        else pane.terminalId = "term-other";
        throw new Error("herdr agent.start: agent_kind_mismatch: expected claude, detected pi");
      };
      await r.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" });
      await r.spawner.settled();
      expect(r.herdr.methods()).toEqual(["tab.create", "agent.start"]);
      const t = r.store.getThread(created(r).payload.thread.id)!;
      expect(t.shelf).toBe("active");
      expect(t.status).toBe("idle");
      expect(r.types()).toContain("thread.create.failed");
    }
  });

  test("startAgent timeout leaves the pane and the thread starting", async () => {
    const r = rig();
    r.herdr.start = async () => {
      throw new Error("herdr agent.start: timeout: timed out waiting for agent startup");
    };
    await r.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" });
    await r.spawner.settled();
    expect(r.herdr.methods()).toEqual(["tab.create", "agent.start"]);
    const t = r.store.getThread(created(r).payload.thread.id)!;
    expect(t).toMatchObject({ shelf: "active", status: "starting" });
    expect(r.events.find((e) => e.type === "thread.create.failed")!.payload).toMatchObject({
      stage: "agent",
      message: "The agent did not start in 45 s",
    });
  });

  test("a pane not at its prompt yet is retried, then gives up", async () => {
    const r = rig();
    let tries = 0;
    r.herdr.start = async (opts) => {
      if (++tries < 3) throw new Error(`herdr agent.start: agent_pane_busy: agent target pane ${opts.paneId} is not an available shell`);
      return { name: opts.name, paneId: opts.paneId, terminalId: `term-${opts.paneId}`, status: "idle" };
    };
    await r.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" });
    await r.spawner.settled();
    expect(tries).toBe(3);
    expect(r.store.getThread(created(r).payload.thread.id)?.status).toBe("idle");

    const r2 = rig();
    r2.herdr.start = async () => {
      throw new Error("herdr agent.start: agent_pane_busy: not an available shell");
    };
    await r2.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" });
    await r2.spawner.settled();
    expect(r2.herdr.methods().filter((m) => m === "agent.start")).toHaveLength(BUSY_RETRIES + 1);
    expect(r2.events.find((e) => e.type === "thread.create.failed")!.payload).toMatchObject({ stage: "agent" });
  });

  test("a taken agent name gets a suffix", async () => {
    const r = rig();
    const names: string[] = [];
    r.herdr.start = async (opts) => {
      names.push(opts.name);
      if (names.length === 1) throw new Error("herdr agent.start: agent_name_taken: agent name claude-2 is already used");
      return { name: opts.name, paneId: opts.paneId, terminalId: `term-${opts.paneId}`, status: "idle" };
    };
    await r.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" });
    await r.spawner.settled();
    expect(names).toEqual(["claude-2", "claude-2-2"]);
  });

  test("the default name skips names the herd already uses", async () => {
    const r = rig();
    r.snap.agents.push(view("w9:p1", { agentName: "claude-2" }));
    await r.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" });
    expect(created(r).payload.thread.title).toBe("claude-3");
  });

  test("newProject creates the workspace and uses its root pane", async () => {
    const r = rig();
    const out = await r.run({ type: "thread.create", newProject: { cwd: "C:\\code\\fresh", label: "fresh" }, harness: "claude", placement: "tab" });
    expect(out).toMatchObject({ ok: true });
    await r.spawner.settled();
    expect(r.herdr.methods()).toEqual(["workspace.create", "agent.start"]);
    expect(r.types().slice(0, 2)).toEqual(["project.upserted", "thread.created"]);
    const projectId = created(r).payload.thread.projectId;
    expect(r.store.getProject(projectId)).toMatchObject({ label: "fresh", number: 7 });
  });

  test("newProject: a failed start closes the workspace only while it is empty", async () => {
    const r = rig();
    r.herdr.start = async () => {
      throw new Error("herdr agent.start: agent_start_failed: exited");
    };
    await r.run({ type: "thread.create", newProject: { cwd: "C:\\code\\fresh" }, harness: "claude", placement: "tab" });
    await r.spawner.settled();
    expect(r.herdr.methods()).toEqual(["workspace.create", "agent.start", "workspace.close"]);

    const r2 = rig();
    r2.herdr.start = async (opts) => {
      // Someone opened a second tab in the new workspace meanwhile.
      r2.herdr.workspaces.get(r2.herdr.panes.get(opts.paneId)!.workspaceId)!.tabs++;
      throw new Error("herdr agent.start: agent_start_failed: exited");
    };
    await r2.run({ type: "thread.create", newProject: { cwd: "C:\\code\\fresh" }, harness: "claude", placement: "tab" });
    await r2.spawner.settled();
    expect(r2.herdr.methods()).toEqual(["workspace.create", "agent.start", "pane.close"]);
  });

  test("bypass without confirmBypass is refused with no pane created", async () => {
    const r = rig();
    const out = await r.run({ type: "thread.create", projectId: "w1", harness: "claude", permissionMode: "bypassPermissions", placement: "tab" });
    expect(out).toEqual({ ok: false, status: 400, code: "invalid", error: "bypass-needs-confirm" });
    expect(r.herdr.calls).toEqual([]);
    const ok = await r.run({
      type: "thread.create",
      projectId: "w1",
      harness: "claude",
      permissionMode: "bypassPermissions",
      confirmBypass: true,
      placement: "tab",
    });
    expect(ok).toMatchObject({ ok: true });
    await r.spawner.settled();
    expect(r.herdr.calls.find((c) => c.method === "agent.start")!.params).toMatchObject({ args: ["--permission-mode", "bypassPermissions"] });
  });

  test("bad launch values are refused before any pane exists", async () => {
    const r = rig();
    for (const bad of [
      { harness: "shell" },
      { harness: "claude", model: "--evil" },
      { harness: "claude", effort: "ultra" },
      { harness: "pi", permissionMode: "plan" },
      { harness: "claude", model: 7 },
    ]) {
      const out = await r.run({ type: "thread.create", projectId: "w1", placement: "tab", ...bad });
      expect(out).toMatchObject({ ok: false, status: 400, code: "invalid", error: expect.stringMatching(/^invalid-launch/) });
    }
    expect(await r.run({ type: "thread.create", projectId: "nope", harness: "claude", placement: "tab" })).toMatchObject({
      ok: false,
      status: 404,
      error: "no-such-project",
    });
    expect(await r.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "float" })).toMatchObject({ error: "bad-placement" });
    expect(await r.run({ type: "thread.create", harness: "claude", placement: "split", splitFrom: "zz" })).toMatchObject({ status: 404 });
    expect(await r.run({ type: "thread.create", newProject: { cwd: "relative" }, harness: "claude", placement: "tab" })).toMatchObject({ error: "bad-cwd" });
    expect(await r.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "tab", name: "a\u0007b" })).toMatchObject({ error: "bad-name" });
    expect(r.herdr.calls).toEqual([]);
    expect(r.types()).toEqual([]);
  });

  test("a failed pane create fails the command with no thread and no receipt", async () => {
    const r = rig();
    r.herdr.failCreate = new Error("herdr tab.create: workspace_not_found: gone");
    const out = await r.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" });
    expect(out).toMatchObject({ ok: false, status: 502, code: "failed" });
    expect(r.types()).toEqual([]);
  });

  test("never closes a pane it did not create: the splitFrom pane stays on a failure", async () => {
    const r = rig();
    r.herdr.start = async () => {
      throw new Error("herdr agent.start: agent_start_failed: exited");
    };
    await r.run({ type: "thread.create", harness: "claude", placement: "split", splitFrom: "t1" });
    await r.spawner.settled();
    const closed = r.herdr.calls.filter((c) => c.method === "pane.close").map((c) => (c.params as { paneId: string }).paneId);
    expect(closed).toEqual(["w1:p1"]);
    expect(r.herdr.panes.has("w1:p0")).toBe(true);
    expect(r.store.getThread("t1")?.shelf).toBe("active");
  });

  test("a thread the herd ingest made for the new pane first is taken over, not duplicated", async () => {
    const r = rig();
    // The ingest saw pane w1:p1 (the next pane the fake makes) as a shell before the reply arrived.
    r.store.append([createThread(thread("herd1", { paneId: "w1:p1", terminalId: "term-w1:p1", harness: "shell", status: "idle" }))]);
    r.events.length = 0;
    await r.run({ type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" });
    expect(r.types()).toEqual(["thread.updated"]);
    expect(r.store.getThread("herd1")).toMatchObject({ harness: "claude", status: "starting" });
    await r.spawner.settled();
    expect(r.store.listThreads().filter((t) => t.paneId === "w1:p1")).toHaveLength(1);
  });
});

describe("project.create", () => {
  test("creates a workspace and upserts the project with the command id", async () => {
    const r = rig();
    const out = await r.run({ type: "project.create", cwd: "C:\\code\\fresh", label: "fresh" }, "p-1");
    expect(out).toMatchObject({ ok: true });
    expect(r.herdr.calls).toEqual([{ method: "workspace.create", params: { cwd: "C:\\code\\fresh", label: "fresh" } }]);
    expect(r.events).toEqual([expect.objectContaining({ type: "project.upserted", commandId: "p-1" })]);
    // Its root pane is a shell, not a thread (the herd ingest makes that one).
    expect(r.types()).not.toContain("thread.created");
  });

  test("refuses a missing or relative cwd", async () => {
    const r = rig();
    expect(await r.run({ type: "project.create", cwd: "" })).toMatchObject({ error: "bad-cwd" });
    expect(await r.run({ type: "project.create", cwd: "code\\x" })).toMatchObject({ error: "bad-cwd" });
    expect(r.herdr.calls).toEqual([]);
  });
});

// ── Through the command route ────────────────────────────────────────────────────────────────────

describe("POST /api/v2/command thread.create", () => {
  test("a replay of the same commandId makes one pane and returns the same reply", async () => {
    const r = rig();
    const gate = createV2Gate({ log: () => {} });
    await gate.check({ serverVersion: async () => "0.9.0" });
    const routes = createV2Routes({
      cfg: { allowAnyHost: true, allowedOrigins: [], publicHosts: [], tailscaleHosts: [], deviceAllowlist: [] } as unknown as Config,
      store: r.store,
      gate,
      engine: { current: () => r.snap },
      activity: { noteSeen: () => false, noteUnseen: () => false },
      queue: createPaneQueue(),
      effects: r.spawner.effects,
    });
    cleanups.push(() => routes.close());
    const post = () =>
      new Request("http://localhost/api/v2/command", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
        body: JSON.stringify({ commandId: "spawn-1", type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" }),
      });
    const url = new URL("http://localhost/api/v2/command");
    const [a, b] = await Promise.all([routes.handle(post(), url)!, routes.handle(post(), url)!]);
    const c = await routes.handle(post(), url)!;
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    const first = await a.json();
    expect(await b.json()).toEqual(first);
    expect(await c.json()).toEqual(first);
    await r.spawner.settled();
    expect(r.herdr.methods().filter((m) => m === "tab.create")).toHaveLength(1);
    expect(r.types().filter((t) => t === "thread.created")).toHaveLength(1);
  });
});

// ── T02 interplay ────────────────────────────────────────────────────────────────────────────────

describe("herd ingest and a starting thread", () => {
  const ctx = (now: number) => ({
    now,
    newId: () => "x",
    first: false,
    missingThreads: new Set<string>(),
    missingProjects: new Set<string>(),
    activity: () => undefined,
    touchedAt: () => undefined,
    capabilities: (h: string) => capabilitiesFor(h, journals),
  });
  const starting = thread("s1", {
    paneId: "w1:p1",
    terminalId: "term-w1:p1",
    harness: "claude",
    status: "starting",
    title: "claude-2",
    capabilities: capabilitiesFor("claude", journals),
    updatedAt: T0,
  });
  const projection = { projects: [project("w1", { label: "demo", order: 1, number: 1 })], threads: [starting], openRuns: [], pendingRequests: [] };
  const workspaces = [{ workspaceId: "w1", number: 1, label: "demo", focused: false, activeTabId: "w1:t1", tabCount: 1, paneCount: 1 }];

  test("while herdr still sees a shell, the thread keeps starting, its harness and title: no duplicate row", () => {
    const shell = view("w1:p1", { agent: "shell", kind: "shell", status: "unknown", terminalTitle: "pwsh" });
    const { events } = diffHerd({ agents: [], shellPanes: [shell], workspaces, tabs: [], bridge: "connected" }, projection, ctx(T0 + 1_000));
    expect(events.filter((e) => e.type === "thread.created" || e.type === "thread.archived")).toEqual([]);
    expect(events.filter((e) => e.type === "thread.updated")).toEqual([]);
  });

  test("once the agent shows up, the herd ingest owns the status", () => {
    const { events } = diffHerd(
      { agents: [view("w1:p1", { agentName: "claude-2", status: "blocked" })], shellPanes: [], workspaces, tabs: [], bridge: "connected" },
      projection,
      ctx(T0 + 1_000),
    );
    expect(events.filter((e) => e.type === "thread.created")).toEqual([]);
    expect(events.find((e) => e.type === "thread.updated")!.payload).toMatchObject({ patch: { status: "input" } });
  });

  test("a starting thread with its terminal already known is not archived inside the grace", () => {
    const missing = { ...ctx(T0 + 1_000), missingThreads: new Set(["s1"]) };
    const empty = { agents: [], shellPanes: [], workspaces, tabs: [], bridge: "connected" as const };
    expect(diffHerd(empty, projection, missing).events.filter((e) => e.type === "thread.archived")).toEqual([]);
    const late = { ...missing, now: T0 + STARTING_GRACE_MS };
    expect(diffHerd(empty, projection, late).events.filter((e) => e.type === "thread.archived")).toHaveLength(1);
  });
});
