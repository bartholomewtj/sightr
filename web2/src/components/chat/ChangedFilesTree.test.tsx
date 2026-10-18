import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChangedFileRow } from "./ChangedFiles.logic";
import { ChangedFilesTree, collectChangedDirectoryPaths } from "./ChangedFilesTree";

function row(path: string, over: Partial<ChangedFileRow> = {}): ChangedFileRow {
  return {
    path,
    additions: 1,
    deletions: 0,
    countsKnown: true,
    edits: 1,
    itemIds: [`${path}:0`],
    created: false,
    failed: 0,
    running: false,
    truncated: false,
    ...over,
  };
}

const ROWS = [row("src/index.ts", { additions: 2, deletions: 1 }), row("src/components/Button.tsx", { additions: 4, deletions: 2 }), row("README.md")];

function setup(props: Partial<Parameters<typeof ChangedFilesTree>[0]> = {}) {
  const onSelect = vi.fn();
  const onToggleDir = vi.fn();
  const utils = render(<ChangedFilesTree rows={ROWS} view="tree" collapsedDirs={new Set()} onToggleDir={onToggleDir} onSelect={onSelect} {...props} />);
  return { onSelect, onToggleDir, ...utils };
}

describe("ChangedFilesTree (T24)", () => {
  it("draws a tree: folders first, files nested, a stat on each", () => {
    const { container } = setup();
    expect(container.querySelector("[data-changed-files-view]")!.getAttribute("data-changed-files-view")).toBe("tree");
    const dirs = [...container.querySelectorAll("[data-changed-dir]")].map((el) => el.getAttribute("data-changed-dir"));
    expect(dirs).toEqual(["src", "src/components"]);
    const files = [...container.querySelectorAll("[data-changed-file]")].map((el) => el.getAttribute("data-changed-file"));
    expect(files).toEqual(["src/components/Button.tsx", "src/index.ts", "README.md"]);
    const button = container.querySelector('[data-changed-file="src/components/Button.tsx"]') as HTMLElement;
    expect(within(button).getByRole("group", { name: "4 additions, 2 deletions" })).toBeTruthy();
  });

  it("draws flat rows: the folder dim, the name beside it, no folders", () => {
    const { container } = setup({ view: "flat" });
    expect(container.querySelectorAll("[data-changed-dir]")).toHaveLength(0);
    const flat = container.querySelector('[data-changed-file="src/components/Button.tsx"]') as HTMLElement;
    expect(flat.textContent).toContain("src/components/Button.tsx");
    expect(container.querySelectorAll("[data-changed-file]")).toHaveLength(3);
  });

  it("calls onSelect with the row's own path", () => {
    const { onSelect, container } = setup();
    fireEvent.click(container.querySelector('[data-changed-file="src/index.ts"]')!);
    expect(onSelect).toHaveBeenCalledWith("src/index.ts");
    fireEvent.click(container.querySelector('[data-changed-file="README.md"]')!);
    expect(onSelect).toHaveBeenLastCalledWith("README.md");
  });

  it("selects the original spelling when the tree drops a leading slash", () => {
    const { onSelect, container } = setup({ rows: [row("/home/me/a.ts"), row("/home/me/b.ts")] });
    fireEvent.click(container.querySelector('[data-changed-file="/home/me/b.ts"]')!);
    expect(onSelect).toHaveBeenCalledWith("/home/me/b.ts");
  });

  it("marks created, failed and running rows, and hides the stat of a row with no counts", () => {
    const { container } = setup({
      view: "flat",
      rows: [
        row("new.ts", { created: true }),
        row("bad.ts", { failed: 1, edits: 0, countsKnown: false, additions: 0 }),
        row("live.ts", { running: true, edits: 0, countsKnown: false, additions: 0 }),
        row("plain.ts"),
      ],
    });
    const at = (path: string) => container.querySelector(`[data-changed-file="${path}"]`) as HTMLElement;
    expect(at("new.ts").querySelector('[data-mark="new"]')).toBeTruthy();
    expect(at("bad.ts").querySelector('[data-mark="failed"]')).toBeTruthy();
    expect(at("bad.ts").querySelector('[role="group"]')).toBeNull();
    expect(at("live.ts").querySelector('[data-mark="running"]')).toBeTruthy();
    expect(at("live.ts").querySelector('[role="group"]')).toBeNull();
    expect(at("plain.ts").querySelector("[data-mark]")).toBeNull();
    expect(at("plain.ts").querySelector('[role="group"]')).toBeTruthy();
  });

  it("hides the children of a collapsed folder, and Collapse all / Expand all are the caller's sets", () => {
    const all = collectChangedDirectoryPaths(ROWS);
    expect(all).toEqual(["src", "src/components"]);
    const folded = setup({ collapsedDirs: new Set(all) });
    expect(folded.container.querySelectorAll("[data-changed-file]")).toHaveLength(1);
    expect(folded.container.querySelector('[data-changed-dir="src"]')!.getAttribute("aria-expanded")).toBe("false");
    folded.unmount();
    const opened = setup({ collapsedDirs: new Set() });
    expect(opened.container.querySelectorAll("[data-changed-file]")).toHaveLength(3);
    expect(opened.container.querySelector('[data-changed-dir="src"]')!.getAttribute("aria-expanded")).toBe("true");
  });

  it("asks to fold one folder", () => {
    const { onToggleDir, container } = setup();
    fireEvent.click(container.querySelector('[data-changed-dir="src/components"]')!);
    expect(onToggleDir).toHaveBeenCalledWith("src/components");
  });

  it("wraps a long path instead of cutting it, and keeps a 44 px touch target", () => {
    const long = `${"deeply-nested-folder/".repeat(6)}a-very-long-file-name-that-would-not-fit.component.test.tsx`;
    const { container } = setup({ view: "flat", rows: [row(long)] });
    const button = container.querySelector("[data-changed-file]") as HTMLElement;
    const label = button.querySelector("[data-changed-file-label]") as HTMLElement;
    expect(label.className).toContain("wrap-anywhere");
    expect(label.className).not.toContain("truncate");
    expect(button.className).toContain("pointer-coarse:min-h-11");
    expect(screen.queryByText("…")).toBeNull();
    expect(label.textContent).toBe(long);
  });

  it("lists two rows that share a tree path (an absolute and a relative spelling)", () => {
    const { container, onSelect } = setup({ rows: [row("/p/a.ts"), row("p/a.ts")] });
    const files = [...container.querySelectorAll("[data-changed-file]")].map((el) => el.getAttribute("data-changed-file"));
    expect(files.sort()).toEqual(["/p/a.ts", "p/a.ts"]);
    fireEvent.click(container.querySelector('[data-changed-file="p/a.ts"]')!);
    expect(onSelect).toHaveBeenCalledWith("p/a.ts");
  });
});
