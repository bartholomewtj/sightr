import { beforeEach, describe, expect, it } from "vitest";

import type { TurnItem } from "@shared/v2/contracts";
import { assistant, command, reasoning, resetOrdinals, run, user } from "@/test/turn-items";

import { deriveTimelineEntries, reasoningLabel, reasoningTime } from "./session-logic";

beforeEach(() => resetOrdinals());

const inRun = { runId: "r1" };

describe("reasoningTime / reasoningLabel (T11)", () => {
  it("uses the item's own start and end when it has both", () => {
    const items = [reasoning("a:0", "hmm", { ...inRun, startedAt: 10_000, completedAt: 22_000 })];
    expect(reasoningTime(items, 0, null)).toBe(12_000);
    expect(reasoningLabel(12_000)).toBe("Thought for 12s");
  });

  it("falls back to the gap to the next item in the same run", () => {
    const items = [reasoning("a:0", "hmm", { ...inRun, createdAt: 0 }), command("b:0", "ls", { ...inRun, createdAt: 125_000 })];
    expect(reasoningTime(items, 0, null)).toBe(125_000);
    expect(reasoningLabel(125_000)).toBe("Thought for 2m 5s");
  });

  it("omits an idle gap over ten minutes, a user reply and a sibling part of the same entry", () => {
    const idle = [reasoning("a:0", "hmm", { ...inRun, createdAt: 0 }), assistant("b:0", "ok", { ...inRun, createdAt: 11 * 60_000 })];
    expect(reasoningTime(idle, 0, null)).toBeNull();
    expect(reasoningLabel(null)).toBe("Thought");
    const reply = [reasoning("a:0", "hmm", { ...inRun, createdAt: 0 }), user("b:0", "?", { ...inRun, createdAt: 5_000 })];
    expect(reasoningTime(reply, 0, null)).toBeNull();
    const sibling = [reasoning("a:0", "hmm", { ...inRun, createdAt: 0 }), assistant("a:1", "ok", { ...inRun, createdAt: 9_000 })];
    expect(reasoningTime(sibling, 0, null)).toBeNull();
  });

  it("is live while it is the last item of the running run", () => {
    const items = [user("u:0", "go", inRun), reasoning("a:0", "hmm", inRun)];
    expect(reasoningTime(items, 1, "r1")).toBe("live");
    expect(reasoningTime(items, 1, null)).toBeNull();
    expect(reasoningLabel("live")).toBe("Thinking…");
    const entries = deriveTimelineEntries({ items, runs: [run("r1", { status: "running", completedAt: undefined })] });
    const entry = entries[1];
    expect(entry?.kind === "work" && entry.entry.toolLifecycleStatus).toBe("inProgress");
  });

  it("says 'Thought briefly' under a second", () => {
    const items = [reasoning("a:0", "hmm", { ...inRun, createdAt: 0 }), command("b:0", "ls", { ...inRun, createdAt: 400 })];
    expect(reasoningLabel(reasoningTime(items, 0, null))).toBe("Thought briefly");
  });
});

describe("deriveTimelineEntries", () => {
  it("keys every entry by its item id, also two text parts of one journal entry", () => {
    const entries = deriveTimelineEntries({ items: [assistant("e:0", "one"), assistant("e:1", "two")], runs: [] });
    expect(entries.map((e) => e.id)).toEqual(["e:0", "e:1"]);
  });

  it("draws no row for a run's checkpoint item (T30; T31's card reads it), and the run's end still follows its last item", () => {
    const reply = assistant("e:0", "done", inRun);
    const files = [{ path: "a.txt", kind: "modified" as const, additions: 1, deletions: 0 }];
    const checkpoint: TurnItem = {
      id: "checkpoint:r1", threadId: reply.threadId, runId: "r1", ordinal: reply.ordinal + 1, status: "completed", title: "Snapshot: 1 file changed",
      startedAt: null, completedAt: null, createdAt: reply.createdAt, updatedAt: reply.updatedAt,
      type: "checkpoint", checkpointId: "r1", files,
      checkpoint: { runId: "r1", threadId: reply.threadId, appRunOrdinal: 1, status: "ready", files, additions: 1, deletions: 0 },
    };
    const entries = deriveTimelineEntries({ items: [reply, checkpoint], runs: [run("r1", { status: "failed" })] });
    expect(entries.map((e) => e.id)).not.toContain("checkpoint:r1");
    expect(entries.map((e) => e.id)[0]).toBe("e:0");
    expect(entries.length).toBe(2); // the reply, then the run's "failed" end row
  });

  it("maps T3 tool kinds onto work entries", () => {
    const entries = deriveTimelineEntries({ items: [command("a:0", "ls", { output: "x" })], runs: [] });
    expect(entries[0]).toMatchObject({ kind: "work", entry: { command: "ls", tone: "tool", itemType: "command_execution" } });
  });
  it("warns on a failed system notice, not on one that finished cleanly", () => {
    const notice = (id: string, status: "completed" | "failed") =>
      ({ id, threadId: "t1", runId: null, ordinal: 0, status, title: null, startedAt: null, completedAt: null, createdAt: 1, updatedAt: 1, type: "system_notice", message: "Background command completed (exit code 0)" }) as never;
    const [ok, bad] = deriveTimelineEntries({ items: [notice("n:0", "completed"), notice("n:1", "failed")], runs: [] });
    expect(ok).toMatchObject({ kind: "work", entry: { itemType: "system_notice" } });
    expect((ok as { entry: { sourceActivityKind?: string } }).entry.sourceActivityKind).toBeUndefined();
    expect((bad as { entry: { sourceActivityKind?: string } }).entry.sourceActivityKind).toBe("runtime.warning");
  });
});
