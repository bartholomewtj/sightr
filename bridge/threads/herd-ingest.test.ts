import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NO_CAPABILITIES, type Project, type RuntimeRequest, type ThreadStatus } from "../../shared/v2/contracts.ts";
import type { AgentStatus, WorkspaceView } from "../../shared/wire.ts";
import type { PaneActivity } from "../activity.ts";
import type { JournalAdapter } from "../journal/types.ts";
import type { AgentView, EngineSnapshot } from "../state-engine.ts";
import { createProject, createThread, project, thread } from "../test/thread-fixtures.ts";
import { capabilitiesFor } from "./capabilities.ts";
import type { EventDraft, ServerThread } from "./events.ts";
import {
  createHerdIngestor,
  diffHerd,
  type HerdDiffContext,
  type HerdProjection,
  herdTitle,
  STARTING_GRACE_MS,
  threadStatusFor,
} from "./herd-ingest.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";

// ── Builders ─────────────────────────────────────────────────────────────────────────────────────

function agent(paneId: string, over: Partial<AgentView> = {}): AgentView {
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

function shell(paneId: string, over: Partial<AgentView> = {}): AgentView {
  return agent(paneId, { agent: "shell", kind: "shell", status: "unknown", ...over });
}

function workspace(id = "w1", number = 1, over: Partial<WorkspaceView> = {}): WorkspaceView {
  return { workspaceId: id, number, label: id === "w1" ? "demo" : id, focused: false, activeTabId: `${id}:t1`, tabCount: 1, paneCount: 1, ...over };
}

function snap(agents: AgentView[], shellPanes: AgentView[] = [], workspaces = [workspace()]): EngineSnapshot {
  return { agents, shellPanes, workspaces, tabs: [], bridge: "connected" };
}

const EMPTY: HerdProjection = { projects: [], threads: [], openRuns: [], pendingRequests: [] };

const journals = { claude: {} as JournalAdapter, pi: {} as JournalAdapter };

function ctx(over: Partial<HerdDiffContext> = {}): HerdDiffContext {
  let n = 0;
  return {
    now: 5_000,
    newId: () => `id${++n}`,
    first: false,
    missingThreads: new Set(),
    missingProjects: new Set(),
    activity: () => undefined,
    touchedAt: () => undefined,
    capabilities: (h) => capabilitiesFor(h, journals),
    ...over,
  };
}

const types = (events: EventDraft[]) => events.map((e) => e.type);
/** The payload of the one `thread.updated` in `events`. */
const updated = (events: EventDraft[]) => events.find((e) => e.type === "thread.updated")?.payload;

/** A live thread for pane `paneId` as the herd would have made it, so a diff against `agent(paneId)` is empty. */
function liveThread(id: string, paneId: string, over: Partial<ServerThread> = {}): ServerThread {
  return thread(id, {
    paneId,
    terminalId: `term-${paneId}`,
    title: "claude · demo",
    capabilities: capabilitiesFor("claude", journals),
    lastActivityAt: 1_000,
    ...over,
  });
}

const demo = project("w1", { label: "demo" });

function request(id: string, threadId: string, kind: RuntimeRequest["kind"] = "permission"): RuntimeRequest {
  return {
    id,
    threadId,
    kind,
    prompt: "Allow?",
    options: [{ label: "Yes", keys: ["1"] }],
    status: "pending",
    bindingHash: "h",
    createdAt: 1,
    updatedAt: 1,
  };
}

// ── diffHerd ─────────────────────────────────────────────────────────────────────────────────────

describe("diffHerd", () => {
  test("a new pane makes a project and a thread", () => {
    const { events } = diffHerd(snap([agent("w1:p1")]), EMPTY, ctx());
    expect(types(events)).toEqual(["project.upserted", "thread.created"]);
    expect(events[0]!.payload).toEqual({
      project: { id: "w1", label: "demo", labelSource: "herd", number: 1, order: 1, status: "idle" },
    });
    const created = (events[1] as Extract<EventDraft, { type: "thread.created" }>).payload.thread;
    expect(created).toEqual({
      id: "id1",
      paneId: "w1:p1",
      terminalId: "term-w1:p1",
      projectId: "w1",
      title: "claude · demo",
      titleSource: "herd",
      harness: "claude",
      status: "idle",
      shelf: "active",
      unreadDone: false,
      lastActivityAt: 5_000,
      createdAt: 5_000,
      updatedAt: 5_000,
      capabilities: { ...NO_CAPABILITIES, hasJournal: true, canQueueDrain: true },
    });
  });

  test("an unchanged snapshot gives nothing", () => {
    const projection = { ...EMPTY, projects: [demo], threads: [liveThread("t1", "w1:p1")] };
    expect(diffHerd(snap([agent("w1:p1")]), projection, ctx()).events).toEqual([]);
  });

  test("a linked worktree records its repo; a workspace only a pane names still gets a project", () => {
    const ws = workspace("w1", 3, { worktree: { repoKey: "repo", repoName: "r", repoRoot: "/r", checkoutPath: "/w", isLinkedWorktree: true } });
    const { events } = diffHerd(snap([agent("w1:p1"), agent("w9:p1", { workspaceId: "w9", workspaceLabel: "late", workspaceNumber: 9 })], [], [ws]), EMPTY, ctx());
    const projects = events.filter((e) => e.type === "project.upserted").map((e) => (e.payload as { project: unknown }).project);
    expect(projects).toEqual([
      expect.objectContaining({ id: "w1", order: 3, repoKey: "repo", worktreeOf: "repo" }),
      expect.objectContaining({ id: "w9", label: "late", number: 9 }),
    ]);
  });

  test("a primary checkout records its repo key and no worktreeOf", () => {
    const ws = workspace("w1", 1, { worktree: { repoKey: "repo", repoName: "r", repoRoot: "/r", checkoutPath: "/r", isLinkedWorktree: false } });
    const { events } = diffHerd(snap([agent("w1:p1")], [], [ws]), EMPTY, ctx());
    const upsert = events.find((e) => e.type === "project.upserted")?.payload as { project: Project } | undefined;
    expect(upsert?.project).toMatchObject({ id: "w1", repoKey: "repo" });
    expect(upsert?.project.worktreeOf).toBeUndefined();
  });

  test("a user label survives a herd rename", () => {
    const projection = { ...EMPTY, projects: [project("w1", { label: "mine", labelSource: "user" })] };
    const { events } = diffHerd(snap([], [], [workspace("w1", 1, { label: "herd name" })]), projection, ctx());
    expect(events).toEqual([]);
  });

  test("title precedence", () => {
    const full = agent("p", {
      paneLabel: "label",
      sessionName: "session",
      agentName: "agent",
      terminalTitle: "terminal",
      summary: "summary",
      tabLabel: "tab",
    });
    const drop = (keys: (keyof AgentView)[]) => {
      const out = { ...full };
      for (const k of keys) delete out[k];
      return out;
    };
    expect(herdTitle(full, "claude")).toBe("label");
    expect(herdTitle(drop(["paneLabel"]), "claude")).toBe("session");
    expect(herdTitle(drop(["paneLabel", "sessionName"]), "claude")).toBe("agent");
    expect(herdTitle(drop(["paneLabel", "sessionName", "agentName"]), "claude")).toBe("terminal");
    expect(herdTitle(drop(["paneLabel", "sessionName", "agentName", "terminalTitle"]), "claude")).toBe("summary");
    const bare = drop(["paneLabel", "sessionName", "agentName", "terminalTitle", "summary"]);
    expect(herdTitle(bare, "claude")).toBe("claude · tab");
    expect(herdTitle({ ...bare, tabLabel: undefined }, "claude")).toBe("claude · demo");
    expect(herdTitle({ ...bare, tabLabel: undefined, cwd: "/home/you/site/" }, "pi")).toBe("pi · site");
  });

  test("a harness change patches the thread rather than making a new one", () => {
    const projection = { ...EMPTY, projects: [demo], threads: [liveThread("t1", "w1:p1")] };
    const { events } = diffHerd(snap([], [shell("w1:p1")]), projection, ctx());
    expect(types(events)).toEqual(["thread.updated"]);
    expect(events[0]).toMatchObject({
      threadId: "t1",
      payload: {
        patch: {
          harness: "shell",
          title: "shell · demo",
          capabilities: { ...NO_CAPABILITIES },
        },
      },
    });
  });

  test("an unknown agent keeps its raw name; a variant folds onto its family", () => {
    const { events } = diffHerd(snap([agent("w1:p1", { agent: "opencode" }), agent("w1:p2", { agent: "claude-beta" })]), EMPTY, ctx());
    const made = events.filter((e) => e.type === "thread.created").map((e) => (e.payload as { thread: ServerThread }).thread);
    expect(made.map((t) => [t.harness, t.capabilities.hasJournal, t.capabilities.canQueueDrain])).toEqual([
      ["opencode", false, true],
      ["claude", true, true],
    ]);
  });

  test("a user title is not overwritten", () => {
    const projection = { ...EMPTY, projects: [demo], threads: [liveThread("t1", "w1:p1", { title: "mine", titleSource: "user" })] };
    expect(diffHerd(snap([agent("w1:p1", { paneLabel: "herd says" })]), projection, ctx()).events).toEqual([]);
  });

  test("session ref changes are patched, and a vanished ref clears", () => {
    const projection = { ...EMPTY, projects: [demo], threads: [liveThread("t1", "w1:p1")] };
    const withRef = diffHerd(snap([agent("w1:p1", { agentSession: { kind: "id", value: "s1" } })]), projection, ctx());
    expect(withRef.events[0]!.payload).toMatchObject({ patch: { sessionRef: { kind: "id", value: "s1" } } });
    const had = { ...projection, threads: [liveThread("t1", "w1:p1", { sessionRef: { kind: "id", value: "s1" } })] };
    expect(diffHerd(snap([agent("w1:p1", { agentSession: { kind: "id", value: "s1" } })]), had, ctx()).events).toEqual([]);
    expect(diffHerd(snap([agent("w1:p1")]), had, ctx()).events[0]!.payload).toMatchObject({ patch: { sessionRef: null } });
  });

  test("an expired snooze returns to active; a live one stays", () => {
    const projection = {
      ...EMPTY,
      projects: [demo],
      threads: [
        liveThread("t1", "w1:p1", { shelf: "snoozed", snoozedUntil: 4_000 }),
        liveThread("t2", "w1:p2", { shelf: "snoozed", snoozedUntil: 9_000 }),
      ],
    };
    const { events } = diffHerd(snap([agent("w1:p1"), agent("w1:p2")]), projection, ctx());
    expect(events).toEqual([{ type: "thread.shelf-changed", threadId: "t1", payload: { shelf: "active", at: 5_000 } }]);
  });

  test("a snoozed or settled thread that finishes work returns to active; a pinned one stays pinned", () => {
    const projection = {
      ...EMPTY,
      projects: [demo],
      threads: [
        liveThread("t1", "w1:p1", { shelf: "snoozed", snoozedUntil: 9_000, status: "working" }),
        liveThread("t2", "w1:p2", { shelf: "settled", settledAt: 1, status: "working" }),
        liveThread("t3", "w1:p3", { shelf: "pinned", pinOrder: 1, pinnedAt: 1, status: "working" }),
      ],
    };
    const { events } = diffHerd(snap([agent("w1:p1"), agent("w1:p2"), agent("w1:p3")]), projection, ctx());
    expect(events.filter((e) => e.type === "thread.shelf-changed").map((e) => e.threadId)).toEqual(["t1", "t2"]);
  });

  test("a closed project reopens when its workspace comes back", () => {
    const projection = { ...EMPTY, projects: [project("w1", { label: "demo", closedAt: 10 })] };
    const { events } = diffHerd(snap([]), projection, ctx());
    expect(events).toEqual([{ type: "project.upserted", payload: { project: { ...demo } } }]);
  });

  test("a vanished workspace closes after two looks, or at once on the first reconcile", () => {
    const projection = { ...EMPTY, projects: [demo] };
    const first = diffHerd(snap([], [], []), projection, ctx());
    expect(first.events).toEqual([]);
    expect([...first.missingProjects]).toEqual(["w1"]);
    const second = diffHerd(snap([], [], []), projection, ctx({ missingProjects: first.missingProjects }));
    expect(second.events).toEqual([{ type: "project.closed", payload: { projectId: "w1", closedAt: 5_000 } }]);
    expect(types(diffHerd(snap([], [], []), projection, ctx({ first: true })).events)).toEqual(["project.closed"]);
  });
});

describe("adoption", () => {
  test("a starting thread with no terminal is adopted: one update, one thread", () => {
    const projection = {
      ...EMPTY,
      projects: [demo],
      threads: [thread("t1", { paneId: "w1:p1", terminalId: "", status: "starting", title: "new pi", harness: "pi" })],
    };
    const { events } = diffHerd(snap([agent("w1:p1", { status: "working" })]), projection, ctx());
    expect(types(events)).toEqual(["project.upserted", "thread.updated"]);
    expect(events[1]).toMatchObject({
      threadId: "t1",
      payload: { patch: { terminalId: "term-w1:p1", harness: "claude", title: "claude · demo", status: "working" } },
    });
  });

  test("a thread with a different non-empty terminal is not adopted", () => {
    const projection = { ...EMPTY, projects: [demo], threads: [liveThread("t1", "w1:p1", { terminalId: "old" })] };
    const { events } = diffHerd(snap([agent("w1:p1")]), projection, ctx());
    expect(types(events)).toEqual(["thread.archived", "thread.created"]);
    expect(events[0]).toMatchObject({ threadId: "t1", payload: { reason: "terminal-replaced" } });
  });

  test("a T07 thread whose pane is not listed yet is not archived inside the grace", () => {
    const starting = thread("t1", { paneId: "w1:p1", terminalId: "", status: "starting", updatedAt: 4_000 });
    const projection = { ...EMPTY, projects: [demo], threads: [starting] };
    const once = diffHerd(snap([]), projection, ctx({ missingThreads: new Set(["t1"]) }));
    expect(once.events.filter((e) => e.type === "thread.archived")).toEqual([]);
    const late = diffHerd(snap([]), projection, ctx({ now: 4_000 + STARTING_GRACE_MS, missingThreads: new Set(["t1"]) }));
    expect(late.events.filter((e) => e.type === "thread.archived")).toHaveLength(1);
  });
});

describe("identity", () => {
  test("same pane with a new terminal archives the old thread and creates a new one", () => {
    const projection = { ...EMPTY, projects: [demo], threads: [liveThread("t1", "w1:p1")] };
    const { events } = diffHerd(snap([agent("w1:p1", { terminalId: "term-2" })]), projection, ctx());
    expect(types(events)).toEqual(["thread.archived", "thread.created"]);
    expect((events[1] as Extract<EventDraft, { type: "thread.created" }>).payload.thread).toMatchObject({
      paneId: "w1:p1",
      terminalId: "term-2",
    });
  });

  test("a pane with no terminal id keys on the empty string", () => {
    const pane = agent("w1:p1");
    delete pane.terminalId;
    const { events } = diffHerd(snap([pane]), EMPTY, ctx());
    expect((events[1] as Extract<EventDraft, { type: "thread.created" }>).payload.thread.terminalId).toBe("");
    const projection = { ...EMPTY, projects: [demo], threads: [liveThread("t1", "w1:p1", { terminalId: "" })] };
    expect(diffHerd(snap([pane]), projection, ctx()).events).toEqual([]);
  });

  test("a user-archived thread whose pane lives stays archived and no twin is made", () => {
    const projection = {
      ...EMPTY,
      projects: [demo],
      threads: [liveThread("t1", "w1:p1", { shelf: "archived", archiveReason: "user", archivedAt: 1 })],
    };
    expect(diffHerd(snap([agent("w1:p1", { status: "working" })]), projection, ctx()).events).toEqual([]);
  });

  test("a thread archived as closed comes back when its pane does", () => {
    const projection = {
      ...EMPTY,
      projects: [demo],
      threads: [liveThread("t1", "w1:p1", { shelf: "archived", archiveReason: "pane-closed", archivedAt: 1 })],
    };
    const { events } = diffHerd(snap([agent("w1:p1")]), projection, ctx());
    expect(events).toEqual([{ type: "thread.shelf-changed", threadId: "t1", payload: { shelf: "active", at: 5_000 } }]);
  });
});

describe("status", () => {
  const table: [AgentStatus, boolean, RuntimeRequest["kind"][], ThreadStatus | undefined, ThreadStatus][] = [
    ["working", false, [], undefined, "working"],
    ["blocked", false, [], undefined, "input"],
    ["blocked", false, ["question"], undefined, "input"],
    ["blocked", false, ["permission"], undefined, "approval"],
    ["blocked", false, ["trust"], undefined, "approval"],
    ["done", true, [], undefined, "done"],
    ["done", false, [], undefined, "idle"],
    ["idle", false, [], undefined, "idle"],
    ["unknown", false, [], undefined, "idle"],
    ["idle", false, [], "failed", "failed"],
    ["working", false, [], "failed", "working"],
  ];
  test.each(table)("herdr %s (unread %p, requests %p, was %p) → %s", (herd, unread, kinds, previous, expected) => {
    expect(threadStatusFor(herd, unread, kinds, previous)).toBe(expected);
  });

  test("a dialog the engine detected reads as input; with a permission request, approval", () => {
    const pane = agent("w1:p1", { status: "blocked", dialogDetected: true });
    const projection = { ...EMPTY, projects: [demo], threads: [liveThread("t1", "w1:p1")] };
    const plain = diffHerd(snap([pane]), projection, ctx());
    expect(updated(plain.events)).toMatchObject({ patch: { status: "input" } });
    const asked = diffHerd(snap([pane]), { ...projection, pendingRequests: [request("q1", "t1")] }, ctx());
    expect(updated(asked.events)).toMatchObject({ patch: { status: "approval" } });
  });

  test("done reads as done only while the ledger says unread", () => {
    const projection = { ...EMPTY, projects: [demo], threads: [liveThread("t1", "w1:p1", { lastActivityAt: 3 })] };
    const unread = diffHerd(snap([agent("w1:p1", { status: "done" })]), projection, ctx({ activity: () => ({ activeAt: 3, seenAt: 2 }) }));
    expect(updated(unread.events)).toMatchObject({ patch: { status: "done", unreadDone: true } });
    const seen = diffHerd(snap([agent("w1:p1", { status: "done" })]), projection, ctx({ activity: () => ({ activeAt: 3, seenAt: 4 }) }));
    expect(seen.events).toEqual([]);
  });

  test("project roll-up is the worst active or pinned thread; snoozed and archived ones do not count", () => {
    const threads = [
      liveThread("t1", "w1:p1", { status: "working" }),
      liveThread("t2", "w1:p2", { status: "input", shelf: "pinned", pinOrder: 1, pinnedAt: 1 }),
      liveThread("t3", "w1:p3", { status: "input", shelf: "snoozed", snoozedUntil: 9_000 }),
      liveThread("t4", "w1:p4", { status: "input", shelf: "archived", archiveReason: "user", archivedAt: 1 }),
    ];
    const panes = [
      agent("w1:p1", { status: "working" }),
      agent("w1:p2", { status: "blocked" }),
      agent("w1:p3", { status: "blocked" }),
      agent("w1:p4", { status: "blocked" }),
    ];
    const { events } = diffHerd(snap(panes), { ...EMPTY, projects: [demo], threads }, ctx());
    expect(events).toEqual([{ type: "project.upserted", payload: { project: { ...demo, status: "input" } } }]);
    // Pin goes quiet: the snoozed `input` must not hold the project at input.
    const quiet = [panes[0]!, agent("w1:p2"), panes[2]!, panes[3]!];
    const settled = threads.map((t) => (t.id === "t2" ? { ...t, status: "idle" as const } : t));
    const after = diffHerd(snap(quiet), { ...EMPTY, projects: [{ ...demo, status: "input" }], threads: settled }, ctx());
    expect(after.events).toEqual([{ type: "project.upserted", payload: { project: { ...demo, status: "working" } } }]);
  });
});

// ── The ingestor against a real store ───────────────────────────────────────────────────────────

const stores: ThreadStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempStore(path?: string): ThreadStore {
  let file = path;
  if (!file) {
    const dir = mkdtempSync(join(tmpdir(), "sightr-herd-"));
    dirs.push(dir);
    file = join(dir, "threads.sqlite");
  }
  const store = openThreadStore(file, { log: () => {} });
  stores.push(store);
  return store;
}

class FakeEngine {
  snap: EngineSnapshot = snap([]);
  private updates = new Set<(s: EngineSnapshot) => void>();
  private transitions = new Set<(a: AgentView, from: AgentStatus, to: AgentStatus) => void>();
  onUpdate(fn: (s: EngineSnapshot) => void) {
    this.updates.add(fn);
    return () => this.updates.delete(fn);
  }
  onTransition(fn: (a: AgentView, from: AgentStatus, to: AgentStatus) => void) {
    this.transitions.add(fn);
    return () => this.transitions.delete(fn);
  }
  onRemove() {
    return () => true;
  }
  current() {
    return this.snap;
  }
  /** One poll: transitions first, then the update, as the real engine does. */
  poll(next: EngineSnapshot, moved: [AgentView, AgentStatus][] = []) {
    this.snap = next;
    for (const [a, from] of moved) for (const fn of this.transitions) fn(a, from, a.status);
    if (next.bridge === "connected") for (const fn of this.updates) fn(next);
  }
}

/** The ledger rules that matter here, without the file. */
class FakeActivity {
  panes = new Map<string, PaneActivity>();
  constructor(private readonly now: () => number) {}
  get(_session: string, paneId: string) {
    return this.panes.get(paneId);
  }
  ensure(paneId: string) {
    if (!this.panes.has(paneId)) this.panes.set(paneId, { activeAt: this.now(), seenAt: this.now() });
  }
  noteActive(paneId: string) {
    const prev = this.panes.get(paneId);
    this.panes.set(paneId, { activeAt: this.now(), seenAt: prev?.seenAt ?? this.now() });
  }
  noteSeen(paneId: string) {
    const prev = this.panes.get(paneId);
    this.panes.set(paneId, { activeAt: prev?.activeAt ?? this.now(), seenAt: this.now() });
  }
}

function rig(store = tempStore()) {
  let clock = 10_000;
  const now = () => clock;
  const engine = new FakeEngine();
  const activity = new FakeActivity(now);
  let n = 0;
  const ingestor = createHerdIngestor({ store, engine, activity, journals, now, newId: () => `n${++n}`, log: () => {} });
  ingestor.start();
  /** A poll the way index.ts wires it: ledger first (transitions, sightings), then the ingest. */
  const poll = (next: EngineSnapshot, moved: [AgentView, AgentStatus][] = []) => {
    for (const [a] of moved) activity.noteActive(a.paneId);
    for (const p of [...next.agents, ...next.shellPanes]) activity.ensure(p.paneId);
    const before = store.lastSequence();
    engine.poll(next, moved);
    return store.storedEventsAfter(before);
  };
  return { store, engine, activity, ingestor, poll, tick: (ms: number) => (clock += ms) };
}

describe("ingestor", () => {
  test("reconcile is idempotent", () => {
    const { store, poll } = rig();
    expect(types(poll(snap([agent("w1:p1")], [shell("w1:p2")])))).toEqual(["project.upserted", "thread.created", "thread.created"]);
    expect(poll(snap([agent("w1:p1")], [shell("w1:p2")]))).toEqual([]);
    expect(store.listThreads().map((t) => t.harness)).toEqual(["claude", "shell"]);
  });

  test("a transition to done makes unreadDone; noteSeen clears it on the next reconcile", () => {
    const { store, activity, ingestor, engine, poll, tick } = rig();
    poll(snap([agent("w1:p1", { status: "working" })]));
    const first = store.listThreads()[0]!;
    expect(first).toMatchObject({ status: "working", unreadDone: false });

    tick(1_000);
    const done = agent("w1:p1", { status: "done" });
    poll(snap([done]), [[done, "working"]]);
    expect(store.getThread(first.id)).toMatchObject({ status: "done", unreadDone: true, lastActivityAt: 11_000 });

    tick(1_000);
    activity.noteSeen("w1:p1");
    ingestor.reconcile(engine.current());
    expect(store.getThread(first.id)).toMatchObject({ status: "idle", unreadDone: false });
  });

  test("a first sighting is read, even of a done pane", () => {
    const { store, poll } = rig();
    poll(snap([agent("w1:p1", { status: "done" })]));
    expect(store.listThreads()[0]).toMatchObject({ status: "idle", unreadDone: false });
  });

  test("markUnread on an idle thread leaves it idle", () => {
    const { store, activity, ingestor, engine, poll, tick } = rig();
    poll(snap([agent("w1:p1", { status: "idle" })]));
    tick(1_000);
    activity.noteActive("w1:p1");
    ingestor.reconcile(engine.current());
    expect(store.listThreads()[0]).toMatchObject({ status: "idle", unreadDone: false });
  });

  test("one missing poll keeps the thread; two archive it, end the open run and expire the request", () => {
    const { store, poll } = rig();
    poll(snap([agent("w1:p1", { status: "working" }), agent("w1:p2")]));
    const t1 = store.listThreads().find((t) => t.paneId === "w1:p1")!;
    store.append([
      { type: "run.started", threadId: t1.id, payload: { run: { id: "r1", threadId: t1.id, ordinal: 1, status: "running", startedAt: 1 } } },
      { type: "runtime-request.updated", threadId: t1.id, payload: { request: request("q1", t1.id) } },
    ]);

    expect(poll(snap([agent("w1:p2")]))).toEqual([]);
    expect(store.getThread(t1.id)?.shelf).toBe("active");

    const events = poll(snap([agent("w1:p2")]));
    expect(types(events)).toEqual(["project.upserted", "run.ended", "runtime-request.updated", "thread.archived"]);
    expect(store.getThread(t1.id)).toMatchObject({ shelf: "archived", archiveReason: "pane-closed" });
    expect(store.openRuns()).toEqual([]);
    expect(store.pendingRequests()).toEqual([]);
    expect(store.snapshotThread(t1.id)!.runs[0]).toMatchObject({ status: "interrupted" });
  });

  test("a pane that comes back after one missing poll is untouched", () => {
    const { store, poll } = rig();
    poll(snap([agent("w1:p1")]));
    poll(snap([]));
    expect(poll(snap([agent("w1:p1")]))).toEqual([]);
    poll(snap([]));
    expect(store.listThreads()[0]!.shelf).toBe("active");
  });

  test("an agent exiting into a shell keeps the thread", () => {
    const { store, poll } = rig();
    poll(snap([agent("w1:p1")]));
    poll(snap([], [shell("w1:p1")]));
    poll(snap([], [shell("w1:p1")]));
    expect(store.listThreads()).toEqual([expect.objectContaining({ harness: "shell", shelf: "active", status: "idle" })]);
  });

  test("shelf, pin and user titles survive reconciles and a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "sightr-herd-"));
    dirs.push(dir);
    const file = join(dir, "threads.sqlite");
    const a = rig(tempStore(file));
    a.poll(snap([agent("w1:p1"), agent("w1:p2")]));
    const [t1, t2] = a.store.listThreads();
    a.store.append([
      { type: "thread.updated", threadId: t1!.id, payload: { patch: { title: "mine", titleSource: "user" }, at: 1 } },
      { type: "thread.shelf-changed", threadId: t2!.id, payload: { shelf: "pinned", pinOrder: 1, at: 1 } },
    ]);
    a.poll(snap([agent("w1:p1", { paneLabel: "x" }), agent("w1:p2")]));
    a.ingestor.stop();
    a.store.close();
    stores.splice(stores.indexOf(a.store), 1);

    const b = rig(tempStore(file));
    b.poll(snap([agent("w1:p1", { paneLabel: "x" }), agent("w1:p2")]));
    expect(b.store.getThread(t1!.id)).toMatchObject({ title: "mine", titleSource: "user", shelf: "active" });
    expect(b.store.getThread(t2!.id)).toMatchObject({ shelf: "pinned", pinOrder: 1 });
  });

  test("restart: threads whose panes went while the bridge was down are archived at once", () => {
    const store = tempStore();
    store.append([
      createProject(demo),
      createThread(liveThread("t1", "w1:p1")),
      createThread(liveThread("t2", "w1:p2")),
      createThread(liveThread("t3", "w1:p3")),
    ]);
    const { poll } = rig(store);
    const events = poll(snap([agent("w1:p1")]));
    expect(events.filter((e) => e.type === "thread.archived").map((e) => [e.threadId, (e.payload as { reason: string }).reason])).toEqual([
      ["t2", "closed-while-down"],
      ["t3", "closed-while-down"],
    ]);
    expect(store.getThread("t1")?.shelf).toBe("active");
  });

  test("restart with herdr unreachable changes nothing", () => {
    const store = tempStore();
    store.append([createProject(demo), createThread(liveThread("t1", "w1:p1"))]);
    const { ingestor, engine } = rig(store);
    const before = store.lastSequence();
    engine.poll({ ...snap([]), bridge: "disconnected" });
    expect(ingestor.reconcile({ ...snap([]), bridge: "disconnected" })).toBe(0);
    expect(store.lastSequence()).toBe(before);
    expect(store.getThread("t1")?.shelf).toBe("active");
  });

  test("a store failure is logged and retried, never thrown into the engine", () => {
    const store = tempStore();
    const logs: string[] = [];
    const broken = { ...store, listThreads: () => { throw new Error("disk"); } } as ThreadStore;
    const ingestor = createHerdIngestor({ store: broken, engine: new FakeEngine(), activity: new FakeActivity(() => 1), journals: null, log: (m) => logs.push(m) });
    expect(ingestor.reconcile(snap([agent("w1:p1")]))).toBe(0);
    expect(logs[0]).toContain("disk");
  });

  test("stop unsubscribes", () => {
    const { ingestor, engine, store } = rig();
    ingestor.stop();
    engine.poll(snap([agent("w1:p1")]));
    expect(store.lastSequence()).toBe(0);
  });
});

describe("capabilitiesFor", () => {
  test("journal from the registry, queue drain for agents only", () => {
    expect(capabilitiesFor("claude", journals)).toEqual({ ...NO_CAPABILITIES, hasJournal: true, canQueueDrain: true });
    expect(capabilitiesFor("agy", journals)).toEqual({ ...NO_CAPABILITIES, canQueueDrain: true });
    expect(capabilitiesFor("claude", null)).toEqual({ ...NO_CAPABILITIES, canQueueDrain: true });
    expect(capabilitiesFor("shell", journals)).toEqual(NO_CAPABILITIES);
  });
});
