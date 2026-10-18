import type { Run, TurnItem } from "@shared/v2/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { parsePatch } from "./parsePatch";
import { assistant, command, edit, resetOrdinals, run, user } from "@/test/turn-items";

import { combineEdits, editHunks, runOptionsFromState, runScopeFromItems } from "./runScope";

beforeEach(resetOrdinals);

const inRun = { runId: "r1" };
const items = (list: TurnItem[]) => Object.fromEntries(list.map((i) => [i.id, i]));
/** What the bridge's journal writes for an Edit: fragments, with a hunk header that has no numbers. */
const journal = (file: string, before: string, after: string) => `--- a/${file}\n+++ b/${file}\n@@ @@\n ctx\n-${before}\n+${after}\n ctx2`;

describe("editHunks", () => {
  it("gives the journal's unnumbered hunk a header with counts that parsePatch reads, and says it counts from the edit", () => {
    const rows = editHunks(journal("a.ts", "x", "y"), "edit 1 of 2");
    expect(rows[0]).toBe("@@ -1,3 +1,3 @@ edit 1 of 2");
    expect(rows.slice(1)).toEqual([" ctx", "-x", "+y", " ctx2"]);
    const file = parsePatch(["--- a/a.ts", "+++ b/a.ts", ...rows].join("\n"))[0]!;
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks[0]!.mismatch).toBeUndefined();
  });

  it("keeps a numbered header (a new file's) and splits several hunks of one edit", () => {
    expect(editHunks("--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b")).toEqual(["@@ -0,0 +1,2 @@", "+a", "+b"]);
    const two = editHunks("--- a/f\n+++ b/f\n@@ @@\n-a\n+b\n@@ @@\n+c");
    expect(two.filter((r) => r.startsWith("@@"))).toEqual(["@@ -1,1 +1,1 @@", "@@ -0,0 +1,1 @@"]);
  });

  it("makes a header for a diff that has none", () => {
    expect(editHunks("-a\n+b\n+c")).toEqual(["@@ -1,1 +1,2 @@", "-a", "+b", "+c"]);
  });

  it("drops only the file header above the first hunk: a removed `-- x` and an added `++ y` are body", () => {
    const rows = editHunks("--- a/f.sql\n+++ b/f.sql\n@@ @@\n ctx\n--- x\n+++ y\n ctx2");
    expect(rows).toEqual(["@@ -1,3 +1,3 @@", " ctx", "--- x", "+++ y", " ctx2"]);
    const file = parsePatch(["--- a/f.sql", "+++ b/f.sql", ...rows].join("\n"))[0]!;
    expect(file.hunks[0]!.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["context:ctx", "del:-- x", "add:++ y", "context:ctx2"]);
    expect(file.hunks[0]!.mismatch).toBeUndefined();
  });

  it("does not count `\\ No newline at end of file` as a context line", () => {
    const rows = editHunks("--- a/f\n+++ b/f\n@@ @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file");
    expect(rows[0]).toBe("@@ -1,1 +1,1 @@");
    const file = parsePatch(["--- a/f", "+++ b/f", ...rows].join("\n"))[0]!;
    expect(file.hunks[0]!.mismatch).toBeUndefined();
    expect(file.hunks[0]!.lines.map((l) => [l.kind, l.noEol])).toEqual([["del", true], ["add", true]]);
  });

  it("returns nothing for an empty diff", () => {
    expect(editHunks("")).toEqual([]);
    expect(editHunks("--- a/f\n+++ b/f")).toEqual([]);
  });
});

describe("combineEdits", () => {
  it("is one file with every edit's hunks in order, each numbered from its own first line", () => {
    const patch = combineEdits("src/a.ts", [journal("src/a.ts", "1", "2"), journal("src/a.ts", "3", "4")])!;
    const file = parsePatch(patch)[0]!;
    expect(parsePatch(patch)).toHaveLength(1);
    expect(file.path).toBe("src/a.ts");
    expect(file.hunks.map((h) => h.header)).toEqual(["@@ -1,3 +1,3 @@ edit 1 of 2", "@@ -1,3 +1,3 @@ edit 2 of 2"]);
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(2);
  });

  it("starts from /dev/null when the first edit created the file", () => {
    const patch = combineEdits("n.ts", ["--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,1 @@\n+hi"])!;
    expect(parsePatch(patch)[0]!.status).toBe("added");
  });

  it("is null when no edit has a diff", () => {
    expect(combineEdits("a.ts", [])).toBeNull();
    expect(combineEdits("a.ts", [""])).toBeNull();
  });
});

describe("runScopeFromItems", () => {
  it("lists a run's files in the order the agent touched them, with counts, edits and one patch each", () => {
    const scope = runScopeFromItems(
      items([
        user("u:0", "go", inRun),
        edit("e:0", "src/a.ts", { ...inRun, additions: 1, deletions: 1, diffStr: journal("src/a.ts", "1", "2") }),
        edit("e:1", "src/b.ts", { ...inRun, additions: 3, deletions: 0, diffStr: "--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c" }),
        edit("e:2", "src/a.ts", { ...inRun, additions: 1, deletions: 1, diffStr: journal("src/a.ts", "3", "4") }),
        command("c:0", "ls", inRun),
        assistant("m:0", "done", inRun),
      ]),
      "r1",
    );
    expect(scope.found).toBe(true);
    expect(scope.shellRan).toBe(true);
    expect(scope.files.map((f) => f.entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
    const a = scope.files[0]!;
    expect(a.entry).toMatchObject({ kind: "modified", added: 2, removed: 2, countsKnown: true, edits: 2 });
    expect(a.state.state).toBe("ready");
    expect(parsePatch(a.patch!)[0]!.hunks).toHaveLength(2);
    expect(scope.files[1]!.entry).toMatchObject({ kind: "added", edits: 1 });
  });

  it("only reads the asked run, and says nothing was found for another", () => {
    const list = items([edit("e:0", "a.ts", { runId: "r2", additions: 1, deletions: 0, diffStr: journal("a.ts", "1", "2") })]);
    expect(runScopeFromItems(list, "r1").found).toBe(false);
    expect(runScopeFromItems(list, "r2").found).toBe(true);
    expect(runScopeFromItems(undefined, "r1")).toEqual({ found: false, files: [], shellRan: false });
  });

  it("says so for a cut diff, an edit with no diff, and a failed edit; never claims exactness", () => {
    const scope = runScopeFromItems(
      items([
        edit("e:0", "cut.ts", { ...inRun, additions: 9, deletions: 0, diffStr: journal("cut.ts", "1", "2"), truncated: true } as never),
        edit("e:1", "nodiff.ts", { ...inRun, oldStr: "a", newStr: "b" }),
        edit("e:2", "bad.ts", { ...inRun, status: "failed", errorText: "String to replace not found" }),
        edit("e:3", "mixed.ts", { ...inRun, additions: 1, deletions: 1, diffStr: journal("mixed.ts", "1", "2") }),
        edit("e:4", "mixed.ts", { ...inRun, oldStr: "x", newStr: "y" }),
      ]),
      "r1",
    );
    const by = (p: string) => scope.files.find((f) => f.entry.path === p)!;
    expect(by("cut.ts").state).toMatchObject({ state: "truncated", message: expect.stringContaining("journal cut") });
    expect(by("cut.ts").patch).not.toBeNull();
    expect(by("nodiff.ts").state).toMatchObject({ state: "truncated", patch: null });
    expect(by("nodiff.ts").entry.countsKnown).toBe(false);
    expect(by("bad.ts").state).toMatchObject({ state: "error", retryable: false, message: expect.stringContaining("String to replace not found") });
    expect(by("mixed.ts").state).toMatchObject({ state: "truncated", message: expect.stringContaining("no diff in the journal") });
  });

  it("marks a file with an edit still running as loading", () => {
    const scope = runScopeFromItems(items([edit("e:0", "a.ts", { ...inRun, status: "running" })]), "r1");
    expect(scope.files[0]!.state.state).toBe("loading");
  });
});

describe("runOptionsFromState", () => {
  it("offers the runs that changed files, newest first, with counts and when", () => {
    const runs: Record<string, Run> = {
      r1: run("r1", { ordinal: 1, completedAt: 5_000 }),
      r2: run("r2", { ordinal: 2, completedAt: 9_000 }),
      r3: run("r3", { ordinal: 3, completedAt: undefined, startedAt: 12_000 }),
    };
    const list = items([
      edit("e:0", "a.ts", { runId: "r1", additions: 2, deletions: 1, diffStr: journal("a.ts", "1", "2") }),
      edit("e:1", "b.ts", { runId: "r1", additions: 1, deletions: 0, diffStr: journal("b.ts", "1", "2") }),
      edit("e:2", "c.ts", { runId: "r3", additions: 4, deletions: 0, diffStr: journal("c.ts", "1", "2") }),
      assistant("m:0", "no files in r2", { runId: "r2" }),
    ]);
    expect(runOptionsFromState(runs, list)).toEqual([
      { runId: "r3", ordinal: 3, files: 1, additions: 4, deletions: 0, at: 12_000 },
      { runId: "r1", ordinal: 1, files: 2, additions: 3, deletions: 1, at: 5_000 },
    ]);
    expect(runOptionsFromState(undefined, list)).toEqual([]);
  });
});
