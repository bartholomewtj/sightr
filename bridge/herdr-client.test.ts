import { describe, expect, test } from "bun:test";

import { HerdrClient, herdrErrorCode, type PaneRead } from "./herdr-client.ts";

/** A client whose wire is a list of pending calls the test settles by hand. */
function stubbed() {
  const client = new HerdrClient("unused");
  const calls: Array<{ method: string; params: Record<string, unknown>; settle: (value: unknown) => void }> = [];
  (client as unknown as { request: (method: string, params: Record<string, unknown>) => Promise<unknown> }).request = (method, params) =>
    new Promise((resolve) => calls.push({ method, params, settle: resolve }));
  const reads = () => calls.filter((c) => c.method === "pane.read");
  const answer = (i: number, text: string) => reads()[i]!.settle({ read: { pane_id: "w1:p1", text, truncated: false, revision: 0 } satisfies PaneRead });
  return { client, calls, reads, answer };
}

describe("HerdrClient pane reads", () => {
  test("the same read in flight is shared, a different shape is not", async () => {
    const { client, reads, answer } = stubbed();
    const a = client.readPane("w1:p1", "recent", 200, "ansi");
    const b = client.readPane("w1:p1", "recent", 200, "ansi");
    client.readPane("w1:p1", "visible", 40, "text");
    expect(reads().length).toBe(2);
    answer(0, "screen");
    expect((await a).text).toBe("screen");
    expect((await b).text).toBe("screen");
  });

  test("nothing is kept once a read settles", async () => {
    const { client, reads, answer } = stubbed();
    const first = client.readPane("w1:p1", "recent", 200, "ansi");
    answer(0, "old");
    await first;
    client.readPane("w1:p1", "recent", 200, "ansi");
    expect(reads().length).toBe(2);
  });

  test("a read after a keystroke never joins one from before it", async () => {
    const { client, calls, reads, answer } = stubbed();
    const before = client.readPane("w1:p1", "recent", 200, "ansi");
    const keys = client.sendPaneKeys("w1:p1", ["a"]);
    const during = client.readPane("w1:p1", "recent", 200, "ansi");
    calls.find((c) => c.method === "pane.send_keys")!.settle(undefined);
    await keys;
    const after = client.readPane("w1:p1", "recent", 200, "ansi");
    expect(reads().length).toBe(3);
    answer(0, "before a");
    answer(1, "during");
    answer(2, "after a");
    expect((await before).text).toBe("before a");
    expect((await during).text).toBe("during");
    expect((await after).text).toBe("after a");
  });

  test("a write to another pane leaves this pane's read shared", () => {
    const { client, reads } = stubbed();
    client.readPane("w1:p1", "recent", 200, "ansi");
    void client.sendPaneText("w1:p2", "hi");
    client.readPane("w1:p1", "recent", 200, "ansi");
    expect(reads().length).toBe(1);
  });
});

/** A client whose wire answers each method from a table (a function may throw herdr's error shape). */
function scripted(answers: Record<string, (params: Record<string, unknown>, n: number) => unknown>) {
  const client = new HerdrClient("unused");
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const counts = new Map<string, number>();
  (client as unknown as { request: (method: string, params: Record<string, unknown>) => Promise<unknown> }).request = async (method, params) => {
    calls.push({ method, params });
    const n = (counts.get(method) ?? 0) + 1;
    counts.set(method, n);
    const answer = answers[method];
    if (!answer) throw new Error(`herdr ${method}: unexpected`);
    return answer(params, n);
  };
  return { client, calls };
}

const wirePane = (paneId: string) => ({
  pane_id: paneId,
  terminal_id: `term-${paneId}`,
  workspace_id: "w1",
  tab_id: "w1:t1",
  focused: false,
  cwd: "C:\\code",
  agent_status: "unknown",
  revision: 0,
});

const agentInfo = (over: Record<string, unknown> = {}) => ({
  terminal_id: "term-w1:p2",
  pane_id: "w1:p2",
  name: "claude-1",
  agent: "claude",
  agent_status: "unknown",
  launch_pending: true,
  ...over,
});

describe("HerdrClient spawn methods", () => {
  test("splitPane sends direction, target and focus:false, and reads the pane reply", async () => {
    const { client, calls } = scripted({ "pane.split": () => ({ type: "pane_info", pane: wirePane("w1:p2") }) });
    const created = await client.splitPane({ targetPaneId: "w1:p1", direction: "down" });
    expect(calls).toEqual([{ method: "pane.split", params: { direction: "down", focus: false, target_pane_id: "w1:p1" } }]);
    expect(created).toEqual({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1", cwd: "C:\\code", terminalId: "term-w1:p2" });
  });

  test("splitPane also takes a root_pane reply", async () => {
    const { client } = scripted({ "pane.split": () => ({ root_pane: wirePane("w1:p3") }) });
    expect((await client.splitPane({ workspaceId: "w1", direction: "right" })).paneId).toBe("w1:p3");
  });

  test("createTab and createWorkspace carry the new terminal id", async () => {
    const { client } = scripted({
      "tab.create": () => ({ root_pane: wirePane("w1:p4") }),
      "workspace.create": () => ({ workspace: { label: "fresh", number: 4 }, root_pane: wirePane("w9:p1") }),
    });
    expect((await client.createTab("w1")).terminalId).toBe("term-w1:p4");
    expect(await client.createWorkspace({ cwd: "C:\\x" })).toMatchObject({ terminalId: "term-w9:p1", workspaceLabel: "fresh", workspaceNumber: 4 });
  });

  test("startAgent sends name, kind, pane, args and the timeout, then waits until ready", async () => {
    const { client, calls } = scripted({
      "agent.start": () => ({ type: "agent_started", agent: agentInfo(), argv: ["claude", "--model", "haiku"] }),
      "agent.get": (_p, n) => ({ agent: n < 3 ? agentInfo() : agentInfo({ agent_status: "idle", launch_pending: false, interactive_ready: true }) }),
    });
    const started = await client.startAgent(
      { paneId: "w1:p2", name: "claude-1", kind: "claude", args: ["--model", "haiku"], timeoutMs: 45_000 },
      { sleep: async () => {} },
    );
    expect(calls[0]).toEqual({
      method: "agent.start",
      params: { name: "claude-1", kind: "claude", pane_id: "w1:p2", args: ["--model", "haiku"], timeout_ms: 45_000 },
    });
    expect(calls.filter((c) => c.method === "agent.get").map((c) => c.params)).toEqual([
      { target: "claude-1" },
      { target: "claude-1" },
      { target: "claude-1" },
    ]);
    expect(started).toEqual({ name: "claude-1", paneId: "w1:p2", terminalId: "term-w1:p2", agent: "claude", status: "idle" });
  });

  test("startAgent clamps timeout_ms into herdr's bounds", async () => {
    for (const [given, sent] of [[1000, 3001], [3000, 3001], [999_999, 300_000], [undefined, 30_000]] as const) {
      const { client, calls } = scripted({
        "agent.start": () => ({ agent: agentInfo() }),
        "agent.get": () => ({ agent: agentInfo({ agent_status: "idle", interactive_ready: true }) }),
      });
      await client.startAgent({ paneId: "w1:p2", name: "claude-1", kind: "claude", args: [], ...(given !== undefined ? { timeoutMs: given } : {}) });
      expect(calls[0]!.params.timeout_ms).toBe(sent);
    }
  });

  test("a start-up dialog (blocked) counts as started", async () => {
    const { client } = scripted({
      "agent.start": () => ({ agent: agentInfo() }),
      "agent.get": () => ({ agent: agentInfo({ agent_status: "blocked" }) }),
    });
    expect((await client.startAgent({ paneId: "w1:p2", name: "claude-1", kind: "claude", args: [] })).status).toBe("blocked");
  });

  test("an agent that exits before it is ready fails with agent_start_failed", async () => {
    const { client } = scripted({
      "agent.start": () => ({ agent: agentInfo() }),
      "agent.get": () => ({ agent: agentInfo({ agent: null, agent_status: "idle", launch_pending: false }) }),
    });
    const err = await client.startAgent({ paneId: "w1:p2", name: "claude-1", kind: "claude", args: [] }).catch((e: Error) => e);
    expect(herdrErrorCode(err)).toBe("agent_start_failed");
  });

  test("the wait times out with herdr's timeout code", async () => {
    let clock = 0;
    const { client } = scripted({
      "agent.start": () => ({ agent: agentInfo() }),
      "agent.get": () => {
        throw new Error("herdr agent.get: agent_not_found: not yet");
      },
    });
    const err = await client
      .startAgent(
        { paneId: "w1:p2", name: "claude-1", kind: "claude", args: [], timeoutMs: 5_000 },
        { now: () => clock, sleep: async (ms) => void (clock += ms) },
      )
      .catch((e: Error) => e);
    expect(herdrErrorCode(err)).toBe("timeout");
  });

  test("a server refusal passes through with its code", async () => {
    const { client } = scripted({
      "agent.start": () => {
        throw new Error("herdr agent.start: agent_pane_busy: agent target pane w1:p2 is not an available shell");
      },
    });
    const err = await client.startAgent({ paneId: "w1:p2", name: "claude-1", kind: "claude", args: [] }).catch((e: Error) => e);
    expect(herdrErrorCode(err)).toBe("agent_pane_busy");
  });

  test("getPane reads the agent, and a missing pane is null", async () => {
    const { client } = scripted({
      "pane.get": (p) => {
        if (p.pane_id === "gone") throw new Error("herdr pane.get: pane_not_found: pane gone not found");
        return { pane: { ...wirePane("w1:p2"), agent: "pi" } };
      },
    });
    expect(await client.getPane("w1:p2")).toEqual({ paneId: "w1:p2", terminalId: "term-w1:p2", workspaceId: "w1", tabId: "w1:t1", agent: "pi" });
    expect(await client.getPane("gone")).toBeNull();
  });
});
