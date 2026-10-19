import type { CheckpointFile, Run, RunCheckpoint } from "@shared/v2/contracts";
import { describe, expect, it } from "vitest";

import type { ChangedFileRow, RunChangedFiles } from "@/components/chat/ChangedFiles.logic";

import { checkpointSignature, FINISHING_GRACE_MS, fallbackReasonText, hasRunChanges, resolveRunChanges, samePath } from "./runChanges";

const row = (path: string, over: Partial<ChangedFileRow> = {}): ChangedFileRow => ({
  path,
  additions: 2,
  deletions: 1,
  countsKnown: true,
  edits: 1,
  itemIds: [`i:${path}`],
  created: false,
  failed: 0,
  running: false,
  truncated: false,
  ...over,
});
const journal = (rows: ChangedFileRow[]): RunChangedFiles => ({
  runId: "r1",
  rows,
  additions: rows.reduce((n, r) => n + r.additions, 0),
  deletions: rows.reduce((n, r) => n + r.deletions, 0),
  files: rows.filter((r) => r.edits > 0 || r.running).length,
  failedEdits: 0,
  shellRan: false,
  editedTwice: false,
});
const file = (path: string, over: Partial<CheckpointFile> = {}): CheckpointFile => ({ path, kind: "modified", additions: 5, deletions: 3, authored: true, ...over });
const cp = (over: Partial<RunCheckpoint> = {}): RunCheckpoint => ({
  runId: "r1",
  threadId: "t1",
  appRunOrdinal: 1,
  status: "ready",
  live: true,
  files: [file("src/a.ts")],
  additions: 5,
  deletions: 3,
  ...over,
});
const ended: Pick<Run, "status" | "completedAt"> = { status: "completed", completedAt: 1_000 };
const running: Pick<Run, "status" | "completedAt"> = { status: "running" };

describe("resolveRunChanges: the fallback matrix", () => {
  it("ready with files: the checkpoint's files and counts, Exact", () => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp(), journalFiles: journal([row("src/a.ts")]), now: 2_000 });
    expect(r).toMatchObject({ source: "checkpoint", state: "ready", additions: 5, deletions: 3, revertedCount: 0, truncated: false, live: true });
    expect(r.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(r.reason).toBeUndefined();
  });

  it("never sums the checkpoint with the journal", () => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp(), journalFiles: journal([row("src/a.ts", { additions: 40, deletions: 40 })]), now: 2_000 });
    expect([r.additions, r.deletions]).toEqual([5, 3]);
  });

  it("ready and empty: no net changes, with the count the journal listed", () => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp({ files: [], additions: 0, deletions: 0 }), journalFiles: journal([row("a.ts"), row("b.ts")]), now: 2_000 });
    expect(r).toMatchObject({ source: "checkpoint", state: "empty", files: [], journalCount: 2, revertedCount: 2 });
    expect(hasRunChanges(r)).toBe(true);
  });

  it("ready and empty with no journal items draws no card", () => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp({ files: [], additions: 0, deletions: 0 }), journalFiles: null, now: 2_000 });
    expect(r).toMatchObject({ source: "checkpoint", state: "empty", journalCount: 0 });
    expect(hasRunChanges(r)).toBe(false);
  });

  it("a journal path the checkpoint omits is reverted: named, not counted in the files", () => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp(), journalFiles: journal([row("src/a.ts"), row("src/undone.ts")]), now: 2_000 });
    expect(r.reverted).toEqual(["src/undone.ts"]);
    expect(r.revertedCount).toBe(1);
    expect(r.files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  it("an absolute journal path still matches the checkpoint's repo path", () => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp(), journalFiles: journal([row("/repo/src/a.ts")]), now: 2_000 });
    expect(samePath("/repo/src/a.ts", "src/a.ts")).toBe(true);
    expect(samePath("/repo/xsrc/a.ts", "src/a.ts")).toBe(false);
    expect(r.revertedCount).toBe(0);
  });

  it("names an absolute reverted path repo-relative, never absolute", () => {
    const j = journal([row("/repo/src/a.ts"), row("/repo/src/undone.ts"), row("C:/elsewhere/deep/x.ts")]);
    const r = resolveRunChanges({ run: ended, checkpoint: cp(), journalFiles: j, now: 2_000 });
    expect(r.reverted).toEqual(["src/undone.ts", "deep/x.ts"]);
    expect(r.reverted.some((p) => p.startsWith("/") || /^[A-Za-z]:/.test(p))).toBe(false);
    // With no edit matching a listed file there is no root to strip: the last two segments show.
    const lone = resolveRunChanges({ run: ended, checkpoint: cp({ files: [file("other.ts")] }), journalFiles: journal([row("/repo/src/undone.ts")]), now: 2_000 });
    expect(lone.reverted).toEqual(["src/undone.ts"]);
  });

  it("a failed-only journal path is not an undone edit", () => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp(), journalFiles: journal([row("src/a.ts"), row("src/never.ts", { edits: 0, failed: 1 })]), now: 2_000 });
    expect(r.revertedCount).toBe(0);
  });

  it("does not call a path reverted when the list was cut, a file was skipped, or the name is refused", () => {
    const j = journal([row("src/a.ts"), row("src/other.ts")]);
    expect(resolveRunChanges({ run: ended, checkpoint: cp({ truncated: true }), journalFiles: j, now: 2_000 }).revertedCount).toBe(0);
    expect(resolveRunChanges({ run: ended, checkpoint: cp({ skipped: 1 }), journalFiles: j, now: 2_000 }).revertedCount).toBe(0);
    expect(resolveRunChanges({ run: ended, checkpoint: cp(), journalFiles: journal([row("src/a.ts"), row(".env")]), now: 2_000 }).revertedCount).toBe(0);
  });

  it("a checkpoint path no edit tool reported carries the shell tag", () => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp({ files: [file("src/a.ts"), file("gen/out.ts", { authored: false, kind: "added" })] }), journalFiles: journal([row("src/a.ts")]), now: 2_000 });
    expect(r.files.map((f) => [f.path, f.shell === true, f.created])).toEqual([
      ["src/a.ts", false, false],
      ["gen/out.ts", true, true],
    ]);
  });

  it("live false keeps the list and the counts, and says the objects are gone", () => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp({ live: false }), journalFiles: null, now: 2_000 });
    expect(r).toMatchObject({ source: "checkpoint", state: "ready", live: false, additions: 5 });
    expect(r.files).toHaveLength(1);
  });

  it("truncated: the files given, the totals as the checkpoint summed them", () => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp({ truncated: true, additions: 900, deletions: 400 }), journalFiles: null, now: 2_000 });
    expect(r).toMatchObject({ source: "checkpoint", state: "ready", truncated: true, additions: 900, deletions: 400 });
  });

  it("files the snapshot could not show count as not shown, and keep a card with no listed file", () => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp({ files: [], additions: 0, deletions: 0, hidden: 2, skipped: 1 }), journalFiles: null, now: 2_000 });
    expect(r).toMatchObject({ state: "ready", notShown: 3 });
  });

  it("carries the shared, approximate and unsettled flags", () => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp({ shared: true, approximate: true, unsettled: true }), journalFiles: null, now: 2_000 });
    expect([r.shared, r.approximate, r.unsettled]).toEqual([true, true, true]);
  });

  it("running: the journal, whatever the checkpoint says", () => {
    const j = journal([row("src/a.ts")]);
    const pending = resolveRunChanges({ run: running, checkpoint: cp({ status: "pending", files: [] }), journalFiles: j, now: 5_000 });
    expect(pending).toMatchObject({ source: "journal", state: "running", additions: 2, deletions: 1 });
    expect(pending.reason).toBeUndefined();
    const off = resolveRunChanges({ run: running, checkpoint: cp({ status: "absent", reason: "disabled", files: [] }), journalFiles: j, now: 5_000 });
    expect(off).toMatchObject({ source: "journal", state: "running", reason: "disabled" });
  });

  it("an ended run with a pending checkpoint is finishing for 10 s, then the journal", () => {
    const j = journal([row("src/a.ts")]);
    const pending = cp({ status: "pending", files: [] });
    expect(resolveRunChanges({ run: ended, checkpoint: pending, journalFiles: j, now: 1_000 + FINISHING_GRACE_MS - 1 })).toMatchObject({ source: "journal", state: "finishing" });
    const late = resolveRunChanges({ run: ended, checkpoint: pending, journalFiles: j, now: 1_000 + FINISHING_GRACE_MS });
    expect(late).toMatchObject({ source: "journal", state: "fallback", reason: "finishing-timeout" });
  });

  it.each(["disabled", "no-repo", "start-missed", "end-missed", "too-large", "timeout", "git-failed", "sparse-checkout"] as const)("absent %s falls back to the journal with the reason", (reason) => {
    const r = resolveRunChanges({ run: ended, checkpoint: cp({ status: "absent", reason, files: [] }), journalFiles: journal([row("src/a.ts")]), now: 2_000 });
    expect(r).toMatchObject({ source: "journal", state: "fallback", reason });
    expect(fallbackReasonText(reason)).not.toMatch(/no snapshot for this run/);
  });

  it("an older run with no checkpoint field is the journal, as before", () => {
    const r = resolveRunChanges({ run: ended, journalFiles: journal([row("src/a.ts")]), now: 2_000 });
    expect(r).toMatchObject({ source: "journal", state: "fallback", reason: "no-checkpoint" });
    expect(r.files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  it("neither source: nothing to show", () => {
    expect(resolveRunChanges({ run: ended, journalFiles: null, now: 2_000 })).toMatchObject({ state: "none", files: [] });
    const absent = resolveRunChanges({ run: ended, checkpoint: cp({ status: "absent", reason: "no-repo", files: [] }), journalFiles: null, now: 2_000 });
    expect(absent.state).toBe("none");
    expect(hasRunChanges(absent)).toBe(false);
  });

  it("the sheet words every absent reason", () => {
    expect(fallbackReasonText("sparse-checkout")).toBe("A folder outside this repo's sparse checkout is on disk.");
    expect(fallbackReasonText("disabled")).toBe("Snapshots are off for this project.");
    expect(fallbackReasonText("no-repo")).toBe("This folder isn't a git repository.");
    expect(fallbackReasonText("start-missed")).toBe("Sightr wasn't watching when the run started.");
    expect(fallbackReasonText("too-large")).toBe("The folder is too large to snapshot.");
  });
});

describe("checkpointSignature", () => {
  it("changes with anything a surface draws and with nothing else", () => {
    const a = checkpointSignature(cp());
    expect(checkpointSignature(cp())).toBe(a);
    expect(checkpointSignature(cp({ live: false }))).not.toBe(a);
    expect(checkpointSignature(cp({ shared: true }))).not.toBe(a);
    expect(checkpointSignature(cp({ files: [file("src/a.ts", { additions: 6 })] }))).not.toBe(a);
    expect(checkpointSignature(undefined)).toBe("");
  });
});
