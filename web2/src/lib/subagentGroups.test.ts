import type { TurnItem } from "@shared/v2/contracts";
import { describe, expect, it } from "vitest";

import {
  countSubagents,
  mergeSubagentItems,
  planSubagentGroups,
  sameSubagents,
  subagentCountLine,
  subagentPhase,
  type SubagentItem,
} from "./subagentGroups";

let n = 0;
function agent(fields: Partial<SubagentItem> & { subagentId: string }): SubagentItem {
  n += 1;
  return {
    id: `s:${n}`,
    type: "subagent",
    runId: "r1",
    status: "completed",
    createdAt: n,
    updatedAt: n,
    title: "",
    origin: "provider_native",
    driver: "pi",
    providerInstanceId: "pi",
    childThreadId: null,
    prompt: "",
    result: null,
    ...fields,
  } as unknown as SubagentItem;
}

const ID = "fd9eec52-cc41-447";

describe("mergeSubagentItems", () => {
  it("takes the brief and name from the launch and the state from the latest check", () => {
    const launch = agent({
      subagentId: ID,
      title: "Fix PR #1153",
      prompt: "Fix it.",
      agentStatus: "background",
      result: "Agent started in background.",
    });
    const check = agent({
      subagentId: ID,
      title: ID,
      status: "completed",
      agentStatus: "running",
      progress: "thinking… · Turns: 15",
      tokens: "121.5k",
      toolUses: 15,
    });
    const merged = mergeSubagentItems([launch, check]);
    expect(merged).toMatchObject({
      id: launch.id,
      title: "Fix PR #1153",
      prompt: "Fix it.",
      agentStatus: "running",
      progress: "thinking… · Turns: 15",
      tokens: "121.5k",
      toolUses: 15,
    });
    expect(merged.result).toBeNull(); // the launch's "started" text is not a report
    expect(subagentPhase(merged)).toBe("running");
  });

  it("takes the report once the agent finishes, and drops a stale progress line", () => {
    const launch = agent({ subagentId: ID, title: "Fix PR #1153", prompt: "Fix it.", agentStatus: "background" });
    const mid = agent({ subagentId: ID, agentStatus: "running", progress: "thinking…" });
    const done = agent({ subagentId: ID, agentStatus: "completed", result: "**CHANGES NEEDED**", durationMs: 807_000 });
    const merged = mergeSubagentItems([launch, mid, done]);
    expect(merged.result).toBe("**CHANGES NEEDED**");
    expect(merged.progress).toBeUndefined();
    expect(subagentPhase(merged)).toBe("done");
  });

  it("a lone item is returned as it is", () => {
    const only = agent({ subagentId: ID, title: "x" });
    expect(mergeSubagentItems([only])).toBe(only);
  });
});

describe("subagentPhase", () => {
  it("reads the harness's word over the call's status", () => {
    expect(subagentPhase(agent({ subagentId: ID, agentStatus: "async_launched" }))).toBe("running");
    expect(subagentPhase(agent({ subagentId: ID, status: "running" }))).toBe("running");
    expect(subagentPhase(agent({ subagentId: ID, agentStatus: "error", status: "failed" }))).toBe("failed");
    expect(subagentPhase(agent({ subagentId: ID, status: "interrupted" }))).toBe("stopped");
    expect(subagentPhase(agent({ subagentId: ID, agentStatus: "completed" }))).toBe("done");
  });
});

describe("planSubagentGroups", () => {
  const msg = { id: "m", type: "assistant_message" } as unknown as TurnItem;

  it("makes one card per run at its first agent and hides the rest of that run's items", () => {
    const a = agent({ subagentId: "aaaa", title: "A" });
    const b = agent({ subagentId: "bbbb", title: "B", agentStatus: "running" });
    const a2 = agent({ subagentId: "aaaa", title: "aaaa" });
    const plan = planSubagentGroups([a, msg, b, a2]);
    expect([...plan.anchors.keys()]).toEqual([a.id]);
    expect(plan.anchors.get(a.id)!.map((x) => x.subagentId)).toEqual(["aaaa", "bbbb"]);
    expect([...plan.hidden].sort()).toEqual([a2.id, b.id].sort());
    expect(plan.anchors.get(a.id)![0]!.title).toBe("A");
  });

  it("an agent checked in a later run gets a card there, named from its launch", () => {
    const launch = agent({ subagentId: ID, title: "Fix PR", prompt: "Fix it.", runId: "r1", agentStatus: "background" });
    const check = agent({ subagentId: ID, title: ID, runId: "r2", status: "running" });
    const plan = planSubagentGroups([launch, check]);
    expect(plan.anchors.size).toBe(2);
    expect(plan.anchors.get(check.id)![0]).toMatchObject({ title: "Fix PR", prompt: "Fix it." });
  });

  it("items with only a synthetic key are never merged with each other", () => {
    const x = agent({ subagentId: "call1:0", title: "X" });
    const y = agent({ subagentId: "call2:0", title: "Y" });
    expect(planSubagentGroups([x, y]).anchors.get(x.id)).toHaveLength(2);
  });

  it("no subagent items, no cards", () => {
    expect(planSubagentGroups([msg]).anchors.size).toBe(0);
  });
});

describe("counts", () => {
  it("lists the nonzero counts, running first", () => {
    const agents = [
      agent({ subagentId: "a", agentStatus: "running" }),
      agent({ subagentId: "b" }),
      agent({ subagentId: "c" }),
      agent({ subagentId: "d", status: "failed" }),
    ];
    expect(subagentCountLine(countSubagents(agents))).toBe("1 running · 2 done · 1 failed");
  });
});

describe("sameSubagents", () => {
  it("compares merged items by what the card shows", () => {
    const a = agent({ subagentId: "a", title: "A" });
    expect(sameSubagents([a], [{ ...a }])).toBe(true);
    expect(sameSubagents([a], [{ ...a, progress: "now" }])).toBe(false);
    expect(sameSubagents([a], [])).toBe(false);
  });
});
