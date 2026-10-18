import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ThreadStatus } from "../../shared/v2/contracts.ts";
import type { HerdrClient, PaneRead } from "../herdr-client.ts";
import type { AgentView, EngineSnapshot } from "../state-engine.ts";
import { createProject, createThread, project, thread } from "../test/thread-fixtures.ts";
import { COMPACTION_READ_LINES, createCompactionWatcher, READ_EVERY_MS } from "./compaction-watch.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";

// Thread.compacting from the screen (live capture of Claude's `/compact`, 2026-10-18; Claude's
// auto-compact paints the same row).

const WEB = join(import.meta.dir, "..", "..", "web", "src", "fixtures");
const COMPACTING = readFileSync(join(WEB, "live-free-text", "claude--compacting.txt"), "utf8");
const WORKING = readFileSync(join(WEB, "panes", "claude--working.txt"), "utf8");
const T0 = 1_800_000_000_000;

const stores: ThreadStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function rig(opts: { harness?: string; status?: ThreadStatus } = {}) {
  const clock = { now: T0 };
  const store = openThreadStore(":memory:", { now: () => clock.now });
  stores.push(store);
  const harness = opts.harness ?? "claude";
  store.append([
    createProject(project()),
    createThread(thread("t1", { paneId: "w1:p1", terminalId: "term-1", harness, status: opts.status ?? "working" })),
  ]);
  const view: AgentView = {
    paneId: "w1:p1",
    terminalId: "term-1",
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: harness,
    status: "working",
    cwd: "C:\\code\\demo",
    focused: false,
    kind: "agent",
  };
  const pane = {
    screen: WORKING,
    reads: [] as { lines: number; format?: string }[],
    fail: false,
    async readPane(paneId: string, _source: string, lines: number, format?: string): Promise<PaneRead> {
      this.reads.push({ lines, format });
      if (this.fail) throw new Error("herdr down");
      return { pane_id: paneId, text: this.screen, truncated: false, revision: 0 };
    },
  };
  const snap = (): EngineSnapshot => ({ agents: [view], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" });
  const watcher = createCompactionWatcher({
    store,
    engine: { current: snap, onUpdate: () => () => {} },
    herdr: pane as unknown as HerdrClient,
    now: () => clock.now,
    log: () => {},
  });
  const tick = async (ms = READ_EVERY_MS) => {
    clock.now += ms;
    await watcher.poll();
  };
  const setStatus = (status: ThreadStatus) =>
    store.append([{ type: "thread.updated", threadId: "t1", payload: { patch: { status }, at: clock.now } }]);
  return { store, pane, watcher, tick, setStatus, compacting: () => store.getThread("t1")?.compacting === true };
}

describe("compaction watch", () => {
  test("a working Claude thread whose screen shows the compaction row is compacting; it clears when the row goes", async () => {
    const r = rig();
    await r.tick();
    expect(r.compacting()).toBe(false);
    expect(r.pane.reads).toEqual([{ lines: COMPACTION_READ_LINES, format: "text" }]);

    r.pane.screen = COMPACTING;
    await r.tick();
    expect(r.compacting()).toBe(true);
    // On the wire: the shell snapshot carries the flag.
    expect(r.store.snapshotShell().threads[0]?.compacting).toBe(true);

    r.pane.screen = WORKING;
    await r.tick();
    expect(r.compacting()).toBe(false);
    expect(r.store.snapshotShell().threads[0]).not.toHaveProperty("compacting");
  });

  test("one event per change, not per poll", async () => {
    const r = rig();
    r.pane.screen = COMPACTING;
    const before = r.store.lastSequence();
    await r.tick();
    await r.tick();
    await r.tick();
    expect(r.store.lastSequence()).toBe(before + 1);
  });

  test("reads are throttled per thread", async () => {
    const r = rig();
    await r.tick();
    await r.tick(10);
    await r.tick(10);
    expect(r.pane.reads).toHaveLength(1);
  });

  test("a thread that stops working stops compacting, without a read", async () => {
    const r = rig();
    r.pane.screen = COMPACTING;
    await r.tick();
    expect(r.compacting()).toBe(true);
    r.setStatus("idle");
    const reads = r.pane.reads.length;
    await r.tick();
    expect(r.compacting()).toBe(false);
    expect(r.pane.reads).toHaveLength(reads);
  });

  test("a failed read keeps the flag; a harness with no compaction row is never read", async () => {
    const r = rig();
    r.pane.screen = COMPACTING;
    await r.tick();
    r.pane.fail = true;
    await r.tick();
    expect(r.compacting()).toBe(true);

    const g = rig({ harness: "grok" });
    await g.tick();
    expect(g.pane.reads).toEqual([]);
  });
});
