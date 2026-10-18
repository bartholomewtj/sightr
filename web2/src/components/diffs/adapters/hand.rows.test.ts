import { describe, expect, it } from "vitest";

import { parsePatch } from "../parsePatch.ts";
import { EXPAND_STEP, gapSpans, lineMatches, NO_REVEALS, revealMore, splitFileText, splitRows, stackedRows, staleAgainst, type Reveals } from "./hand.rows.ts";

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

/** A one-file patch from hunks written as `[header, ...body]`. */
const patchOf = (...hunks: string[][]) => ["diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", ...hunks.flat(), ""].join("\n");
const parsed = (...hunks: string[][]) => parsePatch(patchOf(...hunks))[0]!;
type Rows = ReturnType<typeof stackedRows>;
const gapRows = (rows: Rows) => rows.flatMap((r) => (r.type === "gap" ? [[r.index, r.hidden, r.up, r.down] as const] : []));
const shown = (rows: Rows, index: number) => rows.flatMap((r) => (r.type === "line" && r.key.startsWith(`g${index}:`) ? [[r.line.newLine, r.line.oldLine, r.line.text] as const] : []));
const lines = (n: number, text = (i: number) => `n${i}`) => Array.from({ length: n }, (_, i) => text(i + 1));
const open = (index: number, top: number, bottom = 0): Reveals => new Map([[index, { top, bottom }]]);

describe("stackedRows", () => {
  it("names the gaps before, between and after hunks, and the tail's size is unknown without the file", () => {
    const rows = stackedRows(file);
    expect(gapRows(rows).map(([i, hidden]) => [i, hidden])).toEqual([[0, 2], [1, 14], [2, null]]);
  });

  it("fills a revealed gap with context lines, numbered on both sides across the hunk's offset", () => {
    const rows = stackedRows(file, newText, open(1, 14));
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

describe("gap rules (T28)", () => {
  it("finds the gap before the first hunk, between hunks and after the last", () => {
    expect(gapSpans(file)).toEqual([{ from: 1, to: 2, delta: 0 }, { from: 7, to: 20, delta: 1 }, { from: 23, to: Infinity, delta: 1 }]);
  });

  it("has no gap before a hunk that starts at line 1", () => {
    const f = parsed(["@@ -1,2 +1,2 @@", "-a", "+b", " c"]);
    expect(gapRows(stackedRows(f))).toEqual([[1, null, false, true]]);
  });

  it("reads a pure insertion (-2,0 +3): the unchanged lines 1 and 2 come before it", () => {
    const f = parsed(["@@ -2,0 +3 @@", "+added"]);
    expect(gapSpans(f)).toEqual([{ from: 1, to: 2, delta: 0 }, { from: 4, to: Infinity, delta: 1 }]);
    const rows = stackedRows(f, ["l1", "l2", "added", "l3", "l4"], new Map([[0, { top: 0, bottom: 2 }], [1, { top: 2, bottom: 0 }]]));
    expect(shown(rows, 0)).toEqual([[1, 1, "l1"], [2, 2, "l2"]]);
    expect(shown(rows, 1)).toEqual([[4, 3, "l3"], [5, 4, "l4"]]);
  });

  it("reads a pure deletion (-3 +2,0): newStart is the line before the hunk, so line 2 is above it and line 3 below", () => {
    const f = parsed(["@@ -3 +2,0 @@", "-gone"]);
    expect(gapSpans(f)).toEqual([{ from: 1, to: 2, delta: 0 }, { from: 3, to: Infinity, delta: -1 }]);
    const rows = stackedRows(f, ["l1", "l2", "l4", "l5"], new Map([[0, { top: 0, bottom: 2 }], [1, { top: 2, bottom: 0 }]]));
    // Above the hunk: new lines 1 and 2 (the old code showed line 2 below it). Below: new 3 and 4 are old 4 and 5.
    expect(shown(rows, 0)).toEqual([[1, 1, "l1"], [2, 2, "l2"]]);
    expect(shown(rows, 1)).toEqual([[3, 4, "l4"], [4, 5, "l5"]]);
    const keys = rows.map((r) => r.key);
    expect(keys.indexOf("g0:2")).toBeLessThan(keys.indexOf("h0"));
    expect(keys.indexOf("g1:3")).toBeGreaterThan(keys.indexOf("h0"));
  });

  it("leaves nothing to expand in a whole-file deletion", () => {
    const f = parsePatch("diff --git a/f b/f\ndeleted file mode 100644\n--- a/f\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n")[0]!;
    expect(stackedRows(f, [], NO_REVEALS).some((r) => r.type === "gap")).toBe(false);
  });

  it("drops the controls when the old and new gap lengths disagree, or a hunk's body disagrees with its header", () => {
    const skewed = parsed(["@@ -1,1 +1,1 @@", "-a", "+b"], ["@@ -10,1 +12,1 @@", "-c", "+d"]); // 8 old lines between, 10 new
    expect(gapSpans(skewed)).toBeNull();
    expect(gapRows(stackedRows(skewed))).toEqual([]);
    const lying = parsed(["@@ -1,3 +1,3 @@", "-a", "+b"]);
    expect(lying.hunks[0]!.mismatch).toBeDefined();
    expect(gapSpans(lying)).toBeNull();
  });

  it("numbers the old side by the offset the hunks before it left", () => {
    const f = parsed(["@@ -2 +2,3 @@", "-x", "+y", "+z", "+w"], ["@@ -9 +11 @@", "-p", "+q"]);
    // The first hunk added two lines, so new 5 is old 3.
    expect(gapSpans(f)?.[1]).toEqual({ from: 5, to: 10, delta: 2 });
    const rows = stackedRows(f, lines(20), open(1, 6));
    expect(shown(rows, 1)[0]).toEqual([5, 3, "n5"]);
    expect(shown(rows, 1).at(-1)).toEqual([10, 8, "n10"]);
  });

  it("ends the tail at the last line: a file with or without a final newline shows its last line once", () => {
    const f = parsed(["@@ -1,2 +1,2 @@", "-a", "+b", " c"]);
    const withNl = splitFileText("b\nc\nd\ne\n");
    const without = splitFileText("b\nc\nd\ne");
    expect(withNl).toEqual(["b", "c", "d", "e"]);
    expect(without).toEqual(["b", "c", "d", "e"]);
    const rows = stackedRows(f, withNl, open(1, 10));
    expect(shown(rows, 1).map((x) => x[2])).toEqual(["d", "e"]);
    expect(gapRows(rows)).toEqual([]);
  });

  it("splits on \\r?\\n so a CRLF file reveals lines without a trailing \\r", () => {
    expect(splitFileText("a\r\nb\r\nc\r\n")).toEqual(["a", "b", "c"]);
    expect(splitFileText("a\r\nb\nc")).toEqual(["a", "b", "c"]);
    expect(splitFileText("")).toEqual([]);
    expect(splitFileText("\n")).toEqual([""]);
  });

  it("keeps a '\\ No newline at end of file' last line in the diff and sizes the tail from it", () => {
    const f = parsed(["@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+c", "\\ No newline at end of file"]);
    expect(f.hunks[0]!.lines.map((l) => [l.text, l.noEol === true])).toEqual([["a", false], ["b", true], ["c", true]]);
    expect(gapRows(stackedRows(f, ["a", "c"], NO_REVEALS))).toEqual([]); // the hunk reaches line 2 of 2: nothing after it
  });

  it("steps by 20 from either end, and shows all, clamped to the gap", () => {
    expect(EXPAND_STEP).toBe(20);
    expect(revealMore(undefined, "down", 50)).toEqual({ top: 20, bottom: 0 });
    expect(revealMore({ top: 20, bottom: 0 }, "up", 50)).toEqual({ top: 20, bottom: 20 });
    expect(revealMore({ top: 20, bottom: 20 }, "down", 50)).toEqual({ top: 30, bottom: 20 });
    expect(revealMore({ top: 30, bottom: 20 }, "up", 50)).toEqual({ top: 30, bottom: 20 });
    expect(revealMore({ top: 5, bottom: 5 }, "all", 50)).toEqual({ top: 50, bottom: 0 });
  });

  it("shows the revealed ends around the controls, which say how many lines remain", () => {
    const f = parsed(["@@ -1 +1 @@", "-a", "+b"], ["@@ -61 +61 @@", "-c", "+d"]);
    const rows = stackedRows(f, lines(80), new Map([[1, { top: 20, bottom: 20 }]]));
    expect(shown(rows, 1).map((x) => x[0])).toEqual([...Array.from({ length: 20 }, (_, i) => 2 + i), ...Array.from({ length: 20 }, (_, i) => 41 + i)]);
    expect(gapRows(rows)).toEqual([[1, 19, true, true], [2, 19, false, true]]);
    const at = rows.findIndex((r) => r.type === "gap" && r.index === 1);
    expect(rows[at - 1]).toMatchObject({ key: "g1:21" });
    expect(rows[at + 1]).toMatchObject({ key: "g1:41" });
  });

  it("gives the tail no control on a cut patch, and none at all when asked", () => {
    expect(gapRows(stackedRows(file, undefined, undefined, { truncated: true }))).toEqual([[0, 2, true, false], [1, 14, true, true]]);
    expect(gapRows(stackedRows(file, undefined, undefined, { controls: false }))).toEqual([]);
  });

  it("keeps a revealed line's identity between calls, so its highlight stays attached", () => {
    const cache = new Map();
    const a = stackedRows(file, newText, open(1, 5), { cache });
    const b = stackedRows(file, newText, open(1, 7), { cache });
    const lineOf = (rows: Rows, key: string) => (rows.find((r) => r.key === key) as { line: unknown }).line;
    expect(lineOf(a, "g1:7")).toBeDefined();
    expect(lineOf(b, "g1:7")).toBe(lineOf(a, "g1:7"));
  });
});

describe("staleAgainst (T28)", () => {
  const f = parsed(["@@ -2,3 +2,3 @@", " two", "-three", "+THREE", " four"]);
  it("passes when the first and last line of each hunk are where the diff says", () => {
    expect(staleAgainst(f, ["one", "two", "THREE", "four", "five"])).toBe(false);
  });
  it("fails when the lines moved, or the file got shorter", () => {
    expect(staleAgainst(f, ["zero", "one", "two", "THREE", "four"])).toBe(true);
    expect(staleAgainst(f, ["one", "two"])).toBe(true);
  });
  it("lets a CRLF line, or one that differs only in whitespace, pass", () => {
    expect(staleAgainst(parsed(["@@ -1 +1 @@", "-a", "+b\r"]), ["b"])).toBe(false);
    expect(staleAgainst(f, ["one", "  two", "THREE", "four\t", "five"])).toBe(false);
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

  const pairsOf = (...hunks: string[][]) => splitRows(stackedRows(parsed(...hunks))).flatMap((r) => (r.type === "pair" ? [[r.left?.text, r.right?.text] as const] : []));
  it("pairs 3 removals with 1 addition, the surplus against an empty cell", () => {
    expect(pairsOf(["@@ -1,3 +1 @@", "-a", "-b", "-c", "+x"])).toEqual([["a", "x"], ["b", undefined], ["c", undefined]]);
  });
  it("pairs 1 removal with 3 additions", () => {
    expect(pairsOf(["@@ -1 +1,3 @@", "-a", "+x", "+y", "+z"])).toEqual([["a", "x"], [undefined, "y"], [undefined, "z"]]);
  });
  it("puts a lone run of removals, or of additions, against empty cells", () => {
    expect(pairsOf(["@@ -1,2 +0,0 @@", "-a", "-b"])).toEqual([["a", undefined], ["b", undefined]]);
    expect(pairsOf(["@@ -0,0 +1,2 @@", "+a", "+b"])).toEqual([[undefined, "a"], [undefined, "b"]]);
  });
  it("shows context on both sides with both numbers", () => {
    const rows = splitRows(stackedRows(parsed(["@@ -4,2 +5,2 @@", " p", " q"])));
    const pairs = rows.flatMap((r) => (r.type === "pair" ? [r] : []));
    expect(pairs.map((p) => [p.left?.oldLine, p.right?.newLine, p.left === p.right])).toEqual([[4, 5, true], [5, 6, true]]);
  });
  it("starts a new run when a removal follows an addition", () => {
    expect(pairsOf(["@@ -1,3 +1,3 @@", "-a", "-b", "+x", "-c", "+y", "+z"])).toEqual([["a", "x"], ["b", undefined], ["c", "y"], [undefined, "z"]]);
  });
  it("keeps the no-newline marker with its own side", () => {
    const onOld = splitRows(stackedRows(parsed(["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b"]))).find((r) => r.type === "pair");
    expect(onOld?.type === "pair" && [onOld.left?.noEol, onOld.right?.noEol]).toEqual([true, undefined]);
    const onNew = splitRows(stackedRows(parsed(["@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file"]))).find((r) => r.type === "pair");
    expect(onNew?.type === "pair" && [onNew.left?.noEol, onNew.right?.noEol]).toEqual([undefined, true]);
  });
  it("gives every row its own key, also across runs", () => {
    const keys = splitRows(stackedRows(parsed(["@@ -1,3 +1,3 @@", "-a", "+x", " m", "-b", "+y", "-c", "+z"]))).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
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
