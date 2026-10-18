import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetTimelineState, useTimelineStore } from "@/state/timeline";

import type { ChangedFileRow, RunChangedFiles } from "./ChangedFiles.logic";
import {
  AssistantChangedFilesSection,
  CHANGED_FILES_CAP,
  CHANGED_FILES_VIEW_KEY,
  __resetChangedFilesView,
  autoChangedFilesView,
} from "./AssistantChangedFilesSection";
import { openChangedFile } from "./changedFilesTarget";

vi.mock("./changedFilesTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./changedFilesTarget")>()),
  openChangedFile: vi.fn(),
}));

function row(path: string, over: Partial<ChangedFileRow> = {}): ChangedFileRow {
  return { path, additions: 1, deletions: 0, countsKnown: true, edits: 1, itemIds: [`${path}:0`], created: false, failed: 0, running: false, truncated: false, ...over };
}

function summaryOf(rows: ChangedFileRow[], over: Partial<RunChangedFiles> = {}): RunChangedFiles {
  return {
    runId: "r1",
    rows,
    additions: rows.reduce((n, r) => n + r.additions, 0),
    deletions: rows.reduce((n, r) => n + r.deletions, 0),
    files: rows.length,
    failedEdits: 0,
    shellRan: false,
    editedTwice: false,
    ...over,
  };
}

const MANY = ["src/a.ts", "src/b.ts", "lib/c.ts", "lib/d.ts", "README.md"].map((p) => row(p));

function show(summary: RunChangedFiles) {
  return render(<AssistantChangedFilesSection threadId="t1" runId="r1" summary={summary} />);
}

beforeEach(() => {
  __resetTimelineState();
  __resetChangedFilesView();
  window.localStorage.clear();
  vi.mocked(openChangedFile).mockClear();
});
afterEach(() => window.localStorage.clear());

describe("AssistantChangedFilesSection (T24)", () => {
  it("heads the card with the file count and the total +/-", () => {
    show(summaryOf([row("a.ts", { additions: 3, deletions: 1 }), row("b.ts", { additions: 2, deletions: 2 })]));
    expect(screen.getByText("Changed files (2)")).toBeTruthy();
    expect(screen.getByRole("group", { name: "5 additions, 3 deletions" })).toBeTruthy();
  });

  it("says 'No files changed' when every edit failed, but still lists the failed file", () => {
    const { container } = show(summaryOf([row("a.ts", { failed: 1, edits: 0, countsKnown: false, additions: 0 })], { files: 0, failedEdits: 1, additions: 0, deletions: 0 }));
    expect(screen.getByText("No files changed")).toBeTruthy();
    expect(container.querySelector('[data-mark="failed"]')).toBeTruthy();
  });

  it("picks a tree for 5+ files in more than one folder, else a list", () => {
    expect(autoChangedFilesView(MANY.map((r) => r.path))).toBe("tree");
    expect(autoChangedFilesView(MANY.slice(0, 4).map((r) => r.path))).toBe("flat");
    expect(autoChangedFilesView(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"])).toBe("flat");
    const tree = show(summaryOf(MANY));
    expect(tree.container.querySelector("[data-changed-files-view=tree]")).toBeTruthy();
    tree.unmount();
    const flat = show(summaryOf(MANY.slice(0, 4)));
    expect(flat.container.querySelector("[data-changed-files-view=flat]")).toBeTruthy();
  });

  it("lets the toggle override the view, and keeps the choice on the device", () => {
    const { container, unmount } = show(summaryOf(MANY));
    fireEvent.click(screen.getByRole("button", { name: "Show as a list" }));
    expect(container.querySelector("section[data-changed-files-view=flat]")).toBeTruthy();
    expect(window.localStorage.getItem(CHANGED_FILES_VIEW_KEY)).toBe("flat");
    unmount();
    // A new card, a fresh read of the stored choice.
    __resetChangedFilesView();
    const again = show(summaryOf(MANY));
    expect(again.container.querySelector("section[data-changed-files-view=flat]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show as a tree" }));
    expect(window.localStorage.getItem(CHANGED_FILES_VIEW_KEY)).toBe("tree");
  });

  it("works when storage throws", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { container } = show(summaryOf(MANY));
    expect(container.querySelector("section[data-changed-files-view=tree]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show as a list" }));
    expect(container.querySelector("section[data-changed-files-view=flat]")).toBeTruthy();
    get.mockRestore();
    set.mockRestore();
  });

  it("collapses and expands every folder of the tree, per run", () => {
    const { container } = show(summaryOf(MANY));
    expect(container.querySelectorAll("[data-changed-file]")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(container.querySelectorAll("[data-changed-file]")).toHaveLength(1);
    expect(useTimelineStore.getState().byThread.t1!.collapsedChangedDirs.r1!.size).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(container.querySelectorAll("[data-changed-file]")).toHaveLength(5);
  });

  it("has no Collapse all in the list view", () => {
    show(summaryOf(MANY.slice(0, 2)));
    expect(screen.queryByRole("button", { name: /Collapse all|Expand all/ })).toBeNull();
  });

  it("shows the first 50 files and 'Show all N'", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(`f${String(i).padStart(2, "0")}.ts`));
    const { container } = show(summaryOf(rows));
    expect(container.querySelectorAll("[data-changed-file]")).toHaveLength(CHANGED_FILES_CAP);
    expect(screen.getByText("Changed files (60)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all 60" }));
    expect(container.querySelectorAll("[data-changed-file]")).toHaveLength(60);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("shows no cap button at exactly 50", () => {
    show(summaryOf(Array.from({ length: 50 }, (_, i) => row(`f${i}.ts`))));
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("shows the caveat line only when a shell ran or a file was edited twice", () => {
    const text = "Counts add up each edit and miss changes made by shell commands.";
    const plain = show(summaryOf([row("a.ts")]));
    expect(screen.queryByText(text)).toBeNull();
    plain.unmount();
    const shell = show(summaryOf([row("a.ts")], { shellRan: true }));
    expect(screen.getByText(text)).toBeTruthy();
    shell.unmount();
    show(summaryOf([row("a.ts", { edits: 2 })], { editedTwice: true }));
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("is ignored by thread find", () => {
    const { container } = show(summaryOf([row("a.ts")]));
    expect(container.querySelector("section")!.hasAttribute("data-thread-find-ignore")).toBe(true);
  });

  it("calls the seam with the thread, the run and the path when a row is tapped", () => {
    const { container } = show(summaryOf([row("src/a.ts"), row("src/b.ts")]));
    act(() => {
      fireEvent.click(container.querySelector('[data-changed-file="src/b.ts"]')!);
    });
    expect(openChangedFile).toHaveBeenCalledWith({ threadId: "t1", runId: "r1", path: "src/b.ts" });
  });
});
