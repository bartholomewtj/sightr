import { describe, expect, it } from "vitest";

import { partitionMirrorRuns } from "./mirror-cells";

describe("partitionMirrorRuns", () => {
  it("keeps ASCII as a single text run", () => {
    expect(partitionMirrorRuns("pla  ok")).toEqual([{ kind: "text", text: "pla  ok" }]);
  });

  it("locks each box-drawing cluster to one column", () => {
    expect(partitionMirrorRuns("─".repeat(4))).toEqual([
      { kind: "cell", glyph: "─", cols: 1 },
      { kind: "cell", glyph: "─", cols: 1 },
      { kind: "cell", glyph: "─", cols: 1 },
      { kind: "cell", glyph: "─", cols: 1 },
    ]);
  });

  it("locks a checkmark between ASCII runs", () => {
    expect(partitionMirrorRuns("pla ✓ com")).toEqual([
      { kind: "text", text: "pla " },
      { kind: "cell", glyph: "✓", cols: 1 },
      { kind: "text", text: " com" },
    ]);
  });

  it("leaves Claude's prompt mark in a text run", () => {
    expect(partitionMirrorRuns("❯ 1. Yes")).toEqual([{ kind: "text", text: "❯ 1. Yes" }]);
  });

  it("locks CJK to two columns", () => {
    expect(partitionMirrorRuns("日")).toEqual([{ kind: "cell", glyph: "日", cols: 2 }]);
  });

  it("returns no runs for empty input", () => {
    expect(partitionMirrorRuns("")).toEqual([]);
  });
});
