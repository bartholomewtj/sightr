// T25: every diff adapter whose package resolves is held to the same contract (the seam's props). An adapter
// whose package is not installed is skipped with the reason printed: install the candidates unsaved to run
// them all (web2/diffs-spike.ts). `status` always runs. Light-DOM adapters mark their rows with data-diff-*;
// pierre draws inside a shadow root with its own data-line-type / data-column-number, so each probe knows both.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { DiffAdapterCapabilities, DiffCodeViewProps } from "./DiffCodeView.tsx";
import { queryDeep } from "./spike/files.ts";

type Adapter = { default: ComponentType<DiffCodeViewProps>; capabilities: DiffAdapterCapabilities };
const loaders = import.meta.glob<Adapter>("./adapters/*.tsx");
const loaded = await Promise.all(
  Object.entries(loaders).map(async ([path, load]) => {
    const name = path.replace(/^.*\/|\.tsx$/g, "");
    try {
      return { name, mod: await load(), skip: null as string | null };
    } catch (e) {
      const reason = `${name} skipped: ${(e as Error).message.split("\n")[0]}`;
      console.info(reason);
      return { name, mod: null, skip: reason };
    }
  }),
);

const FILE = "src/app.ts";
const oldLines = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`);
const newLines = [...oldLines];
newLines[2] = "line 3 changed";
newLines[19] = "line 20 changed";
const PATCH = [
  `diff --git a/${FILE} b/${FILE}`,
  `--- a/${FILE}`,
  `+++ b/${FILE}`,
  "@@ -1,6 +1,6 @@",
  " line 1", " line 2", "-line 3", "+line 3 changed", " line 4", " line 5", " line 6",
  "@@ -18,6 +18,6 @@",
  " line 18", " line 19", "-line 20", "+line 20 changed", " line 21", " line 22", " line 23",
].join("\n") + "\n";
const TEXTS = { oldText: oldLines.join("\n") + "\n", newText: newLines.join("\n") + "\n" };

const base = (over: Partial<DiffCodeViewProps> = {}): DiffCodeViewProps => ({ patch: PATCH, filePath: FILE, wrap: true, ...over });

const KINDS = { add: "change-addition", del: "change-deletion" } as const;
/** Changed rows: DiffLines marks them by prefix, hand by kind, pierre by line type in its content column. */
const rowsOf = (c: HTMLElement, kind: "add" | "del") =>
  queryDeep(c, `[data-diff-line="${kind}"], [data-diff-line="${kind === "add" ? "+" : "-"}"], [data-content] [data-line-type="${KINDS[kind]}"]`);
/** The tappable line number: hand's gutter button, or pierre's number cell (deletion rows for the old side). */
const gutterOf = (c: HTMLElement, side: "old" | "new", line: number) =>
  (queryDeep(c, `[data-diff-gutter="${side}"]`).find((g) => g.textContent === String(line)) ??
    queryDeep(c, `[data-gutter] [data-column-number="${line}"]`).find((g) => (g.getAttribute("data-line-type") === "change-deletion") === (side === "old"))) as HTMLElement | undefined;
const gutterNodes = (c: HTMLElement) => queryDeep(c, "[data-diff-gutter], [data-gutter] [data-column-number]");
const expandNodes = (c: HTMLElement) => queryDeep(c, "[data-diff-expand], [data-separator] [data-expand-button]") as HTMLElement[];
/** A line is told apart from context by more than colour: a +/- in the text, or classic indicators on the block. */
const marked = (c: HTMLElement, row: Element, prefix: string) =>
  (row.textContent ?? "").replace(/^\d+/, "").startsWith(prefix) || queryDeep(c, '[data-indicators="classic"]').length > 0;

beforeAll(() => {
  // jsdom has neither observer; pierre measures with them. A Worker is absent too, so pierre renders on the main thread here.
  class Observer { observe() {} unobserve() {} disconnect() {} }
  // Every window counts as on screen: jsdom has no layout, so the hand adapter mounts all its rows.
  class Visible { constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {} observe() { this.cb([{ isIntersecting: true }]); } unobserve() {} disconnect() {} }
  Object.assign(globalThis, { ResizeObserver: Observer, IntersectionObserver: Visible, __SIGHTR_DIFFS_NO_WORKER__: true });
});
afterEach(cleanup);

describe.each(loaded)("diff adapter: $name", ({ name, mod, skip }) => {
  if (skip || !mod) {
    it.skip(skip ?? `${name} did not load`, () => undefined);
    return;
  }
  const Adapter = mod.default;
  const caps = mod.capabilities;

  it("shows the file path and the change counts", async () => {
    const { container } = render(<Adapter {...base()} />);
    expect(screen.getAllByText(FILE).length).toBeGreaterThan(0);
    await waitFor(() => expect(container.textContent).toMatch(/\+2/));
  });

  it("marks added and removed lines by more than colour", async () => {
    const { container } = render(<Adapter {...base()} />);
    await waitFor(() => expect(rowsOf(container, "add").length).toBeGreaterThan(0));
    const del = rowsOf(container, "del")[0] as Element;
    const add = rowsOf(container, "add")[0] as Element;
    expect(del.textContent).toContain("line 3");
    expect(add.textContent).toContain("line 3 changed");
    expect(marked(container, del, "-")).toBe(true);
    expect(marked(container, add, "+")).toBe(true);
  });

  it("wrap changes the layout", async () => {
    const { container, rerender } = render(<Adapter {...base({ wrap: true })} />);
    await waitFor(() => expect(container.querySelector("[data-diff-wrap]")).not.toBeNull());
    rerender(<Adapter {...base({ wrap: false })} />);
    await waitFor(() => expect(container.querySelector("[data-diff-wrap]")).toBeNull());
  });

  it("renders stacked when split is unsupported, and split when it is", async () => {
    const { container } = render(<Adapter {...base({ layout: "split" })} />);
    await waitFor(() => expect(container.querySelector("[data-diff-adapter]")).not.toBeNull());
    expect(container.querySelector("[data-diff-layout]")?.getAttribute("data-diff-layout")).toBe(caps.split ? "split" : "stacked");
  });

  it.runIf(caps.annotations)("has a 44 px gutter target under a coarse pointer", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ ...original(q), matches: /pointer:\s*coarse/.test(q) })) as typeof window.matchMedia;
    try {
      const { container } = render(<Adapter {...base({ onLineAction: () => undefined })} />);
      await waitFor(() => expect(gutterNodes(container).length).toBeGreaterThan(0));
      // hand: Tailwind's pointer-coarse variant (min-w-11 is 44 px). pierre: a coarse-pointer rule in its injected CSS.
      const styles = queryDeep(container, "style").map((s) => s.textContent ?? "").join("\n");
      const tailwind = /pointer-coarse:min-w-11/.test(gutterNodes(container)[0]?.className ?? "");
      expect(tailwind || /pointer:\s*coarse\)\s*\{[^}]*\{[^}]*min-width:\s*44px/.test(styles)).toBe(true);
    } finally {
      window.matchMedia = original;
    }
  });

  it.runIf(caps.annotations)("reports a tapped line: the old side for a removed line", async () => {
    const onLineAction = vi.fn();
    const { container } = render(<Adapter {...base({ onLineAction })} />);
    await waitFor(() => expect(gutterOf(container, "old", 3)).toBeDefined());
    fireEvent.click(gutterOf(container, "old", 3) as HTMLElement);
    expect(onLineAction).toHaveBeenLastCalledWith({ filePath: FILE, side: "old", line: 3 });
    fireEvent.click(gutterOf(container, "new", 3) as HTMLElement);
    expect(onLineAction).toHaveBeenLastCalledWith({ filePath: FILE, side: "new", line: 3 });
  });

  it.runIf(caps.annotations)("draws an annotation under its line", async () => {
    const at = { filePath: FILE, side: "new" as const, line: 3 };
    const { container } = render(<Adapter {...base({ annotations: [{ at, key: "n1" }], renderAnnotation: (a) => <b>note {a.key}</b> })} />);
    await waitFor(() => expect(screen.getByText("note n1")).toBeDefined());
    const row = rowsOf(container, "add").find((r) => r.textContent?.includes("line 3 changed")) as HTMLElement;
    // The note sits directly under its row (pierre slots it into a [data-line-annotation] row), before the next line.
    const next = row.nextElementSibling;
    expect(next?.hasAttribute("data-line-annotation") || next?.textContent?.includes("note n1")).toBe(true);
  });

  it.runIf(caps.expand)("asks for the file once, and shows the lines between hunks", async () => {
    const onExpandContext = vi.fn(async () => TEXTS);
    const { container } = render(<Adapter {...base({ onExpandContext })} />);
    await waitFor(() => expect(expandNodes(container).length).toBeGreaterThan(0));
    expect(container.textContent).not.toContain("line 10");
    await act(async () => { fireEvent.click(expandNodes(container)[0] as HTMLElement); });
    await waitFor(() => expect(queryDeep(container, "*").some((e) => /^[+ -]?line 10$/.test(e.textContent ?? ""))).toBe(true));
    const again = expandNodes(container)[0];
    if (again) await act(async () => { fireEvent.click(again); });
    expect(onExpandContext).toHaveBeenCalledTimes(1);
    expect(onExpandContext).toHaveBeenCalledWith(FILE);
  });

  it.runIf(caps.expand)("shows an error and keeps the diff when the file cannot be loaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined); // pierre logs the rejected load
    const onExpandContext = vi.fn(async () => null);
    const { container } = render(<Adapter {...base({ onExpandContext })} />);
    await waitFor(() => expect(expandNodes(container).length).toBeGreaterThan(0));
    await act(async () => { fireEvent.click(expandNodes(container)[0] as HTMLElement); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/could not load/i));
    expect(rowsOf(container, "add").length).toBeGreaterThan(0);
    expect(queryDeep(container, "*").some((e) => /^[+ -]?line 3 changed$/.test(e.textContent ?? ""))).toBe(true);
    vi.restoreAllMocks();
  });
});

// A Worker that cannot start must leave plain lines, not a throw (the bridge CSP blocks a blob: worker).
const pierre = loaded.find((l) => l.name === "pierre" && l.mod);
describe.runIf(pierre)("pierre without a working worker", () => {
  it("falls back to unhighlighted lines", async () => {
    const flag = globalThis as { __SIGHTR_DIFFS_NO_WORKER__?: boolean };
    flag.__SIGHTR_DIFFS_NO_WORKER__ = false;
    try {
      const Adapter = (pierre?.mod as Adapter).default;
      const { container } = render(<Adapter {...base()} />);
      await waitFor(() => expect(container.textContent).toContain("line 3 changed"));
      expect(container.querySelector("diffs-container")).toBeNull();
    } finally {
      flag.__SIGHTR_DIFFS_NO_WORKER__ = true;
    }
  });
});
