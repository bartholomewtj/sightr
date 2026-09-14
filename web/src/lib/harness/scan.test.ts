import { describe, expect, it } from "vitest";
import { findTailBox, lastNonBlankIndex, regionSignature, rstrip, skipBlanksUp } from "./scan";

const bottom = (s: string) => s === "bottom";
const top = (s: string) => s === "top";
const inner = (s: string) => s === "inner" || s === "prompt";

 describe("scan primitives", () => {
  it("rstrips only the tail", () => {
    expect(rstrip("  text  ")).toBe("  text");
    expect(rstrip("   ")).toBe("");
  });
  it("finds the last non-blank row", () => {
    expect(lastNonBlankIndex(["a", "b", " "])).toBe(1);
    expect(lastNonBlankIndex([" ", "\t"])).toBe(-1);
    expect(lastNonBlankIndex([])).toBe(-1);
  });
  it("skips only a permitted blank gap", () => {
    expect(skipBlanksUp(["a", " ", " ", "b"], 2, 2)).toBe(0);
    expect(skipBlanksUp(["a", " ", " ", "b"], 2, 1)).toBe(-1);
    expect(skipBlanksUp([" ", "a"], 0, 1)).toBe(-1);
    expect(skipBlanksUp(["a", "b"], 1, 0)).toBe(1);
  });
  it("signs a half-open range", () => {
    expect(regionSignature(["a", "b", "c"], -2, 2)).toBe("a\nb");
    expect(regionSignature(["a", "b"], 1, 1)).toBe("");
  });
  it("finds a prompt box from the tail", () => {
    const found = findTailBox(["before", "top", "prompt", "inner", "bottom", " ", "hint"], {
      top, bottom, inner, prompt: (s) => s === "prompt", maxInner: 3,
      below: (s) => s === " " || s === "hint", maxBelow: 2, maxBlankRun: 1,
    });
    expect(found).toEqual({ top: 1, firstInner: 2, prompt: 2, bottom: 4, belowEnd: 7 });
  });
  it("rejects incomplete or over-budget shapes", () => {
    expect(findTailBox(["top", "inner"], { top, bottom, inner, maxInner: 2 })).toBeNull();
    expect(findTailBox(["wrong", "prompt", "bottom"], { top, bottom, inner, prompt: (s) => s === "prompt", maxInner: 2 })).toBeNull();
    expect(findTailBox(["top", " ", " ", "prompt", "bottom"], { top, bottom, inner, prompt: (s) => s === "prompt", maxInner: 2, maxBlankRun: 1 })).toBeNull();
    expect(findTailBox(["top", "inner", "bottom", "bad"], { top, bottom, inner, maxInner: 2, below: () => false, maxBelow: 1 })).toBeNull();
    expect(findTailBox(["noise", "top", "inner", "bottom", "tail"], { top, bottom, inner, maxInner: 1, below: () => true, maxBelow: 1, end: 4 })).toEqual({ top: 1, firstInner: 2, prompt: 2, bottom: 3, belowEnd: 4 });
    expect(findTailBox(["top", "inner", "bottom"], { top, bottom, inner, maxInner: 0 })).toBeNull();
  });
});
