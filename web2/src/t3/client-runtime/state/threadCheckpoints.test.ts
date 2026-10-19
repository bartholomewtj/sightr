import type { Run, RunCheckpoint } from "@shared/v2/contracts";
import { describe, expect, it } from "vitest";

import { deriveRunCheckpointSummaries } from "./threadCheckpoints";

const cp = (runId: string, ordinal: number, over: Partial<RunCheckpoint> = {}): RunCheckpoint => ({
  runId,
  threadId: "t1",
  appRunOrdinal: ordinal,
  status: "ready",
  files: [{ path: "a.ts", kind: "modified", additions: 1, deletions: 0 }],
  additions: 1,
  deletions: 0,
  ...over,
});
const run = (id: string, ordinal: number, checkpoint?: RunCheckpoint): Run => ({
  id,
  threadId: "t1",
  ordinal,
  status: "completed",
  startedAt: 1,
  ...(checkpoint ? { checkpoint } : {}),
});

describe("deriveRunCheckpointSummaries", () => {
  it("is empty when no run has a checkpoint", () => {
    expect(deriveRunCheckpointSummaries([run("r1", 1), run("r2", 2)]).size).toBe(0);
    expect(deriveRunCheckpointSummaries({}).size).toBe(0);
  });

  it("gives one summary for one checkpoint and leaves the other runs out", () => {
    const map = deriveRunCheckpointSummaries([run("r1", 1), run("r2", 2, cp("r2", 2))]);
    expect([...map.keys()]).toEqual(["r2"]);
    const s = map.get("r2")!;
    expect(s).toMatchObject({ runId: "r2", ordinal: 2, status: "ready", live: true, additions: 1, deletions: 0 });
    expect(s.files).toEqual([{ path: "a.ts", kind: "modified", additions: 1, deletions: 0 }]);
  });

  it("orders several, given out of order, by Run.ordinal with the newest last", () => {
    const runs = [run("r3", 3, cp("r3", 3)), run("r1", 1, cp("r1", 1)), run("r2", 2, cp("r2", 2))];
    expect([...deriveRunCheckpointSummaries(runs).keys()]).toEqual(["r1", "r2", "r3"]);
    // A record (the thread store's shape) orders the same.
    const record = Object.fromEntries(runs.map((r) => [r.id, r]));
    expect([...deriveRunCheckpointSummaries(record).keys()]).toEqual(["r1", "r2", "r3"]);
  });

  it("follows a run from pending to ready and keeps the run's place", () => {
    const pending = run("r1", 1, cp("r1", 1, { status: "pending", files: [], additions: 0, deletions: 0 }));
    expect(deriveRunCheckpointSummaries([pending]).get("r1")).toMatchObject({ status: "pending", files: [] });
    const ready = run("r1", 1, cp("r1", 1, { capturedAt: 50 }));
    expect(deriveRunCheckpointSummaries([ready]).get("r1")).toMatchObject({ status: "ready", capturedAt: 50 });
  });

  it("reports absent with its reason, and expiry as live false while still ready", () => {
    const map = deriveRunCheckpointSummaries([
      run("r1", 1, cp("r1", 1, { status: "absent", reason: "no-repo", files: [] })),
      run("r2", 2, cp("r2", 2, { live: false })),
    ]);
    expect(map.get("r1")).toMatchObject({ status: "absent", reason: "no-repo" });
    expect(map.get("r2")).toMatchObject({ status: "ready", live: false });
  });

  it("drops a checkpoint for a run that is gone, and lets checkpointByRun win", () => {
    const byRun = new Map([
      ["gone", cp("gone", 9)],
      ["r1", cp("r1", 1, { additions: 7 })],
    ]);
    const map = deriveRunCheckpointSummaries([run("r1", 1, cp("r1", 1, { additions: 1 }))], byRun);
    expect([...map.keys()]).toEqual(["r1"]);
    expect(map.get("r1")!.additions).toBe(7);
  });
});
