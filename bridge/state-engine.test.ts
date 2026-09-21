import { describe, expect, test } from "bun:test";

import type { BeaconSweepDeps } from "./beacon/reader.ts";
import { overlayFromAgent, engineCadence, StateEngine, STATUS_HOLD_MS, type EngineSnapshot } from "./state-engine.ts";
import type { HerdrClient, WireAgent } from "./herdr-client.ts";
import type { AgentStatus } from "../shared/wire.ts";

// The state engine polls Herdr, shapes the snapshot, and fires status transitions (which drive push
// notifications). We exercise it with a fake HerdrClient whose returned panes change between polls.

interface FakePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd: string;
  agent?: string | null;
  agent_status: AgentStatus;
  label?: string | null;
  revision: number;
  agent_session?: { source?: string; agent?: string; kind?: string; value?: string } | null;
  scroll?: {
    offset_from_bottom: number;
    max_offset_from_bottom: number;
    viewport_rows: number;
  } | null;
}

function pane(
  id: string,
  ws: string,
  status: AgentStatus,
  agent: string | null,
  label?: string | null,
): FakePane {
  return {
    pane_id: id,
    terminal_id: "term",
    workspace_id: ws,
    tab_id: `${ws}:t1`,
    focused: false,
    cwd: "/home/you/demo",
    agent,
    agent_status: status,
    ...(label !== undefined ? { label } : {}),
    revision: 0,
  };
}

const ws = (id: string, number: number) => ({
  workspace_id: id,
  number,
  label: id,
  focused: false,
  pane_count: 1,
  tab_count: 1,
  active_tab_id: `${id}:t1`,
  agent_status: "idle" as AgentStatus,
});

class FakeHerdr {
  panes: FakePane[] = [];
  agents: WireAgent[] = [];
  workspaces = [ws("w1", 1), ws("w2", 2)];
  tabs = [
    {
      tab_id: "w1:t1",
      workspace_id: "w1",
      number: 1,
      label: "1",
      focused: false,
      pane_count: 1,
      agent_status: "idle" as AgentStatus,
    },
  ];
  // The default path (herdr ≥ 0.7.2): one snapshot call carries workspaces + panes + tabs.
  sessionSnapshot() {
    return Promise.resolve({
      version: "0.7.2",
      protocol: 16,
      workspaces: this.workspaces,
      tabs: this.tabs,
      panes: this.panes,
      agents: this.agents,
    });
  }
  listWorkspaces() {
    return Promise.resolve(this.workspaces);
  }
  listPanes() {
    return Promise.resolve(this.panes);
  }
  listTabs() {
    return Promise.resolve(this.tabs);
  }
}

function makeEngine(now: () => number = Date.now) {
  const herdr = new FakeHerdr();
  const engine = new StateEngine(herdr as unknown as HerdrClient, 1500, now);
  const transitions: Array<{ pane: string; from: AgentStatus; to: AgentStatus }> = [];
  engine.onTransition((a, from, to) => transitions.push({ pane: a.paneId, from, to }));
  const removed: string[] = [];
  engine.onRemove((paneId) => removed.push(paneId));
  const poll = () => (engine as unknown as { poll(): Promise<void> }).poll();
  return { herdr, engine, transitions, removed, poll };
}

describe("StateEngine — transition detection", () => {
  test("does not fire a transition on the first sighting of a pane", async () => {
    const { herdr, transitions, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll();
    expect(transitions).toEqual([]);
  });

  test("fires when an agent's status changes between polls", async () => {
    const { herdr, transitions, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "claude")];
    await poll(); // first sighting — suppressed
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll();
    expect(transitions).toEqual([{ pane: "w1:p1", from: "working", to: "blocked" }]);
  });

  test("prunes a vanished pane so its return is a fresh first sighting", async () => {
    const { herdr, transitions, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll(); // first sighting
    herdr.panes = []; // pane closed
    await poll(); // pruned from prevStatus
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll(); // reappears — must be treated as new, not a transition
    expect(transitions).toEqual([]);
  });
});

describe("StateEngine — working→resting hold", () => {
  // Grok / Cursor / Pi keep the composer on screen during a turn, so Herdr reports `done` between tool calls.
  // Publishing that as a finish makes Ready · unseen (green) flash against Working on every tool.

  function heldEngine() {
    let now = 1_000_000;
    const { herdr, engine, transitions, poll } = makeEngine(() => now);
    const status = () => engine.current().agents[0]?.status;
    return {
      herdr,
      transitions,
      status,
      poll,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  test("a brief done after working stays working and fires no transition", async () => {
    const { herdr, transitions, status, poll, advance } = heldEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "grok")];
    await poll();
    herdr.panes = [pane("w1:p1", "w1", "done", "grok")];
    await poll();
    expect(status()).toBe("working");
    expect(transitions).toEqual([]);
    advance(STATUS_HOLD_MS - 1);
    await poll();
    expect(status()).toBe("working");
    expect(transitions).toEqual([]);
  });

  test("done that lasts the hold becomes done and fires one working→done transition", async () => {
    const { herdr, transitions, status, poll, advance } = heldEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "grok")];
    await poll();
    herdr.panes = [pane("w1:p1", "w1", "done", "grok")];
    await poll();
    advance(STATUS_HOLD_MS);
    await poll();
    expect(status()).toBe("done");
    expect(transitions).toEqual([{ pane: "w1:p1", from: "working", to: "done" }]);
  });

  test("working→done→working before the hold elapses is one continuous working run", async () => {
    const { herdr, transitions, status, poll, advance } = heldEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "grok")];
    await poll();
    herdr.panes = [pane("w1:p1", "w1", "done", "grok")];
    await poll();
    advance(400);
    herdr.panes = [pane("w1:p1", "w1", "working", "grok")];
    await poll();
    expect(status()).toBe("working");
    expect(transitions).toEqual([]);
    herdr.panes = [pane("w1:p1", "w1", "done", "grok")];
    await poll();
    advance(STATUS_HOLD_MS - 1);
    await poll();
    expect(status()).toBe("working");
    expect(transitions).toEqual([]);
  });

  test("working→blocked is not held — a permission card is not a blip", async () => {
    const { herdr, transitions, status, poll } = heldEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "grok")];
    await poll();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "grok")];
    await poll();
    expect(status()).toBe("blocked");
    expect(transitions).toEqual([{ pane: "w1:p1", from: "working", to: "blocked" }]);
  });

  test("a first sighting that is already done is not held", async () => {
    const { herdr, transitions, status, poll } = heldEngine();
    herdr.panes = [pane("w1:p1", "w1", "done", "grok")];
    await poll();
    expect(status()).toBe("done");
    expect(transitions).toEqual([]);
  });
});

describe("StateEngine — removal events", () => {
  test("fires onRemove when a previously-seen agent pane vanishes", async () => {
    const { herdr, removed, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll(); // first sighting — now tracked
    herdr.panes = []; // pane closed
    await poll();
    expect(removed).toEqual(["w1:p1"]);
  });

  test("does not fire onRemove while a pane persists or merely changes status", async () => {
    const { herdr, removed, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "claude")];
    await poll();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")]; // status change, still present
    await poll();
    expect(removed).toEqual([]);
  });

  test("does not fire onRemove for a vanished bare shell pane (never tracked)", async () => {
    const { herdr, removed, poll } = makeEngine();
    herdr.panes = [pane("w1:p2", "w1", "unknown", null)]; // shell pane, no agent
    await poll();
    herdr.panes = [];
    await poll();
    expect(removed).toEqual([]);
  });
});

describe("StateEngine — in-flight guard", () => {
  // A Herdr whose snapshot call hangs until released, so we can catch a second tick landing mid-poll.
  class GatedHerdr {
    starts = 0;
    private open: () => void = () => {};
    private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
    constructor(private readonly panes: FakePane[]) {}
    release() {
      this.open();
    }
    async sessionSnapshot() {
      this.starts++;
      await this.gate;
      return { version: "0.7.2", protocol: 16, workspaces: [ws("w1", 1)], tabs: [], panes: this.panes };
    }
  }

  test("skips a tick while the previous poll is still in flight", async () => {
    const herdr = new GatedHerdr([pane("w1:p1", "w1", "idle", "claude")]);
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    const poll = () => (engine as unknown as { poll(): Promise<void> }).poll();

    const first = poll(); // starts the poll, hangs on the gate
    await poll(); // second tick — must early-return, not start a second poll
    expect(herdr.starts).toBe(1);

    herdr.release();
    await first;
    expect(herdr.starts).toBe(1);
  });
});

describe("StateEngine — snapshot shaping", () => {
  test("preserves the tab order reported by Herdr", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.tabs = [
      { ...herdr.tabs[0]!, tab_id: "w1:t2", number: 2, label: "second" },
      { ...herdr.tabs[0]!, tab_id: "w1:t1", number: 1, label: "first" },
    ];

    await poll();

    expect(engine.current().tabs.map((tab) => tab.tabId)).toEqual(["w1:t2", "w1:t1"]);
  });

  test("splits agent panes from bare shell panes", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude"), pane("w1:p2", "w1", "unknown", null)];
    await poll();
    const snap = engine.current();
    expect(snap.agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    expect(snap.shellPanes.map((a) => a.paneId)).toEqual(["w1:p2"]);
    expect(snap.shellPanes[0]!.agent).toBe("shell");
    expect(snap.bridge).toBe("connected");
  });

  test("threads a pane label through to the view when set, on agents and shells alike", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [
      pane("w1:p1", "w1", "idle", "claude", "deploy"),
      pane("w1:p2", "w1", "unknown", null, "logs"),
    ];
    await poll();
    const snap = engine.current();
    expect(snap.agents[0]!.paneLabel).toBe("deploy");
    expect(snap.shellPanes[0]!.paneLabel).toBe("logs");
  });

  test("leaves paneLabel absent when the pane has no label (or a null/empty one)", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [
      pane("w1:p1", "w1", "idle", "claude"), // no label field at all
      pane("w1:p2", "w1", "idle", "grok", null), // explicitly null
      pane("w1:p3", "w1", "idle", "grok", ""), // empty string → treated as unset
    ];
    await poll();
    for (const a of engine.current().agents) {
      expect(a.paneLabel).toBeUndefined();
      expect("paneLabel" in a).toBe(false);
    }
  });

  test("sorts agents by urgency (blocked first), then workspace number", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [
      pane("w2:p1", "w2", "idle", "claude"),
      pane("w1:p1", "w1", "blocked", "grok"),
      pane("w2:p2", "w2", "working", "claude"),
    ];
    await poll();
    expect(engine.current().agents.map((a) => a.paneId)).toEqual(["w1:p1", "w2:p2", "w2:p1"]);
  });

  test("marks the bridge disconnected when a poll throws", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(engine.current().bridge).toBe("connected");
    herdr.sessionSnapshot = () => Promise.reject(new Error("socket down"));
    await poll();
    expect(engine.current().bridge).toBe("disconnected");
  });
});

describe("StateEngine — snapshot vs legacy path", () => {
  const drivePoll = (engine: StateEngine) =>
    (engine as unknown as { poll(): Promise<void> }).poll();

  const snap = (panes: FakePane[]) => ({
    version: "0.7.2",
    protocol: 16,
    workspaces: [ws("w1", 1)],
    tabs: [],
    panes,
  });

  test("polls via session.snapshot and never touches the list calls when supported", async () => {
    let listCalls = 0;
    const herdr = {
      sessionSnapshot: () => Promise.resolve(snap([pane("w1:p1", "w1", "idle", "claude")])),
      listWorkspaces: () => ((listCalls++), Promise.resolve([])),
      listPanes: () => ((listCalls++), Promise.resolve([])),
      listTabs: () => ((listCalls++), Promise.resolve([])),
    };
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    await drivePoll(engine);
    expect(listCalls).toBe(0);
    expect(engine.current().agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    expect(engine.current().bridge).toBe("connected");
  });

  test("an unknown-variant error falls through to list calls in the SAME tick, then never retries snapshot", async () => {
    let snapCalls = 0;
    let listCalls = 0;
    const herdr = {
      sessionSnapshot: () => {
        snapCalls++;
        return Promise.reject(
          new Error(
            "herdr session.snapshot: invalid_request: invalid request: unknown variant `session.snapshot`, expected one of `ping`",
          ),
        );
      },
      listWorkspaces: () => ((listCalls++), Promise.resolve([ws("w1", 1)])),
      listPanes: () => Promise.resolve([pane("w1:p1", "w1", "idle", "claude")]),
      listTabs: () => Promise.resolve([]),
    };
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    await drivePoll(engine);
    // Same-tick fallback: one snapshot attempt, then the list path, connected with real data.
    expect(snapCalls).toBe(1);
    expect(listCalls).toBe(1);
    expect(engine.current().bridge).toBe("connected");
    expect(engine.current().agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    // Permanent: the next tick goes straight to the list path, no wasted snapshot probe.
    await drivePoll(engine);
    expect(snapCalls).toBe(1);
    expect(listCalls).toBe(2);
  });

  test("a transient snapshot error does NOT fall back and keeps trying snapshot", async () => {
    let snapCalls = 0;
    let listCalls = 0;
    const herdr = {
      sessionSnapshot: () => {
        snapCalls++;
        return Promise.reject(new Error("herdr session.snapshot: timed out after 5000ms"));
      },
      listWorkspaces: () => ((listCalls++), Promise.resolve([])),
      listPanes: () => Promise.resolve([]),
      listTabs: () => Promise.resolve([]),
    };
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    await drivePoll(engine);
    expect(snapCalls).toBe(1);
    expect(listCalls).toBe(0); // no fallback on a transient error
    expect(engine.current().bridge).toBe("disconnected");
    await drivePoll(engine);
    expect(snapCalls).toBe(2); // still on the snapshot path
    expect(listCalls).toBe(0);
  });
});

describe("StateEngine — session name enrichment", () => {
  // A named claude input box: the rule above the ❯ prompt carries the /rename session name.
  const named = (name: string) => [`──────── ${name} ──`, "❯ "].join("\n");
  // An unnamed input box (plain rule) — no session name to extract.
  const plainBox = ["────────────────", "❯ "].join("\n");

  // A fake herdr that also serves per-pane text, so enrichSessionNames has something to read. The
  // production StateEngine short-circuits when `readPane` is absent (the other fakes here omit it),
  // which is exactly why those tests are unaffected by the enrichment step.
  class NameHerdr {
    panes: FakePane[] = [];
    texts = new Map<string, string>();
    // Every readPane call, verbatim. This read is only harmless because of WHICH source it asks for
    // and how few lines it wants; a fake that swallowed those arguments would let that regress with
    // every test still green.
    reads: Array<[string, string, number, string]> = [];
    sessionSnapshot() {
      return Promise.resolve({ version: "0.7.2", protocol: 16, workspaces: [ws("w1", 1)], tabs: [], panes: this.panes });
    }
    readPane(paneId: string, source: string, lines: number, format: string) {
      this.reads.push([paneId, source, lines, format]);
      return Promise.resolve({ pane_id: paneId, text: this.texts.get(paneId) ?? "", truncated: false, revision: 0 });
    }
  }

  function makeNameEngine(beacons: BeaconSweepDeps | null = null) {
    const herdr = new NameHerdr();
    let clock = 0;
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500, () => clock, beacons);
    const poll = () => (engine as unknown as { poll(): Promise<void> }).poll();
    const agent = (id: string) => engine.current().agents.find((a) => a.paneId === id)!;
    const advance = (ms: number) => { clock += ms; };
    return { herdr, engine, poll, agent, advance };
  }

  test("threads a claude pane's /rename session name onto the view — claude-only", async () => {
    const { herdr, poll, agent } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude"), pane("w1:p2", "w1", "idle", "grok")];
    herdr.texts.set("w1:p1", named("my-feature"));
    herdr.texts.set("w1:p2", named("ignored")); // grok is never read, so never named
    await poll();
    expect(agent("w1:p1").sessionName).toBe("my-feature");
    expect(agent("w1:p2").sessionName).toBeUndefined();
  });

  // The scroll-jump guard. A `recent` read that wants more rows than the pane shows makes Herdr
  // harvest the pages above it, and on a full-screen agent that means scrolling the operator's pane
  // up and back — once per poll, per idle claude pane. Nothing in the types stops the source from
  // drifting back, and CI can't see the symptom: it only shows on a real terminal.
  test("reads the visible grid, never recent", async () => {
    const { herdr, poll } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", named("pinned"));
    await poll();
    // The count is not the safety-critical half — `visible` clamps to the viewport however large it
    // is — so it is pinned only to keep the whole call in one assertion. Change it freely, here too.
    expect(herdr.reads).toEqual([["w1:p1", "visible", 40, "text"]]);
  });

  test("leaves sessionName absent for an unnamed claude session (plain rule)", async () => {
    const { herdr, poll, agent } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", plainBox);
    await poll();
    expect(agent("w1:p1").sessionName).toBeUndefined();
    expect("sessionName" in agent("w1:p1")).toBe(false);
  });

  test("keeps the last-known name when a later poll can't see the input box (sticky)", async () => {
    const { herdr, poll, agent, advance } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", named("kept"));
    await poll(); // learns it
    herdr.texts.set("w1:p1", "● Working…\n  ⎿  no input box in view"); // extractor → undefined
    advance(60_001);
    await poll();
    expect(agent("w1:p1").sessionName).toBe("kept");
  });

  test("a second poll does not re-read an unchanged claude pane", async () => {
    const { herdr, poll, agent } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", named("stable"));
    await poll(); await poll();
    expect(herdr.reads.length).toBe(1);
    expect(agent("w1:p1").sessionName).toBe("stable");
  });

  // The revision gate. Herdr stamps each pane with a content revision; an idle herd never moves it,
  // and re-reading a pane whose text is byte-identical is a socket round trip per pane per poll.
  test("does not re-read past the TTL while the pane revision is unchanged", async () => {
    const { herdr, poll, agent, advance } = makeNameEngine();
    herdr.panes = [{ ...pane("w1:p1", "w1", "idle", "claude"), revision: 7 }];
    herdr.texts.set("w1:p1", named("frozen"));
    await poll();
    advance(60_001);
    await poll();
    expect(herdr.reads.length).toBe(1);
    expect(agent("w1:p1").sessionName).toBe("frozen");
  });

  test("re-reads once the pane revision moves", async () => {
    const { herdr, poll, agent, advance } = makeNameEngine();
    herdr.panes = [{ ...pane("w1:p1", "w1", "idle", "claude"), revision: 7 }];
    herdr.texts.set("w1:p1", named("before"));
    await poll();
    herdr.panes = [{ ...pane("w1:p1", "w1", "idle", "claude"), revision: 8 }];
    herdr.texts.set("w1:p1", named("after"));
    advance(60_001);
    await poll();
    expect(herdr.reads.length).toBe(2);
    expect(agent("w1:p1").sessionName).toBe("after");
  });

  test("a status change re-reads the pane", async () => {
    const { herdr, poll } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")]; await poll();
    herdr.panes = [pane("w1:p1", "w1", "working", "claude")]; await poll();
    expect(herdr.reads.length).toBe(2);
  });

  // A server that omits `revision` has no gate to apply, so the TTL is the only rule — exactly the
  // behaviour every pane had before the gate existed.
  test("a cached name older than the TTL is re-read when the pane carries no revision", async () => {
    const { herdr, poll, advance } = makeNameEngine();
    const { revision: _drop, ...noRev } = pane("w1:p1", "w1", "idle", "claude");
    herdr.panes = [noRev as FakePane]; await poll();
    advance(60_000); await poll();
    expect(herdr.reads.length).toBe(2);
  });

  test("a healthy poll logs nothing", async () => {
    const { herdr, poll } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    const logs: unknown[] = [], warnings: unknown[] = [];
    const oldLog = console.log, oldWarn = console.warn;
    try { console.log = (...args) => logs.push(args); console.warn = (...args) => warnings.push(args); await poll(); await poll(); }
    finally { console.log = oldLog; console.warn = oldWarn; }
    expect(logs).toEqual([]); expect(warnings).toEqual([]);
  });

  test("drops the cached name when the pane vanishes, so a reused id starts clean", async () => {
    const { herdr, poll, agent } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", named("old"));
    await poll(); // cached
    herdr.panes = [];
    await poll(); // pane gone → cache pruned
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", plainBox); // reappears, now unnamed
    await poll();
    expect(agent("w1:p1").sessionName).toBeUndefined();
  });

  test("a failing pane read never blanks the name or fails the poll", async () => {
    const { herdr, engine, poll, agent, advance } = makeNameEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", named("safe"));
    await poll();
    herdr.readPane = () => Promise.reject(new Error("read down"));
    advance(60_001);
    await poll();
    expect(agent("w1:p1").sessionName).toBe("safe"); // last-known kept
    expect(engine.current().bridge).toBe("connected"); // the poll itself still succeeded
  });

// ── Beacons ──────────────────────────────────────────────────────────────────────────────────
//
// An agent that named itself through its own hooks beats anything read off its screen. What is
// pinned here is the JOIN, not the beacon rules themselves (bridge/beacon/beacon.test.ts owns
// those): what a beacon may change on a view, what it may not, and that a beacon directory can
// never fail a poll.

describe("beacons", () => {
  const NOW = 1_700_000_000_000;

  /** A beacon directory backed by a plain object, with the clock pinned. */
  function beaconsOf(files: Record<string, unknown>, now = NOW): BeaconSweepDeps {
    return {
      directory: {
        list: () => Promise.resolve(Object.keys(files)),
        read: (name) => Promise.resolve(JSON.stringify(files[name])),
      },
      now: () => now,
    };
  }
  const record = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    harness: "claude",
    paneId: "w1:p1",
    session: { kind: "id", value: "sess-0001" },
    status: "working",
    heartbeatMs: NOW,
    ...over,
  });

  test("a live beacon supplies the session ref and lifts a waiting pane to the top of triage", async () => {
    const { herdr, poll, engine } = makeNameEngine(
      beaconsOf({ "w1~p1.json": record({ status: "waiting" }) }),
    );
    herdr.panes = [pane("w1:p2", "w1", "working", "claude"), pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    const agents = engine.current().agents;
    expect(agents[0]!.paneId).toBe("w1:p1"); // blocked ranks 0, so it sorts above the working pane
    expect(agents[0]!.status).toBe("blocked");
    expect(agents[0]!.agentSession).toEqual({ kind: "id", value: "sess-0001" });
  });

  test("an expired beacon still opens history, but never pins a status", async () => {
    const thirteenHoursAgo = NOW - 13 * 60 * 60 * 1000;
    const { herdr, poll, agent } = makeNameEngine(
      beaconsOf({ "w1~p1.json": record({ heartbeatMs: thirteenHoursAgo, status: "waiting" }) }),
    );
    herdr.panes = [pane("w1:p1", "w1", "working", "claude")];
    await poll();
    expect(agent("w1:p1").agentSession).toEqual({ kind: "id", value: "sess-0001" });
    expect(agent("w1:p1").status).toBe("working"); // the poll's own reading, not the beacon's
  });

  test("a beacon for a pane that is not here changes nothing", async () => {
    const { herdr, poll, agent } = makeNameEngine(
      beaconsOf({ "w9~p9.json": record({ paneId: "w9:p9" }) }),
    );
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(agent("w1:p1").agentSession).toBeUndefined();
    expect(agent("w1:p1").status).toBe("idle");
  });

  // The rule that matters most: beacons are an improvement on guessing, and an improvement that can
  // take the herd view down is not one.
  test("a sweep that blows up does not fail the poll", async () => {
    const { herdr, poll, engine, agent } = makeNameEngine({
      directory: {
        list: () => Promise.reject(new Error("beacon dir on fire")),
        read: () => Promise.reject(new Error("nope")),
      },
    });
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(engine.current().bridge).toBe("connected");
    expect(agent("w1:p1").status).toBe("idle");
  });

  test("a beacon-supplied name is used, and the pane is never grid-read for one", async () => {
    const { herdr, poll, agent } = makeNameEngine(
      beaconsOf({ "w1~p1.json": record({ sessionName: "my-feature" }) }),
    );
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", ["──────── scraped-name ──", "❯ "].join("\n"));
    await poll();
    expect(agent("w1:p1").sessionName).toBe("my-feature");
    expect(herdr.reads).toEqual([]);
  });

  test("a beacon with no name leaves the grid read exactly as it was", async () => {
    const { herdr, poll, agent } = makeNameEngine(beaconsOf({ "w1~p1.json": record() }));
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.texts.set("w1:p1", ["──────── scraped-name ──", "❯ "].join("\n"));
    await poll();
    expect(agent("w1:p1").sessionName).toBe("scraped-name");
    expect(herdr.reads.length).toBe(1);
  });

  test("with no beacons at all, a pane is exactly what the poll made it", async () => {
    const { herdr, poll, agent } = makeNameEngine(null);
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(agent("w1:p1").agentSession).toBeUndefined();
    expect("sessionName" in agent("w1:p1")).toBe(false);
  });
});
});

describe("StateEngine — poke / cadence / onUpdate", () => {
  test("onUpdate fires with the fresh snapshot after a successful poll, but not after a failed one", async () => {
    const { herdr, engine, poll } = makeEngine();
    const updates: EngineSnapshot[] = [];
    engine.onUpdate((s) => updates.push(s));
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(updates.length).toBe(1);
    expect(updates[0]!.agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    herdr.sessionSnapshot = () => Promise.reject(new Error("down"));
    await poll();
    expect(updates.length).toBe(1); // failed poll does not notify
  });

  // A snapshot call gated on a manual release, so a poke can land while a poll is in flight.
  class GatedSnapshot {
    calls = 0;
    private open: () => void = () => {};
    private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
    release() {
      this.open();
    }
    async sessionSnapshot() {
      this.calls++;
      await this.gate;
      return { version: "0.7.2", protocol: 16, workspaces: [ws("w1", 1)], tabs: [], panes: [] as FakePane[] };
    }
  }

  test("pokeNow queues exactly one follow-up poll when one is already in flight", async () => {
    const herdr = new GatedSnapshot();
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    // Mark started without the interval firing: drive polls by hand.
    (engine as unknown as { started: boolean }).started = true;
    const poll = () => (engine as unknown as { poll(): Promise<void> }).poll();

    const first = poll(); // calls=1, hangs on the gate
    engine.pokeNow(); // in-flight → queue one follow-up
    engine.pokeNow(); // coalesced into the same single follow-up
    herdr.release();
    await first;
    await Promise.resolve(); // let the drained follow-up poll settle
    await Promise.resolve();
    expect(herdr.calls).toBe(2); // initial + one follow-up, not three
    (engine as unknown as { started: boolean }).started = false;
  });

  test("pokeNow is a no-op once stopped", async () => {
    const herdr = new GatedSnapshot();
    const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
    engine.pokeNow(); // never started → no-op
    expect(herdr.calls).toBe(0);
  });

  test("setCadence re-arms the interval only when started and changed", () => {
    const { engine } = makeEngine();
    const cadence = () => (engine as unknown as { cadenceMs: number }).cadenceMs;
    const timer = () => (engine as unknown as { timer: unknown }).timer;

    engine.setCadence(9000); // not started → no-op
    expect(cadence()).toBe(1500);

    engine.start();
    expect(cadence()).toBe(1500);
    const before = timer();
    engine.setCadence(1500); // unchanged → no re-arm
    expect(timer()).toBe(before);
    engine.setCadence(12_000); // changed → re-arm
    expect(cadence()).toBe(12_000);
    expect(timer()).not.toBe(before);
    engine.stop();
  });

  test("engineCadence is fast when events are down or any pane is working/blocked", () => {
    expect(engineCadence(false, [], 1500, 12_000)).toBe(1500);
    expect(engineCadence(true, [{ status: "idle" }], 1500, 12_000)).toBe(12_000);
    expect(engineCadence(true, [{ status: "working" }], 1500, 12_000)).toBe(1500);
    expect(engineCadence(true, [{ status: "blocked" }], 1500, 12_000)).toBe(1500);
    expect(engineCadence(true, [{ status: "idle" }, { status: "working" }], 1500, 12_000)).toBe(1500);
    expect(engineCadence(true, [{ status: "done" }], 1500, 12_000)).toBe(12_000);
  });
});

// The two capability fields the pane detail view gates on. Both come straight off Herdr's pane
// record, and both must stay ABSENT rather than defaulting when the server doesn't report them —
// an older Herdr should read as "unknown", not as "zero scrollback" or "no transcript".
describe("StateEngine — pane capability fields", () => {
  test("keeps an id-kind agent session (claude)", async () => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "claude");
    p.agent_session = { source: "herdr:claude", agent: "claude", kind: "id", value: "abc-123" };
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.agentSession).toEqual({ kind: "id", value: "abc-123" });
  });

  // The regression that kept pi journal-less: pi's herdr integration reports `agent_session_path`
  // in preference to an id, and this mapper used to keep ONLY kind "id" — so a pi pane arrived with
  // no session at all and its history could never be offered. Which kinds are meaningful is the
  // journal adapter's call now, not this function's.
  test("keeps a path-kind agent session (pi)", async () => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "pi");
    p.agent_session = {
      source: "herdr:pi",
      agent: "pi",
      kind: "path",
      value: "/home/you/.pi/agent/sessions/--repo--/2026-07-29T10-00-00-000Z_abc.jsonl",
    };
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.agentSession).toEqual({
      kind: "path",
      value: "/home/you/.pi/agent/sessions/--repo--/2026-07-29T10-00-00-000Z_abc.jsonl",
    });
  });

  // Live-observed on a demo pane: Herdr keeps reporting the LAST session announced for a pane, so
  // relaunching it as a different harness leaves the previous agent's ref behind — a pane running
  // `pi` still advertised a `herdr:claude` id. Routing by pane agent would then hand pi's adapter a
  // Claude uuid.
  test("drops a session ref left behind by a different harness", async () => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "pi");
    p.agent_session = { source: "herdr:claude", agent: "claude", kind: "id", value: "abc-123" };
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.agentSession).toBeUndefined();
  });

  test("keeps a ref from an older Herdr that reports no owning agent", async () => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "claude");
    p.agent_session = { kind: "id", value: "abc-123" };
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.agentSession).toEqual({ kind: "id", value: "abc-123" });
  });

  test.each([
    ["an unrecognised session kind", { kind: "name", value: "my-session" }],
    ["a session with no value", { kind: "id" }],
    ["a session with an empty value", { kind: "id", value: "" }],
    ["no agent_session at all", undefined],
  ])("omits the session for %s", async (_label, session) => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "claude");
    if (session) p.agent_session = session;
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.agentSession).toBeUndefined();
  });

  test("readableLines is scrollback depth PLUS the viewport (what a recent read can return)", async () => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "claude");
    p.scroll = { offset_from_bottom: 0, max_offset_from_bottom: 6895, viewport_rows: 51 };
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.readableLines).toBe(6946);
  });

  test("an alt-screen pane reports just its viewport — the case that has no scrollback at all", async () => {
    const { herdr, engine, poll } = makeEngine();
    const p = pane("w1:p1", "w1", "idle", "claude");
    p.scroll = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 51 };
    herdr.panes = [p];
    await poll();
    expect(engine.current().agents[0]!.readableLines).toBe(51);
  });

  test("omits readableLines when the server doesn't report scroll (older Herdr)", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(engine.current().agents[0]!.readableLines).toBeUndefined();
  });
});

describe("overlayFromAgent — live name and summary from snapshot agents[]", () => {
  test("is empty when Herdr sent no agent record for the pane", () => {
    expect(overlayFromAgent(undefined)).toEqual({});
  });

  test("takes a live agent name and drops blanks", () => {
    expect(overlayFromAgent({ pane_id: "w1:p2", name: "planner-7dba2785" })).toEqual({
      agentName: "planner-7dba2785",
    });
    expect(overlayFromAgent({ pane_id: "w1:p2", name: "  " })).toEqual({});
    expect(overlayFromAgent({ pane_id: "w1:p2", name: null })).toEqual({});
  });

  test("prefers tokens.summary over metadata title", () => {
    expect(
      overlayFromAgent({
        pane_id: "w1:p3",
        title: "old title",
        tokens: { summary: "indexing auth" },
      }),
    ).toEqual({ summary: "indexing auth" });
    expect(overlayFromAgent({ pane_id: "w1:p3", title: "refactor auth" })).toEqual({
      summary: "refactor auth",
    });
  });
});

describe("StateEngine — snapshot agents[] overlay", () => {
  test("joins the live name onto the matching pane and leaves others unnamed", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [
      pane("w1:p1", "w1", "idle", "pi"),
      pane("w1:p2", "w1", "idle", "claude"),
    ];
    herdr.agents = [{ pane_id: "w1:p1", name: "planner-7dba2785" }];
    await poll();
    const byId = Object.fromEntries(engine.current().agents.map((a) => [a.paneId, a]));
    expect(byId["w1:p1"]!.agentName).toBe("planner-7dba2785");
    expect(byId["w1:p2"]!.agentName).toBeUndefined();
    expect("agentName" in byId["w1:p2"]!).toBe(false);
  });

  test("joins a summary token when Herdr reports one", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "claude")];
    herdr.agents = [{ pane_id: "w1:p1", tokens: { summary: "building docs" } }];
    await poll();
    expect(engine.current().agents[0]!.summary).toBe("building docs");
  });

  test("omits overlay fields when snapshot agents[] is absent (older Herdr)", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    herdr.agents = [];
    await poll();
    const a = engine.current().agents[0]!;
    expect(a.agentName).toBeUndefined();
    expect(a.summary).toBeUndefined();
  });
});
