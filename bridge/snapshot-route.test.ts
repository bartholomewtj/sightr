import { describe, expect, test } from "bun:test";

import type { Config } from "./config.ts";
import { TranscriptStore } from "./journal/store.ts";
import type { JournalAdapter, TranscriptEntry, TranscriptSource } from "./journal/types.ts";
import { snapshotRoute, snapshotWantsTraces, type SnapshotDeps } from "./snapshot-route.ts";
import type { AgentView } from "./state-engine.ts";
import type { SnapshotResponse } from "./snapshot-route.ts";

const REF = { kind: "id", value: "s1" } as const;

const workingClaude: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "w1",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "working",
  cwd: "/x",
  focused: false,
  kind: "agent",
  agentSession: REF,
};

function cfg(): Config {
  return {
    socketPath: "/tmp/herdr.sock",
    port: 8787,
    host: "127.0.0.1",
    allowNonLoopbackBind: false,
    pollMs: 1500,
    pollIdleMs: 12_000,
    notifyDelayMs: 30_000,
    readLines: 200,
    transcript: true,
    journalRoots: {
      claude: ["/tmp/claude-projects"],
      pi: ["/nope/pi"],
      grok: ["/nope/grok"],
    },
    submitKeys: ["Enter"],
    commandsFile: "/nope/commands.toml",
    keysFile: "/nope/keys.toml",
    trustedUser: "",
    trustedUserOptional: false,

    deviceHeader: "",
    deviceAllowlist: [],
    allowedOrigins: [],
    publicHosts: [],
    pushAllowedHosts: [],
    tailscaleHosts: [],
    allowAnyHost: true,
    vapidPublic: "",
    vapidPrivate: "",
    vapidSubject: "mailto:admin@example.com",
    stateDir: "/tmp/state",
    skipServe: false,
    beacons: false,
    workRoot: "",
    audit: false,
    auditContent: "preview",
  };
}

function pendingToolParse(): TranscriptEntry[] {
  return [
    {
      uuid: "u1",
      ts: "",
      role: "assistant",
      parts: [{ kind: "tool", name: "Bash", summary: "npm test" }],
    },
  ];
}

function fakeAdapter() {
  let text = "u1";
  let mtimeMs = 1000;
  const calls = { resolve: 0, stat: 0, load: 0, parse: 0 };
  const source: TranscriptSource = {
    async resolve(ref) {
      calls.resolve++;
      return ref.kind === "id" && ref.value !== "unknown" ? `/fake/${ref.value}.jsonl` : null;
    },
    async stat() {
      calls.stat++;
      return { size: text.length, mtimeMs };
    },
    async load() {
      calls.load++;
      return { text, complete: true, size: text.length, mtimeMs };
    },
  };
  const adapter: JournalAdapter = {
    agent: "claude",
    source,
    parse: () => {
      calls.parse++;
      return pendingToolParse();
    },
  };
  return { adapter, calls };
}

function hangingAdapter(): JournalAdapter {
  const never = <T>(): Promise<T> => new Promise(() => {});
  return {
    agent: "claude",
    source: {
      resolve: never,
      stat: never,
      load: never,
    },
    parse: () => [],
  };
}

function depsFor(
  agents: AgentView[],
  transcripts: TranscriptStore | null,
  journals: Record<string, JournalAdapter> | null,
): SnapshotDeps {
  return {
    cfg: cfg(),
    engine: {
      current: () => ({
        agents,
        shellPanes: [],
        workspaces: [],
        tabs: [],
        bridge: "connected" as const,
      }),
    },
    activity: { get: () => undefined },
    sssfViz: {
      decoratePanes: <T>(panes: T[]) => panes,
      decorate: <T>(workspaces: T[]) => workspaces,
    },
    worktrees: {
      decorate: async <T>(workspaces: T[]) => workspaces,
      invalidate: () => undefined,
    },
    workdir: { enabled: false },
    journals,
    transcripts,
    offerHistory: () => false,
  } as unknown as SnapshotDeps;
}

function snapshotReq(): Request {
  return new Request("http://127.0.0.1/api/snapshot", { headers: { host: "127.0.0.1" } });
}

describe("snapshotRoute — runningCommand stays off the poll", () => {
  test("returns without touching the filesystem when the cache is warm", async () => {
    const { adapter, calls } = fakeAdapter();
    const store = new TranscriptStore();
    await store.runningCommand(adapter, REF);
    const before = { ...calls };

    const res = await snapshotRoute(
      snapshotReq(),
      depsFor([workingClaude], store, { claude: adapter }),
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as SnapshotResponse;
    expect(body.agents[0]!.runningCommand).toBe(true);
    expect(calls.resolve).toBe(before.resolve);
    expect(calls.stat).toBe(before.stat);
    expect(calls.load).toBe(before.load);
    expect(calls.parse).toBe(before.parse);
  });

  test("a hung journal read cannot stall the snapshot handler", async () => {
    const adapter = hangingAdapter();
    const store = new TranscriptStore();
    const res = await snapshotRoute(
      snapshotReq(),
      depsFor([workingClaude], store, { claude: adapter }),
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as SnapshotResponse;
    expect(body.agents[0]!.runningCommand).toBeUndefined();
  });

  test("first snapshot after boot omits the chip and schedules a refresh", async () => {
    const { adapter, calls } = fakeAdapter();
    const store = new TranscriptStore();
    const res = await snapshotRoute(
      snapshotReq(),
      depsFor([workingClaude], store, { claude: adapter }),
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as SnapshotResponse;
    expect(body.agents[0]!.runningCommand).toBeUndefined();
    await store.flushRunningCommandRefresh(adapter, REF);
    expect(calls.load).toBe(1);
    expect(store.peekRunningCommand(adapter, REF)).toBe(true);
  });
});

// Folded from snapshot-wants-traces.test.ts.
describe('snapshotWantsTraces', () => {
  describe("snapshotWantsTraces", () => {
    test("true only when the poll carries traces=1", () => {
      expect(snapshotWantsTraces(new Request("http://127.0.0.1/api/snapshot"))).toBe(false);
      expect(snapshotWantsTraces(new Request("http://127.0.0.1/api/snapshot?session=lab"))).toBe(false);
      expect(snapshotWantsTraces(new Request("http://127.0.0.1/api/snapshot?traces=1"))).toBe(true);
      expect(snapshotWantsTraces(new Request("http://127.0.0.1/api/snapshot?session=lab&traces=1"))).toBe(
        true,
      );
    });
  });
});
