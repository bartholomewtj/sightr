// T29: the range rules. Side from the first row, shift extends, rows with no number on the side are skipped, a range
// never spans two hunks, 12 lines at most, and where a comment's lines are after the file changed.
import { describe, expect, it } from "vitest";

import { blockHash } from "@/lib/reviewCommentContext";
import { parsePatch } from "./parsePatch";
import { clearRange, extendGesture, findRow, locateComment, MAX_RANGE_LINES, quoteFor, rangeOf, startGesture } from "./lineSelection";

const patch = (hunks: string[]) => ["diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", ...hunks].join("\n") + "\n";
const file = (hunks: string[]) => parsePatch(patch(hunks))[0]!;

// Hunk 0: old 1-6, new 1-7:  ctx1 ctx2 -old3 +new3a +new3b ctx4 ctx5 ctx6(old6/new7)
const H0 = ["@@ -1,6 +1,7 @@", " one", " two", "-three", "+THREE", "+THREE-B", " four", " five", " six"];
// Hunk 1, far below: old 30-31, new 31-32
const H1 = ["@@ -30,2 +31,2 @@", " thirty", "-old31", "+new32"];
const two = file([...H0, ...H1]);

describe("startGesture and findRow", () => {
  it("takes the side from the first row and the hunk from where it is", () => {
    expect(startGesture(two, { side: "old", line: 3 })).toEqual({ side: "old", anchor: 3, head: 3, hunk: 0 });
    expect(startGesture(two, { side: "new", line: 3 })).toEqual({ side: "new", anchor: 3, head: 3, hunk: 0 });
    expect(startGesture(two, { side: "new", line: 32 })?.hunk).toBe(1);
  });

  it("finds nothing for a line the patch does not draw (revealed unchanged context, or the wrong side)", () => {
    expect(startGesture(two, { side: "old", line: 15 })).toBeNull();
    expect(findRow(two, { side: "new", line: 31 })?.line.text).toBe("thirty");
    // old line 4 is context "four"; new line 4 is the added "THREE-B"? no: new 3 and 4 are the two added lines
    expect(findRow(two, { side: "new", line: 4 })?.line.text).toBe("THREE-B");
    expect(findRow(two, { side: "old", line: 4 })?.line.text).toBe("four");
  });
});

describe("extendGesture", () => {
  it("grows the range either way from the anchor", () => {
    const g = startGesture(two, { side: "new", line: 3 })!;
    const down = extendGesture(two, g, { side: "new", line: 6 });
    expect(rangeOf(down.gesture)).toEqual({ side: "new", start: 3, end: 6 });
    const up = extendGesture(two, g, { side: "new", line: 1 });
    expect(rangeOf(up.gesture)).toEqual({ side: "new", start: 1, end: 3 });
    expect(up.gesture.anchor).toBe(3); // the anchor stays put while the head moves
    expect(rangeOf(extendGesture(two, up.gesture, { side: "new", line: 5 }).gesture)).toEqual({ side: "new", start: 3, end: 5 });
  });

  it("skips a row with no number on the range's side", () => {
    const g = startGesture(two, { side: "old", line: 2 })!;
    // new line 3 is an added row: it has no old number
    const r = extendGesture(two, g, { side: "new", line: 3 });
    expect(r.skipped).toBe(true);
    expect(r.gesture).toBe(g);
  });

  it("resolves a tap on the other side's gutter by its row (a context row has both numbers)", () => {
    const g = startGesture(two, { side: "old", line: 2 })!;
    // new line 7 is the context row "six", old line 6
    expect(rangeOf(extendGesture(two, g, { side: "new", line: 7 }).gesture)).toEqual({ side: "old", start: 2, end: 6 });
  });

  it("moves the anchor when the tap is in another hunk", () => {
    const g = startGesture(two, { side: "new", line: 3 })!;
    const r = extendGesture(two, g, { side: "new", line: 32 });
    expect(r.gesture).toEqual({ side: "new", anchor: 32, head: 32, hunk: 1 });
    expect(r.skipped).toBe(false);
  });

  it("stops at 12 lines and says so", () => {
    const body = Array.from({ length: 30 }, (_, i) => ` line ${i + 1}`);
    const long = file([`@@ -1,30 +1,30 @@`, ...body]);
    const g = startGesture(long, { side: "new", line: 5 })!;
    const r = extendGesture(long, g, { side: "new", line: 25 });
    expect(MAX_RANGE_LINES).toBe(12);
    expect(rangeOf(r.gesture)).toEqual({ side: "new", start: 5, end: 16 });
    expect(r.limited).toBe(true);
    const back = extendGesture(long, g, { side: "new", line: 1 });
    expect(back.limited).toBe(false);
    expect(rangeOf(back.gesture)).toEqual({ side: "new", start: 1, end: 5 });
    const farBack = extendGesture(long, startGesture(long, { side: "new", line: 25 })!, { side: "new", line: 1 });
    expect(rangeOf(farBack.gesture)).toEqual({ side: "new", start: 14, end: 25 });
    expect(farBack.limited).toBe(true);
  });

  it("clears back to the anchor", () => {
    const g = extendGesture(two, startGesture(two, { side: "new", line: 3 })!, { side: "new", line: 6 }).gesture;
    expect(rangeOf(clearRange(g))).toEqual({ side: "new", start: 3, end: 3 });
  });
});

describe("quoteFor", () => {
  it("quotes the new side with + and space, never -", () => {
    expect(quoteFor(two, { side: "new", start: 2, end: 5 })).toEqual([" two", "+THREE", "+THREE-B", " four"]);
  });
  it("quotes the old side with - and space, never +", () => {
    expect(quoteFor(two, { side: "old", start: 2, end: 4 })).toEqual([" two", "-three", " four"]);
  });
  it("is null for a range the patch does not hold", () => {
    expect(quoteFor(two, { side: "new", start: 20, end: 21 })).toBeNull();
    expect(quoteFor(two, { side: "new", start: 6, end: 31 })).toBeNull(); // spans two hunks
  });
  it("drops a CRLF file's \\r", () => {
    const crlf = file(["@@ -1,1 +1,1 @@", "-a\r", "+b\r"]);
    expect(quoteFor(crlf, { side: "new", start: 1, end: 1 })).toEqual(["+b"]);
  });
});

describe("locateComment", () => {
  const comment = (f: ReturnType<typeof file>, range: { side: "old" | "new"; start: number; end: number }) => ({ ...range, hash: blockHash(quoteFor(f, range)!) });

  it("anchored: the same range, the same lines", () => {
    expect(locateComment(two, comment(two, { side: "new", start: 3, end: 4 }))).toEqual({ state: "anchored" });
  });

  it("moved: the same run of lines at another place on that side", () => {
    const c = comment(two, { side: "new", start: 3, end: 4 });
    const shifted = file(["@@ -1,8 +1,9 @@", " zero", " zero-b", " one", " two", "-three", "+THREE", "+THREE-B", " four", " five", " six"]);
    expect(locateComment(shifted, c)).toEqual({ state: "moved", start: 5, end: 6 });
  });

  it("moved: picks the nearest copy of a repeated run", () => {
    const rep = ["+x", "+x"];
    const f = file(["@@ -0,0 +1,2 @@", ...rep, "@@ -10,1 +20,3 @@", " ctx", ...rep]);
    const c = { side: "new" as const, start: 21, end: 22, hash: blockHash(rep) };
    expect(locateComment(f, c)).toEqual({ state: "anchored" });
    expect(locateComment(f, { ...c, start: 19, end: 20 })).toEqual({ state: "moved", start: 21, end: 22 });
    expect(locateComment(f, { ...c, start: 3, end: 4 })).toEqual({ state: "moved", start: 1, end: 2 });
  });

  it("outdated: the lines changed, or are gone", () => {
    const c = comment(two, { side: "new", start: 3, end: 4 });
    const edited = file(["@@ -1,6 +1,7 @@", " one", " two", "-three", "+THREE!", "+THREE-B", " four", " five", " six"]);
    expect(locateComment(edited, c)).toEqual({ state: "outdated" });
    expect(locateComment(file(["@@ -1,1 +1,1 @@", "-a", "+b"]), c)).toEqual({ state: "outdated" });
  });

  it("outdated: a line that went from context to changed does not match (the prefix is hashed)", () => {
    const c = comment(two, { side: "new", start: 2, end: 2 }); // " two"
    const changed = file(["@@ -1,6 +1,7 @@", " one", "-two", "+two", " three", " four", " five", " six"]);
    expect(locateComment(changed, c).state).toBe("outdated");
  });
});
