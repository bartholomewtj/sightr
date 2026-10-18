import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { capabilitiesFor } from "../../shared/agents.ts";
import type { ThreadStatus } from "../../shared/v2/contracts.ts";
import type { HerdrClient, PaneRead } from "../herdr-client.ts";
import { createPaneQueue } from "../pane-queue.ts";
import type { AgentView, EngineSnapshot } from "../state-engine.ts";
import { createProject, createThread, project, thread } from "../test/thread-fixtures.ts";
import { createModeWatcher, MODE_READ_EVERY_MS, MODE_READ_LINES } from "./mode-watch.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";

// Thread.permissionMode from a resting pane's footer (live captures, Claude Code 2.1.301; live check
// 18 Oct 2026 on 2.1.302: a thread started with no --permission-mode, under settings `defaultMode: auto`,
// paints "⏵⏵ auto mode on").

const PANES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const screen = (name: string) => readFileSync(join(PANES, `claude--${name}.txt`), "utf8");
const AUTO = screen("mode-auto");
const PLAN = screen("mode-plan");
const PERMISSION = screen("permission-bash");
const T0 = 1_800_000_000_000;

const stores: ThreadStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function rig(opts: { harness?: string; status?: ThreadStatus; permissionMode?: string } = {}) {
  const clock = { now: T0 };
  const store = openThreadStore(":memory:", { now: () => clock.now });
  stores.push(store);
  const harness = opts.harness ?? "claude";
  store.append([
    createProject(project()),
    createThread(
      thread("t1", {
        paneId: "w1:p1",
        terminalId: "term-1",
        harness,
        status: opts.status ?? "idle",
        capabilities: capabilitiesFor(harness),
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      }),
    ),
  ]);
  const view: AgentView = {
    paneId: "w1:p1",
    terminalId: "term-1",
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: harness,
    status: "idle",
    cwd: "C:\\code\\demo",
    focused: false,
    kind: "agent",
  };
  const pane = {
    screen: AUTO,
    reads: [] as { source: string; lines: number; format?: string }[],
    fail: false,
    async readPane(paneId: string, source: string, lines: number, format?: string): Promise<PaneRead> {
      this.reads.push({ source, lines, format });
      if (this.fail) throw new Error("herdr down");
      return { pane_id: paneId, text: this.screen, truncated: false, revision: 0 };
    },
  };
  const snap = (): EngineSnapshot => ({ agents: [view], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" });
  const watcher = createModeWatcher({
    store,
    engine: { current: snap, onUpdate: () => () => {} },
    herdr: pane as unknown as HerdrClient,
    queue: createPaneQueue(),
    now: () => clock.now,
    log: () => {},
  });
  const tick = async (ms = MODE_READ_EVERY_MS) => {
    clock.now += ms;
    await watcher.poll();
  };
  const setStatus = (status: ThreadStatus) =>
    store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { status }, at: clock.now } }]);
  return { store, pane, tick, setStatus, mode: () => store.getThread("t1")?.permissionMode };
}

describe("mode watch", () => {
  test("a resting Claude thread with no mode on record takes the footer's mode, then follows it", async () => {
    const r = rig();
    expect(r.mode()).toBeUndefined();
    await r.tick();
    expect(r.mode()).toBe("auto");
    expect(r.pane.reads).toEqual([{ source: "visible", lines: MODE_READ_LINES, format: "ansi" }]);
    // On the wire: the shell snapshot carries it.
    expect(r.store.snapshotShell().threads[0]?.permissionMode).toBe("auto");

    // Switched in the terminal (shift+tab): the next read follows.
    r.pane.screen = PLAN;
    await r.tick();
    expect(r.mode()).toBe("plan");
  });

  test("one event per change, and reads are throttled per thread", async () => {
    const r = rig();
    const before = r.store.lastSequence();
    await r.tick();
    await r.tick(10);
    await r.tick();
    expect(r.store.lastSequence()).toBe(before + 1);
    expect(r.pane.reads).toHaveLength(2);
  });

  test("a working thread is not read; it is read again as soon as it rests", async () => {
    const r = rig({ status: "working" });
    await r.tick();
    expect(r.pane.reads).toHaveLength(0);
    r.setStatus("done");
    await r.tick(1);
    expect(r.mode()).toBe("auto");
  });

  test("a dialog on screen, or a failed read, keeps the recorded mode", async () => {
    const r = rig({ permissionMode: "plan" });
    r.pane.screen = PERMISSION;
    await r.tick();
    expect(r.mode()).toBe("plan");
    r.pane.fail = true;
    await r.tick();
    expect(r.mode()).toBe("plan");
  });

  test("a harness whose capabilities cannot switch mode is never read", async () => {
    const r = rig({ harness: "pi" });
    await r.tick();
    expect(r.pane.reads).toEqual([]);
    const g = rig({ harness: "grok" });
    await g.tick();
    expect(g.pane.reads).toEqual([]);
  });
});
