import { describe, expect, it } from "vitest";

import { parsePatch } from "../parsePatch.ts";
import { lineMatches, splitRows, stackedRows } from "./hand.rows.ts";

const patch = [
  "diff --git a/f.ts b/f.ts",
  "--- a/f.ts",
  "+++ b/f.ts",
  "@@ -3,3 +3,4 @@",
  " c3",
  "-old4",
  "+new4",
  "+extra",
  " c5",
  "@@ -20,2 +21,2 @@",
  "-old20",
  "+new21",
  " c21",
  "",
].join("\n");
const file = parsePatch(patch)[0]!;
const newText = Array.from({ length: 30 }, (_, i) => `n${i + 1}`);

describe("stackedRows", () => {
  it("names the gaps before, between and after hunks, and the tail's size is unknown without the file", () => {
    const rows = stackedRows(file);
    expect(rows.filter((r) => r.type === "gap").map((r) => (r.type === "gap" ? [r.index, r.hidden] : []))).toEqual([[0, 2], [1, 14], [2, null]]);
  });

  it("fills a revealed gap with context lines, numbered on both sides across the hunk's offset", () => {
    const rows = stackedRows(file, newText, new Set([1]));
    const filled = rows.filter((r) => r.type === "line" && r.key.startsWith("g1:"));
    expect(filled).toHaveLength(14);
    const first = filled[0];
    // Between the hunks the new file runs one line ahead of the old one (the first hunk added a line).
    expect(first?.type === "line" && [first.line.newLine, first.line.oldLine, first.line.text]).toEqual([7, 6, "n7"]);
    expect(rows.some((r) => r.type === "gap" && r.index === 1)).toBe(false);
  });

  it("sizes the tail gap once the file length is known, and leaves a new or removed file alone", () => {
    const rows = stackedRows(file, newText);
    expect(rows.find((r) => r.type === "gap" && r.index === 2)).toMatchObject({ hidden: 8 });
    const added = parsePatch("diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n")[0]!;
    expect(stackedRows(added, ["a", "b", "c"]).some((r) => r.type === "gap")).toBe(false);
  });
});

describe("splitRows", () => {
  it("pairs removals with the additions after them and leaves context on both sides", () => {
    const pairs = splitRows(stackedRows(file)).filter((r) => r.type === "pair");
    expect(pairs.map((p) => (p.type === "pair" ? [p.left?.text, p.right?.text] : []))).toEqual([
      ["c3", "c3"],
      ["old4", "new4"],
      [undefined, "extra"],
      ["c5", "c5"],
      ["old20", "new21"],
      ["c21", "c21"],
    ]);
  });
});

describe("lineMatches", () => {
  it("answers a context line on either side and a change on its own", () => {
    const [c, del, add] = [file.hunks[0]!.lines[0], file.hunks[0]!.lines[1], file.hunks[0]!.lines[2]];
    expect([lineMatches(c, "old", 3), lineMatches(c, "new", 3)]).toEqual([true, true]);
    expect([lineMatches(del, "old", 4), lineMatches(del, "new", 4)]).toEqual([true, false]);
    expect([lineMatches(add, "new", 4), lineMatches(add, "old", 4)]).toEqual([true, false]);
  });
});
