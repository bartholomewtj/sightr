import { beforeEach, describe, expect, it } from "vitest";

import type { TurnItem } from "@shared/v2/contracts";

import { deriveTimelineEntries } from "~/session-logic";
import { assistant, command, edit, resetOrdinals, run, user } from "@/test/turn-items";

import { changedFilesSignature, deriveRunChangedFiles, normalizeChangedPath } from "./ChangedFiles.logic";

beforeEach(() => resetOrdinals());

const R = { runId: "r1" };

function summaryOf(items: TurnItem[], runId = "r1") {
  return deriveRunChangedFiles(deriveTimelineEntries({ items, runs: [run("r1"), run("r2", { ordinal: 1 })] })).get(runId);
}

describe("deriveRunChangedFiles (T24)", () => {
  it("sums two completed edits of one path", () => {
    const summary = summaryOf([
      edit("a:0", "src/a.ts", { ...R, additions: 3, deletions: 1 }),
      edit("b:0", "src/a.ts", { ...R, additions: 2, deletions: 2 }),
    ])!;
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0]).toMatchObject({ path: "src/a.ts", additions: 5, deletions: 3, countsKnown: true, edits: 2, itemIds: ["a:0", "b:0"] });
    expect(summary).toMatchObject({ additions: 5, deletions: 3, files: 1, failedEdits: 0, editedTwice: true, shellRan: false });
  });

  it("leaves a failed item out of the sums and lists it with its error", () => {
    const summary = summaryOf([
      edit("a:0", "src/a.ts", { ...R, additions: 4, deletions: 0 }),
      edit("b:0", "src/a.ts", { ...R, status: "failed", additions: 9, deletions: 9, errorText: "String to replace not found" }),
      edit("c:0", "src/only-failed.ts", { ...R, status: "failed", errorText: "no such file" }),
    ])!;
    const a = summary.rows.find((r) => r.path === "src/a.ts")!;
    expect(a).toMatchObject({ additions: 4, deletions: 0, edits: 1, failed: 1, errorText: "String to replace not found", itemIds: ["a:0", "b:0"] });
    const onlyFailed = summary.rows.find((r) => r.path === "src/only-failed.ts")!;
    expect(onlyFailed).toMatchObject({ edits: 0, failed: 1, countsKnown: false, errorText: "no such file" });
    expect(summary).toMatchObject({ additions: 4, deletions: 0, files: 1, failedEdits: 2 });
  });

  it("counts cancelled and interrupted edits as failed", () => {
    const summary = summaryOf([edit("a:0", "a.ts", { ...R, status: "cancelled" }), edit("b:0", "b.ts", { ...R, status: "interrupted" })])!;
    expect(summary.failedEdits).toBe(2);
    expect(summary.files).toBe(0);
    expect(summary.rows.map((r) => r.failed)).toEqual([1, 1]);
  });

  it("lists a running item with no counts until it completes", () => {
    const running = summaryOf([edit("a:0", "src/a.ts", { ...R, status: "running", additions: 7, deletions: 7 })])!;
    expect(running.rows[0]).toMatchObject({ running: true, countsKnown: false, additions: 0, deletions: 0, edits: 0 });
    expect(running.files).toBe(1);
    const pending = summaryOf([edit("a:0", "src/a.ts", { ...R, status: "pending" })])!;
    expect(pending.rows[0]).toMatchObject({ running: true });

    const done = summaryOf([edit("a:0", "src/a.ts", { ...R, additions: 7, deletions: 1 })])!;
    expect(done.rows[0]).toMatchObject({ running: false, countsKnown: true, additions: 7, deletions: 1 });
  });

  it("keeps the counts of the completed edits beside a running one", () => {
    const row = summaryOf([edit("a:0", "src/a.ts", { ...R, additions: 2, deletions: 0 }), edit("b:0", "src/a.ts", { ...R, status: "running" })])!.rows[0]!;
    expect(row).toMatchObject({ running: true, countsKnown: true, additions: 2, edits: 1 });
  });

  it("sets countsKnown false when a completed item has no counts", () => {
    const summary = summaryOf([
      edit("a:0", "src/a.ts", { ...R, additions: 2, deletions: 1 }),
      edit("b:0", "src/a.ts", { ...R, oldStr: "x", newStr: "y" }),
      edit("c:0", "src/b.ts", { ...R, oldStr: "x", newStr: "y" }),
    ])!;
    expect(summary.rows.map((r) => r.countsKnown)).toEqual([false, false]);
    expect(summary.rows[0]).toMatchObject({ additions: 2, deletions: 1, edits: 2 });
  });

  it("marks a file created when its diff starts --- /dev/null", () => {
    const summary = summaryOf([
      edit("a:0", "new.ts", { ...R, additions: 2, deletions: 0, diffStr: "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b" }),
      edit("b:0", "old.ts", { ...R, additions: 1, deletions: 1, diffStr: "--- a/old.ts\n+++ b/old.ts\n@@ @@\n-x\n+y" }),
    ])!;
    expect(summary.rows.map((r) => r.created)).toEqual([true, false]);
  });

  it("does not mark a failed Write as created", () => {
    const summary = summaryOf([edit("a:0", "new.ts", { ...R, status: "failed", diffStr: "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+a" })])!;
    expect(summary.rows[0]!.created).toBe(false);
  });

  it("carries truncated from any item", () => {
    const summary = summaryOf([
      edit("a:0", "a.ts", { ...R, additions: 1, deletions: 0 }),
      edit("b:0", "a.ts", { ...R, additions: 1, deletions: 0, truncated: true }),
      edit("c:0", "b.ts", { ...R, additions: 1, deletions: 0 }),
    ])!;
    expect(summary.rows.map((r) => r.truncated)).toEqual([true, false]);
  });

  it("normalises \\ and a leading ./ and keeps case and spelling distinct", () => {
    expect(normalizeChangedPath(".\\src\\a.ts")).toBe("src/a.ts");
    expect(normalizeChangedPath("./././x.ts")).toBe("x.ts");
    const summary = summaryOf([
      edit("a:0", "src\\a.ts", { ...R, additions: 1, deletions: 0 }),
      edit("b:0", "./src/a.ts", { ...R, additions: 1, deletions: 0 }),
      edit("c:0", "Src/A.ts", { ...R, additions: 1, deletions: 0 }),
      edit("d:0", "C:/p/src/a.ts", { ...R, additions: 1, deletions: 0 }),
    ])!;
    expect(summary.rows.map((r) => [r.path, r.edits])).toEqual([
      ["src/a.ts", 2],
      ["Src/A.ts", 1],
      ["C:/p/src/a.ts", 1],
    ]);
  });

  it("sets shellRan when the run ran a command, and editedTwice only for a file edited twice", () => {
    const quiet = summaryOf([edit("a:0", "a.ts", { ...R, additions: 1, deletions: 0 }), edit("b:0", "b.ts", { ...R, additions: 1, deletions: 0 })])!;
    expect(quiet).toMatchObject({ shellRan: false, editedTwice: false });
    const shell = summaryOf([command("c:0", "prettier -w .", R), edit("a:0", "a.ts", { ...R, additions: 1, deletions: 0 })])!;
    expect(shell).toMatchObject({ shellRan: true, editedTwice: false });
  });

  it("gives no entry to a run without a file_change, and keeps runs apart", () => {
    const entries = summaryOfAll([
      user("u:0", "go", R),
      command("c:0", "ls", R),
      assistant("m:0", "done", R),
      edit("a:0", "a.ts", { runId: "r2", additions: 1, deletions: 0 }),
      command("d:0", "ls", { runId: "r2" }),
    ]);
    expect([...entries.keys()]).toEqual(["r2"]);
    expect(entries.get("r2")).toMatchObject({ shellRan: true, files: 1 });
  });

  it("skips an item with no run or no path", () => {
    const entries = summaryOfAll([edit("a:0", "a.ts", { additions: 1, deletions: 0 }), edit("b:0", "  ", { ...R, additions: 1, deletions: 0 })]);
    expect(entries.size).toBe(0);
  });

  it("signs a summary by what the card draws", () => {
    const one = summaryOf([edit("a:0", "a.ts", { ...R, additions: 1, deletions: 0 })])!;
    const same = summaryOf([edit("a:0", "a.ts", { ...R, additions: 1, deletions: 0 }), assistant("m:0", "hi", R)])!;
    const more = summaryOf([edit("a:0", "a.ts", { ...R, additions: 2, deletions: 0 })])!;
    expect(changedFilesSignature(same)).toBe(changedFilesSignature(one));
    expect(changedFilesSignature(more)).not.toBe(changedFilesSignature(one));
  });
});

function summaryOfAll(items: TurnItem[]) {
  return deriveRunChangedFiles(deriveTimelineEntries({ items, runs: [run("r1"), run("r2", { ordinal: 1 })] }));
}
