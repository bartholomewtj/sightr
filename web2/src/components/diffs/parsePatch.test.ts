import { describe, expect, it } from "vitest";

import { parseDiff } from "../right-panel/DiffView.tsx";
import { parsePatch } from "./parsePatch.ts";

const lines = (p: string[]) => p.join("\n") + "\n";

describe("parsePatch", () => {
  it("numbers old and new lines from the hunk header", () => {
    const [f] = parsePatch(
      lines([
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,4 +10,5 @@ function f() {",
        " keep",
        "-old",
        "+new",
        "+extra",
        " tail",
        " end",
      ]),
    );
    expect(f.path).toBe("src/a.ts");
    expect(f.status).toBe("modified");
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(1);
    const h = f.hunks[0];
    expect(h.section).toBe("function f() {");
    expect(h.lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text])).toEqual([
      ["context", 10, 10, "keep"],
      ["del", 11, undefined, "old"],
      ["add", undefined, 11, "new"],
      ["add", undefined, 12, "extra"],
      ["context", 12, 13, "tail"],
      ["context", 13, 14, "end"],
    ]);
    expect(h.mismatch).toBeUndefined();
  });

  it("reads a rename with a similarity index and no hunk", () => {
    const [f] = parsePatch(
      lines(["diff --git a/old name.ts b/new name.ts", "similarity index 92%", "rename from old name.ts", "rename to new name.ts"]),
    );
    expect(f).toMatchObject({ path: "new name.ts", oldPath: "old name.ts", status: "renamed", similarity: 92, hunks: [] });
  });

  it("reads a rename that also changes lines", () => {
    const [f] = parsePatch(
      lines([
        "diff --git a/a.ts b/b.ts",
        "similarity index 80%",
        "rename from a.ts",
        "rename to b.ts",
        "--- a/a.ts",
        "+++ b/b.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ]),
    );
    expect(f).toMatchObject({ path: "b.ts", oldPath: "a.ts", status: "renamed", additions: 1, deletions: 1 });
  });

  it("marks a binary file and keeps the next file", () => {
    const files = parsePatch(
      lines([
        "diff --git a/logo.png b/logo.png",
        "index 1111111..2222222 100644",
        "Binary files a/logo.png and b/logo.png differ",
        "diff --git a/b.txt b/b.txt",
        "--- a/b.txt",
        "+++ b/b.txt",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ]),
    );
    expect(files.map((f) => [f.path, f.status])).toEqual([["logo.png", "binary"], ["b.txt", "modified"]]);
  });

  it("skips a GIT binary patch body", () => {
    const [f] = parsePatch(
      lines(["diff --git a/x.bin b/x.bin", "new file mode 100644", "index 0000000..1111111", "GIT binary patch", "literal 12", "zcmZQ%U|?VX;=5", ""]),
    );
    expect(f.status).toBe("binary");
    expect(f.unknown).toEqual([]);
  });

  it("attaches '\\ No newline' to the preceding line and counts it on neither side", () => {
    const [f] = parsePatch(
      lines(["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", " same", "-last", "\\ No newline at end of file", "+last!", "\\ No newline at end of file"]),
    );
    const h = f.hunks[0];
    expect(h.lines).toHaveLength(3);
    expect(h.lines[1]).toMatchObject({ kind: "del", text: "last", noEol: true });
    expect(h.lines[2]).toMatchObject({ kind: "add", text: "last!", noEol: true, newLine: 2 });
    expect(h.lines[0].noEol).toBeUndefined();
    expect(h.mismatch).toBeUndefined();
  });

  it("decodes quoted names through gitPatchPath", () => {
    const [f] = parsePatch(
      lines(['diff --git "a/caf\\303\\251 b.ts" "b/caf\\303\\251 b.ts"', '--- "a/caf\\303\\251 b.ts"', '+++ "b/caf\\303\\251 b.ts"', "@@ -1 +1 @@", "-a", "+b"]),
    );
    expect(f.path).toBe("café b.ts");
    expect(f.oldPath).toBeUndefined();
  });

  it("decodes a quoted rename", () => {
    const [f] = parsePatch(
      lines(['diff --git "a/\\344\\270\\255.ts" b/plain.ts', "similarity index 100%", 'rename from "\\344\\270\\255.ts"', "rename to plain.ts"]),
    );
    expect(f).toMatchObject({ path: "plain.ts", oldPath: "中.ts", status: "renamed" });
  });

  it("keeps CRLF in the text and does not count it as a line", () => {
    const [f] = parsePatch("diff --git a/w b/w\n--- a/w\n+++ b/w\n@@ -1,2 +1,2 @@\n one\r\n-two\r\n+TWO\r\n");
    const h = f.hunks[0];
    expect(h.lines.map((l) => l.text)).toEqual(["one\r", "two\r", "TWO\r"]);
    expect(h.lines).toHaveLength(3);
    expect(h.mismatch).toBeUndefined();
  });

  it("keeps a removed line whose text starts '-- ' as a removal", () => {
    const [f] = parsePatch(lines(["diff --git a/q.sql b/q.sql", "--- a/q.sql", "+++ b/q.sql", "@@ -1,3 +1,2 @@", " select 1;", "--- a comment", " end"]));
    // "--- a comment" is the removed line "-- a comment"; the old NOISE regex called it a header.
    expect(f.hunks[0].lines.map((l) => [l.kind, l.text])).toEqual([
      ["context", "select 1;"],
      ["del", "-- a comment"],
      ["context", "end"],
    ]);
    expect(f.deletions).toBe(1);
    expect(f.hunks[0].mismatch).toBeUndefined();
    // The status-quo parser drops that row as header noise (why this parser exists).
    const old = parseDiff(lines(["diff --git a/q.sql b/q.sql", "@@ -1,3 +1,2 @@", " select 1;", "--- a comment", " end"]));
    expect(old[0].lines).not.toContain("--- a comment");
  });

  it("reads an added file", () => {
    const [f] = parsePatch(lines(["diff --git a/n.txt b/n.txt", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", "+++ b/n.txt", "@@ -0,0 +1,2 @@", "+a", "+b"]));
    expect(f).toMatchObject({ path: "n.txt", status: "added", additions: 2, deletions: 0 });
    expect(f.oldPath).toBeUndefined();
    expect(f.hunks[0].lines.map((l) => l.newLine)).toEqual([1, 2]);
  });

  it("reads a deleted file", () => {
    const [f] = parsePatch(lines(["diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "index 1111111..0000000", "--- a/gone.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-a", "-b"]));
    expect(f).toMatchObject({ path: "gone.txt", status: "deleted", additions: 0, deletions: 2 });
  });

  it("reads a plain unified diff with no git header, and marks /dev/null sides", () => {
    const files = parsePatch(lines(["--- a.txt\t2026-01-01", "+++ a.txt\t2026-01-02", "@@ -1 +1 @@", "-x", "+y", "--- /dev/null", "+++ b.txt", "@@ -0,0 +1 @@", "+new"]));
    expect(files.map((f) => [f.path, f.status])).toEqual([["a.txt", "modified"], ["b.txt", "added"]]);
  });

  it("returns nothing for an empty patch", () => {
    expect(parsePatch("")).toEqual([]);
    expect(parsePatch("\n\n")).toEqual([]);
  });

  it("reports a hunk whose counts disagree with its body, and trusts the body", () => {
    const [short] = parsePatch(lines(["diff --git a/s b/s", "--- a/s", "+++ b/s", "@@ -1,5 +1,5 @@", " a", "-b", "+B"]));
    expect(short.hunks[0].lines).toHaveLength(3);
    expect(short.hunks[0].mismatch).toEqual({ declaredOld: 5, declaredNew: 5, actualOld: 2, actualNew: 2 });
    const [long] = parsePatch(lines(["diff --git a/l b/l", "--- a/l", "+++ b/l", "@@ -1,1 +1,1 @@", " a", "+extra", "+more"]));
    expect(long.hunks[0].lines).toHaveLength(3);
    expect(long.hunks[0].mismatch).toMatchObject({ declaredNew: 1, actualNew: 3 });
    expect(long.additions).toBe(2);
  });

  it("stops a hunk at the next file even when its counts were wrong", () => {
    const files = parsePatch(lines(["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1,9 +1,9 @@", " a", "diff --git a/b b/b", "--- a/b", "+++ b/b", "@@ -1 +1 @@", "-x", "+y"]));
    expect(files.map((f) => f.path)).toEqual(["a", "b"]);
    expect(files[0].hunks[0].mismatch).toBeDefined();
    expect(files[1].hunks[0].mismatch).toBeUndefined();
  });

  it("reads two hunks and a hunk header with an implicit count of 1", () => {
    const [f] = parsePatch(lines(["diff --git a/m b/m", "--- a/m", "+++ b/m", "@@ -3 +3 @@", "-a", "+b", "@@ -20,2 +20,2 @@ tail", " c", "-d", "+D"]));
    expect(f.hunks).toHaveLength(2);
    expect(f.hunks[0]).toMatchObject({ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 });
    expect(f.hunks[1].lines[1]).toMatchObject({ kind: "del", oldLine: 21 });
  });

  it("splits a path with spaces on an unquoted header", () => {
    const [f] = parsePatch(lines(["diff --git a/my dir/my file.ts b/my dir/my file.ts", "--- a/my dir/my file.ts", "+++ b/my dir/my file.ts", "@@ -1 +1 @@", "-a", "+b"]));
    expect(f.path).toBe("my dir/my file.ts");
  });

  it("treats a mode-only change as a modified file with no hunks", () => {
    const [f] = parsePatch(lines(["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"]));
    expect(f).toMatchObject({ path: "run.sh", status: "modified", hunks: [], unknown: [] });
  });

  it("ignores text before the first file", () => {
    const files = parsePatch(lines(["From abc Mon Sep 17 00:00:00 2001", "Subject: [PATCH] x", "", "diff --git a/z b/z", "--- a/z", "+++ b/z", "@@ -1 +1 @@", "-a", "+b"]));
    expect(files).toHaveLength(1);
    expect(files[0].unknown).toEqual([]);
  });
});
