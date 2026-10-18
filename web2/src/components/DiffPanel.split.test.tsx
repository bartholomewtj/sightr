// T28: split view in the Diff panel. Offered only on a desktop viewport and a diff column of 640 px (624 once
// split); the stored choice is never rewritten by a width change; the Wrap preference decides the structure.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRightPanelStore } from "@/rightPanelStore";
import { setViewportWidth } from "@/test/media";
import { drawWindows, mountPanel, resizePanel, scrolled, section, sections, settle, useDiffPanelHarness } from "@/test/diffPanelHarness";

useDiffPanelHarness();
afterEach(() => vi.restoreAllMocks());

const layoutToggle = () => document.querySelector("[data-diff-layout-toggle]");
const layoutOf = (path: string) => section(path).querySelector("[data-diff-layout]")?.getAttribute("data-diff-layout");
const stored = () => useRightPanelStore.getState().diffLayout;

async function wide(width = 1280, column = 700) {
  setViewportWidth(width);
  await mountPanel();
  await waitFor(() => expect(section("src/a.ts").querySelector("[data-diff-adapter]")).not.toBeNull());
  resizePanel(column);
}

describe("DiffPanel: split view", () => {
  it("shows the Stacked | Split toggle on a wide desktop column, and split when chosen", async () => {
    await wide();
    const group = await screen.findByRole("group", { name: "Diff layout" });
    expect(within(group).getByRole("button", { name: "Stacked" })).toHaveAttribute("aria-pressed", "true");
    expect(layoutOf("src/a.ts")).toBe("stacked");
    fireEvent.click(within(group).getByRole("button", { name: "Split" }));
    expect(stored()).toBe("split");
    await waitFor(() => expect(layoutOf("src/a.ts")).toBe("split"));
    expect(layoutOf("src/b.ts")).toBe("split");
    expect(within(group).getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true");
    // One grid row per pair: the context line, the old|new change, the context line.
    expect(section("src/a.ts").querySelectorAll("[role=row].grid")).toHaveLength(3);
  });

  it("offers no toggle and draws stacked on a narrow column, however the pref is set", async () => {
    useRightPanelStore.getState().setDiffLayout("split");
    await wide(1280, 639);
    expect(layoutToggle()).toBeNull();
    expect(layoutOf("src/a.ts")).toBe("stacked");
    expect(stored()).toBe("split");
  });

  it("goes stacked at phone width with the toggle gone, keeps the stored choice, and brings split back when widened", async () => {
    useRightPanelStore.getState().setDiffLayout("split");
    await wide();
    await waitFor(() => expect(layoutOf("src/a.ts")).toBe("split"));
    expect(layoutToggle()).not.toBeNull();

    act(() => setViewportWidth(390));
    resizePanel(390);
    await waitFor(() => expect(layoutOf("src/a.ts")).toBe("stacked"));
    expect(layoutToggle()).toBeNull();
    expect(stored()).toBe("split"); // untouched

    act(() => setViewportWidth(1280));
    resizePanel(700);
    await waitFor(() => expect(layoutOf("src/a.ts")).toBe("split"));
    expect(layoutToggle()).not.toBeNull();
  });

  it("a 1023 px viewport is a phone even with a wide-looking column", async () => {
    useRightPanelStore.getState().setDiffLayout("split");
    await wide(1023, 900);
    expect(layoutToggle()).toBeNull();
    expect(layoutOf("src/a.ts")).toBe("stacked");
  });

  it("keeps split down to 624 px once it is on, and drops it below", async () => {
    useRightPanelStore.getState().setDiffLayout("split");
    await wide(1280, 640);
    await waitFor(() => expect(layoutOf("src/a.ts")).toBe("split"));
    resizePanel(630);
    await settle(10);
    expect(layoutOf("src/a.ts")).toBe("split");
    resizePanel(624);
    await settle(10);
    expect(layoutOf("src/a.ts")).toBe("split");
    resizePanel(623);
    await waitFor(() => expect(layoutOf("src/a.ts")).toBe("stacked"));
    // Once off it needs the full 640 again.
    resizePanel(630);
    await settle(10);
    expect(layoutOf("src/a.ts")).toBe("stacked");
    resizePanel(640);
    await waitFor(() => expect(layoutOf("src/a.ts")).toBe("split"));
  });

  it("honours Wrap: on, rows wrap inside their half; off, one scrolling box holds both sides", async () => {
    useRightPanelStore.getState().setDiffLayout("split");
    useRightPanelStore.getState().setDiffWrap(true);
    await wide();
    await waitFor(() => expect(layoutOf("src/a.ts")).toBe("split"));
    expect(section("src/a.ts").querySelector("[role=table]")?.className ?? "").not.toMatch(/overflow-x-auto/);
    expect(section("src/a.ts").querySelector(".whitespace-pre-wrap")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Wrap" }));
    await waitFor(() => expect(section("src/a.ts").querySelector("[role=table]")?.className).toMatch(/overflow-x-auto/));
    expect(section("src/a.ts").querySelector(".whitespace-pre-wrap")).toBeNull();
    const inner = section("src/a.ts").querySelector<HTMLElement>("[role=table]")!.firstElementChild as HTMLElement;
    expect(inner.getAttribute("style")).toMatch(/min-width:\s*100%/);
  });

  it("lets a wide panel hide its file column, which is what gives the diffs 640 px (the panel stops at 720)", async () => {
    setViewportWidth(1280);
    await mountPanel();
    resizePanel(720);
    expect(document.querySelector("[data-diff-tree-column]")).not.toBeNull();
    const filesToggle = screen.getByRole("button", { name: "Files" });
    expect(filesToggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(filesToggle);
    expect(document.querySelector("[data-diff-tree-column]")).toBeNull();
    expect(filesToggle).toHaveAttribute("aria-pressed", "false");
    expect(sections()).toHaveLength(2); // the diffs stay
    fireEvent.click(filesToggle);
    expect(document.querySelector("[data-diff-tree-column]")).not.toBeNull();
  });

  it("offers no Files column toggle on a phone, where the tree folds under its header", async () => {
    setViewportWidth(390);
    await mountPanel();
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    expect(document.querySelector("[data-diff-tree-toggle]")).not.toBeNull();
  });

  it("keeps the file that was topmost topmost when the layout changes", async () => {
    await wide();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const gone = this.dataset.diffFile === "src/a.ts";
      const rect = this.dataset.diffFile ? (gone ? { top: -400, bottom: -40 } : { top: -40, bottom: 400 }) : { top: 0, bottom: 800 };
      return { x: 0, y: rect.top, left: 0, right: 700, width: 700, height: rect.bottom - rect.top, ...rect, toJSON: () => ({}) } as DOMRect;
    });
    const scroller = document.querySelector<HTMLElement>("[data-diff-scroller]")!;
    await act(async () => {
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise((r) => setTimeout(r, 60));
    });
    scrolled.length = 0;
    fireEvent.click(await screen.findByRole("button", { name: "Split" }));
    await waitFor(() => expect(layoutOf("src/b.ts")).toBe("split"));
    expect(scrolled).toEqual(["src/b.ts"]);
    expect(sections()).toHaveLength(2);
    drawWindows();
  });
});
