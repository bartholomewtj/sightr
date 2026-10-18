import { beforeEach, describe, expect, it } from "vitest";

import {
  EMPTY_TIMELINE_UI,
  __resetTimelineState,
  collapsedChangedDirsOf,
  setChangedDirsCollapsed,
  toggleChangedDir,
  toggleTurnFold,
  toggleWorkGroup,
  useTimelineStore,
} from "./timeline";

const ui = (threadId: string) => useTimelineStore.getState().byThread[threadId] ?? EMPTY_TIMELINE_UI;

beforeEach(() => __resetTimelineState());

describe("collapsed changed-files directories (T24)", () => {
  it("is empty by default, so a tree opens fully", () => {
    expect(collapsedChangedDirsOf(ui("t1"), "r1").size).toBe(0);
    expect(EMPTY_TIMELINE_UI.collapsedChangedDirs).toEqual({});
  });

  it("toggles a directory in and out for one run", () => {
    toggleChangedDir("t1", "r1", "src");
    expect([...collapsedChangedDirsOf(ui("t1"), "r1")]).toEqual(["src"]);
    toggleChangedDir("t1", "r1", "src/lib");
    expect([...collapsedChangedDirsOf(ui("t1"), "r1")].sort()).toEqual(["src", "src/lib"]);
    toggleChangedDir("t1", "r1", "src");
    expect([...collapsedChangedDirsOf(ui("t1"), "r1")]).toEqual(["src/lib"]);
  });

  it("keeps each run and each thread apart", () => {
    toggleChangedDir("t1", "r1", "src");
    toggleChangedDir("t1", "r2", "lib");
    toggleChangedDir("t2", "r1", "docs");
    expect([...collapsedChangedDirsOf(ui("t1"), "r1")]).toEqual(["src"]);
    expect([...collapsedChangedDirsOf(ui("t1"), "r2")]).toEqual(["lib"]);
    expect([...collapsedChangedDirsOf(ui("t2"), "r1")]).toEqual(["docs"]);
    expect(collapsedChangedDirsOf(ui("t3"), "r1").size).toBe(0);
  });

  it("collapses and expands all at once", () => {
    setChangedDirsCollapsed("t1", "r1", ["a", "a/b", "c"]);
    expect(collapsedChangedDirsOf(ui("t1"), "r1").size).toBe(3);
    setChangedDirsCollapsed("t1", "r1", []);
    expect(collapsedChangedDirsOf(ui("t1"), "r1").size).toBe(0);
  });

  it("leaves the fold and work-group sets alone, and they leave it alone", () => {
    toggleTurnFold("t1", "r1");
    toggleWorkGroup("t1", "g1");
    toggleChangedDir("t1", "r1", "src");
    expect([...ui("t1").expandedRunIds]).toEqual(["r1"]);
    expect([...ui("t1").expandedWorkGroupIds]).toEqual(["g1"]);
    toggleTurnFold("t1", "r1");
    expect([...collapsedChangedDirsOf(ui("t1"), "r1")]).toEqual(["src"]);
  });

  it("changes the set's identity on a toggle (so subscribers re-render) and not otherwise", () => {
    toggleChangedDir("t1", "r1", "src");
    const before = collapsedChangedDirsOf(ui("t1"), "r1");
    toggleTurnFold("t1", "r9");
    expect(collapsedChangedDirsOf(ui("t1"), "r1")).toBe(before);
    toggleChangedDir("t1", "r1", "lib");
    expect(collapsedChangedDirsOf(ui("t1"), "r1")).not.toBe(before);
  });
});
