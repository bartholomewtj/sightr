import { describe, expect, it } from "vitest";

import type { PlanStep, Run, TurnItem } from "@shared/v2/contracts";

import { activeComposerTasks, composerTasksFrom, latestRunError, type TodoListItem } from "./ComposerStatus.logic";
import { contextWindowSnapshot, formatContextWindowCost, formatContextWindowTokens, manualCompactionCommand } from "./ContextWindowMeter.logic";

const base = { threadId: "t1", status: "completed", title: null, startedAt: null, completedAt: null, createdAt: 1, updatedAt: 1 } as const;

function run(id: string, ordinal: number, status: Run["status"]): Run {
  return { id, threadId: "t1", ordinal, status, startedAt: ordinal * 10, ...(status === "running" ? {} : { completedAt: ordinal * 10 + 5 }) };
}
function errorItem(id: string, runId: string | null, ordinal: number, message = "API Error: boom"): TurnItem {
  return { ...base, id, runId, ordinal, status: "failed", type: "error", failure: { class: "provider_error", message, code: null, retryable: null } };
}
function todo(id: string, runId: string | null, ordinal: number, steps: PlanStep[]): TodoListItem {
  return { ...base, id, runId, ordinal, type: "todo_list", planId: id, steps };
}
const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]));

describe("latestRunError", () => {
  it("is the newest error item of the latest run when that run failed", () => {
    const runs = byId([run("r1", 1, "failed"), run("r2", 2, "failed")]);
    const items = byId([errorItem("e1", "r1", 1), errorItem("e2", "r2", 5), errorItem("e3", "r2", 7)]);
    expect(latestRunError({ runs, items })?.id).toBe("e3");
  });

  it("is null when the latest run did not fail, or failed without an error item of its own", () => {
    const items = byId([errorItem("e1", "r1", 1)]);
    expect(latestRunError({ runs: byId([run("r1", 1, "failed"), run("r2", 2, "completed")]), items })).toBeNull();
    expect(latestRunError({ runs: byId([run("r1", 1, "failed"), run("r2", 2, "failed")]), items })).toBeNull();
    expect(latestRunError({ runs: byId([run("r1", 1, "running")]), items })).toBeNull();
    expect(latestRunError(null)).toBeNull();
  });
});

describe("tasks", () => {
  const steps: PlanStep[] = [
    { id: "a", text: "Read the code", status: "completed", durationMs: 1200 },
    { id: "b", text: "Write the fix", status: "running" },
    { id: "c", text: "Run the tests", status: "pending" },
  ];

  it("maps steps to T3's task rows and names the running step", () => {
    const tasks = composerTasksFrom(todo("l1", "r1", 1, steps));
    expect(tasks.progress).toEqual({ step: "Write the fix", completedSteps: 1, totalSteps: 3 });
    expect(tasks.steps.map((s) => s.status)).toEqual(["completed", "inProgress", "pending"]);
    expect(tasks.steps[0]!.durationMs).toBe(1200);
  });

  it("falls back to the next pending step, then the last one", () => {
    const pending = composerTasksFrom(todo("l1", null, 1, [{ id: "a", text: "One", status: "completed" }, { id: "b", text: "Two", status: "pending" }]));
    expect(pending.progress.step).toBe("Two");
    const done = composerTasksFrom(todo("l1", null, 1, [{ id: "a", text: "One", status: "completed" }]));
    expect(done.progress.step).toBe("One");
  });

  it("shows the newest list; a finished one only while its run is still going", () => {
    const older = todo("l1", "r1", 1, [{ id: "x", text: "Old", status: "pending" }]);
    const newest = todo("l2", "r2", 4, steps);
    expect(activeComposerTasks({ runs: byId([run("r1", 1, "completed"), run("r2", 2, "running")]), items: byId([older, newest]) })?.itemId).toBe("l2");

    const finished = todo("l3", "r2", 6, steps.map((s) => ({ ...s, status: "completed" as const })));
    expect(activeComposerTasks({ runs: byId([run("r2", 2, "running")]), items: byId([finished]) })?.progress.completedSteps).toBe(3);
    expect(activeComposerTasks({ runs: byId([run("r2", 2, "completed")]), items: byId([finished]) })).toBeNull();
    // Unfinished after its run ended: the agent left work open, the badge stays.
    expect(activeComposerTasks({ runs: byId([run("r2", 2, "completed")]), items: byId([newest]) })?.itemId).toBe("l2");
    expect(activeComposerTasks({ runs: {}, items: {} })).toBeNull();
  });
});

describe("ContextWindowMeter.logic", () => {
  it("derives the snapshot from Thread.contextUsage, with or without a window", () => {
    expect(contextWindowSnapshot(undefined)).toBeNull();
    const known = contextWindowSnapshot({ usedTokens: 50_000, maxTokens: 200_000, cost: { amount: 0.5, currency: "USD" } })!;
    expect(known).toMatchObject({ usedTokens: 50_000, maxTokens: 200_000, usedPercentage: 25, remainingTokens: 150_000, remainingPercentage: 75 });
    expect(known.cost).toEqual({ amount: 0.5, currency: "USD" });
    const unknown = contextWindowSnapshot({ usedTokens: 12_345 })!;
    expect(unknown).toMatchObject({ maxTokens: null, usedPercentage: null, remainingTokens: null });
    expect(contextWindowSnapshot({ usedTokens: 300_000, maxTokens: 200_000 })!.usedPercentage).toBe(100);
  });

  it("formats tokens and cost as T3 does", () => {
    expect([formatContextWindowTokens(999), formatContextWindowTokens(4_100), formatContextWindowTokens(41_000), formatContextWindowTokens(1_200_000)]).toEqual([
      "999",
      "4.1k",
      "41k",
      "1.2m",
    ]);
    expect(formatContextWindowCost({ amount: 0.004, currency: "USD" })).toBe("USD 0.0040");
    expect(formatContextWindowCost({ amount: 1.5, currency: "USD" })).toBe("USD 1.50");
  });

  it("offers Compact only when the slash catalog has /compact", () => {
    expect(manualCompactionCommand([{ command: "/clear" }, { command: "/compact" }])).toBe("/compact");
    expect(manualCompactionCommand([{ command: "/clear" }])).toBeNull();
  });
});
