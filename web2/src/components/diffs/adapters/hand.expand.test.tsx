// T28 at the seam: the hand adapter's split layout and its expand-unchanged-lines controls, driven the way the
// Diff panel drives them (`onExpandContext` resolves the file's text; the adapter keeps everything else).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiffCodeViewProps, DiffExpandContents } from "../DiffCodeView.tsx";
import HandAdapter from "./hand.tsx";

afterEach(cleanup);

const FILE = "src/app.ts";
/** A 120-line file where line 3 and line 100 changed, so the hunks are lines 1-6 and 97-103 (3 lines of context each side). */
const text = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `const v${i + 1} = ${i + 1};`);
const NEW = text(120, { 3: "const v3 = 'three';", 100: "const v100 = 'hundred';" });
const OLD = text(120);
const hunk = (start: number, at: number) => [
  `@@ -${start},7 +${start},7 @@`,
  ...[0, 1, 2].map((i) => ` ${OLD[start - 1 + i]}`),
  `-${OLD[at - 1]}`,
  `+${NEW[at - 1]}`,
  ...[1, 2, 3].map((i) => ` ${OLD[at - 1 + i]}`),
];
const HEAD = [`diff --git a/${FILE} b/${FILE}`, `--- a/${FILE}`, `+++ b/${FILE}`];
const PATCH = [...HEAD, "@@ -1,6 +1,6 @@", ...[0, 1].map((i) => ` ${OLD[i]}`), `-${OLD[2]}`, `+${NEW[2]}`, ...[3, 4, 5].map((i) => ` ${OLD[i]}`), ...hunk(97, 100), ""].join("\n");
const body = (t: string[]) => t.join("\n") + "\n";
const CONTENTS: DiffExpandContents = { oldText: body(OLD), newText: body(NEW) };

const view = (over: Partial<DiffCodeViewProps> = {}) =>
  render(<HandAdapter patch={PATCH} filePath={FILE} wrap header={false} onExpandContext={async () => CONTENTS} {...over} />);
const controls = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("[data-diff-expand]")).map((b) => b.textContent);
const control = (c: HTMLElement, label: string | RegExp) => Array.from(c.querySelectorAll<HTMLElement>("[data-diff-expand]")).find((b) => (typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""))) as HTMLElement;
const tap = async (el: HTMLElement) => act(async () => { fireEvent.click(el); });
const rowNew = (c: HTMLElement, n: number) => c.querySelector<HTMLElement>(`[data-new-line="${n}"]`);

describe("expand: the controls", () => {
  it("shows a gap's lines and size, with steps from each end and a show-all, and reads the file once", async () => {
    const onExpandContext = vi.fn(async () => CONTENTS);
    const { container } = view({ onExpandContext });
    // Gaps: none before line 1; 90 lines between the hunks (7-96); the tail 104-120 is unknown until the file is read.
    expect(controls(container)).toEqual(["↓ 20 more below the previous hunk", "↑ 20 more above the next hunk", "Show all 90", "↓ 20 more below", "Show all"]);
    expect(onExpandContext).not.toHaveBeenCalled();

    await tap(control(container, "↓ 20 more below the previous hunk"));
    expect(onExpandContext).toHaveBeenCalledTimes(1);
    expect(onExpandContext).toHaveBeenCalledWith(FILE);
    for (const n of [7, 26]) expect(rowNew(container, n)).not.toBeNull();
    expect(rowNew(container, 27)).toBeNull();
    expect(rowNew(container, 7)?.dataset.oldLine).toBe("7");
    expect(controls(container)).toContain("Show all 70");

    await tap(control(container, "↑ 20 more above the next hunk"));
    expect(rowNew(container, 77)).not.toBeNull();
    expect(rowNew(container, 96)).not.toBeNull();
    expect(rowNew(container, 76)).toBeNull();

    await tap(control(container, "Show all 50"));
    expect(rowNew(container, 50)?.textContent).toContain("const v50 = 50;");
    expect(container.querySelector('[data-diff-gap="1"]')).toBeNull();
    expect(onExpandContext).toHaveBeenCalledTimes(1);
  });

  it("opens the tail from the last hunk once the file is known, then says how many lines remain", async () => {
    const { container } = view();
    await tap(control(container, "↓ 20 more below"));
    // The last hunk ends at line 103; the file has 120 lines, so 17 remain... and all 17 fit in one step.
    expect(rowNew(container, 104)).not.toBeNull();
    expect(rowNew(container, 120)).not.toBeNull();
    expect(container.querySelector('[data-diff-gap="2"]')).toBeNull();
  });

  it("a gap of 20 lines or fewer is one 'Show N lines' button", () => {
    const small = [...HEAD, "@@ -1,2 +1,2 @@", "-a", "+b", " c", "@@ -10,2 +10,2 @@", " d", "-e", "+f", ""].join("\n");
    const { container } = view({ patch: small });
    expect(controls(container).slice(0, 1)).toEqual(["Show 7 lines"]);
  });

  it("numbers the first gap from the top and offers 'above' only", async () => {
    const lateOnly = [...HEAD, ...hunk(97, 100), ""].join("\n");
    const { container } = view({ patch: lateOnly });
    expect(controls(container).slice(0, 2)).toEqual(["↑ 20 more above", "Show all 96"]);
    await tap(control(container, "↑ 20 more above"));
    expect(rowNew(container, 77)).not.toBeNull();
    expect(rowNew(container, 76)).toBeNull();
    expect(rowNew(container, 77)?.dataset.oldLine).toBe("77");
  });

  it("puts the line before a pure deletion above the hunk, not below it", async () => {
    const lost = [...HEAD, "@@ -3 +2,0 @@", "-gone", ""].join("\n");
    const newFile = ["l1", "l2", "l4", "l5"];
    const { container } = view({ patch: lost, onExpandContext: async () => ({ oldText: "", newText: body(newFile) }) });
    await tap(control(container, "Show 2 lines"));
    const order = Array.from(container.querySelectorAll<HTMLElement>("[data-diff-line], [data-diff-gap]")).map((r) => r.dataset.newLine ?? (r.dataset.diffLine === "del" ? "del" : `gap${r.dataset.diffGap}`));
    expect(order).toEqual(["1", "2", "del", "gap1"]);
  });

  it("gives a cut patch no control after its last hunk", () => {
    const { container } = view({ truncated: true });
    expect(controls(container)).toEqual(["↓ 20 more below the previous hunk", "↑ 20 more above the next hunk", "Show all 90"]);
  });

  it("has no controls without a way to read the file", () => {
    const { container } = render(<HandAdapter patch={PATCH} filePath={FILE} wrap />);
    expect(container.querySelector("[data-diff-expand]")).toBeNull();
  });

  it("starts again from a new patch: the revealed lines go and the file is read again", async () => {
    const onExpandContext = vi.fn(async () => CONTENTS);
    const { container, rerender } = view({ onExpandContext });
    await tap(control(container, "Show all 90"));
    expect(rowNew(container, 50)).not.toBeNull();
    rerender(<HandAdapter patch={PATCH + "\n"} filePath={FILE} wrap header={false} onExpandContext={onExpandContext} />);
    expect(rowNew(container, 50)).toBeNull();
    await tap(control(container, "Show all 90"));
    expect(onExpandContext).toHaveBeenCalledTimes(2);
  });
});

describe("expand: states", () => {
  it("says 'Couldn't read this file' and retries on tap; the diff stays", async () => {
    const onExpandContext = vi.fn(async (): Promise<DiffExpandContents | null> => CONTENTS).mockResolvedValueOnce(null);
    const { container } = view({ onExpandContext });
    await tap(control(container, "Show all 90"));
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn't read this file/);
    expect(container.querySelector('[data-diff-line="add"]')).not.toBeNull();
    await tap(screen.getByRole("button", { name: "Retry" }));
    expect(rowNew(container, 50)).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onExpandContext).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["binary", /Binary file/],
    ["too-large", /File too large to expand/],
    ["refused", /Files keeps that file hidden/],
  ] as const)("a %s file: one note, no controls", async (unavailable, note) => {
    const { container } = view({ onExpandContext: async () => ({ unavailable }) });
    await tap(control(container, "Show all 90"));
    expect(container.querySelector("[data-diff-expand-note=blocked]")?.textContent).toMatch(note);
    expect(container.querySelector("[data-diff-expand]")).toBeNull();
  });

  it("a file that changed since the diff: says so and shows no controls and no lines", async () => {
    const shifted = ["// new first line", ...NEW];
    const { container } = view({ onExpandContext: async () => ({ oldText: "", newText: body(shifted) }) });
    await tap(control(container, "Show all 90"));
    expect(screen.getByRole("alert").textContent).toBe("File changed since this diff. Refresh.");
    expect(container.querySelector("[data-diff-expand]")).toBeNull();
    expect(rowNew(container, 50)).toBeNull();
  });

  it("a file gone from disk reads as changed", async () => {
    const { container } = view({ onExpandContext: async () => ({ unavailable: "absent" }) });
    await tap(control(container, "Show all 90"));
    expect(screen.getByRole("alert").textContent).toMatch(/File changed since this diff/);
  });

  it("splits a CRLF file on its newlines: revealed text has no trailing carriage return", async () => {
    const crlf = NEW.join("\r\n") + "\r\n";
    const { container } = view({ onExpandContext: async () => ({ oldText: "", newText: crlf }) });
    await tap(control(container, "Show all 90"));
    expect(rowNew(container, 50)?.textContent).not.toMatch(/\r/);
  });
});

describe("expand: highlighting", () => {
  it("highlights revealed lines through the same path as the diff's own", async () => {
    const { container } = view();
    await tap(control(container, "Show all 90"));
    await waitFor(() => expect(rowNew(container, 50)?.querySelector("[class*=hljs-], [class*=hljs]")).not.toBeNull());
    // The lines already there keep theirs.
    expect(rowNew(container, 1)?.querySelector("[class*=hljs-]")).not.toBeNull();
  });
});

describe("split layout", () => {
  const change = [...HEAD, "@@ -1,5 +1,3 @@", " keep", "-one", "-two", "-three", "+ONE", " end", ""].join("\n");

  it("pairs removals with additions in one grid row, old half then new half", () => {
    const { container } = view({ patch: change, layout: "split", onExpandContext: undefined });
    expect(container.querySelector("[data-diff-layout]")?.getAttribute("data-diff-layout")).toBe("split");
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[role=row]"));
    expect(rows).toHaveLength(5); // keep, one|ONE, two|, three|, end
    expect(rows.every((r) => r.className.includes("grid-cols-2"))).toBe(true);
    const halves = Array.from(rows[1]!.querySelectorAll<HTMLElement>("[data-diff-side]")).map((h) => [h.dataset.diffSide, h.textContent]);
    expect(halves).toEqual([["old", "2-one"], ["new", "2+ONE"]]);
    expect(Array.from(rows[2]!.querySelectorAll<HTMLElement>("[data-diff-side]")).map((h) => h.textContent)).toEqual(["3-two", ""]);
  });

  it("wrap on: long lines wrap inside their half and the table does not scroll sideways", () => {
    const { container } = view({ patch: change, layout: "split", wrap: true, onExpandContext: undefined });
    expect(container.querySelector("[role=table]")?.className).not.toMatch(/overflow-x-auto/);
    expect(container.querySelector(".whitespace-pre-wrap")).not.toBeNull();
  });

  it("wrap off: one scrolling box holds both sides, as wide as the longest line, at least the width of the view", () => {
    const long = [...HEAD, "@@ -1 +1 @@", `-${"a".repeat(80)}`, "+b", ""].join("\n");
    const { container } = view({ patch: long, layout: "split", wrap: false, onExpandContext: undefined });
    const table = container.querySelector<HTMLElement>("[role=table]")!;
    expect(table.className).toMatch(/overflow-x-auto/);
    const inner = table.firstElementChild as HTMLElement;
    expect(inner.style.minWidth).toBe("100%");
    expect(inner.style.width).toBe("calc(162ch + 6rem)"); // 2 x (80 + 1) columns plus both gutters and paddings
    expect(container.querySelector(".whitespace-pre-wrap")).toBeNull();
  });

  it("draws a bare @@ @@ hunk in two halves with blank numbers and no controls", () => {
    const parsed = {
      path: FILE, status: "modified" as const, additions: 1, deletions: 1, unknown: [],
      hunks: [{ header: "@@ @@", oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, section: "", lines: [{ kind: "del" as const, text: "old" }, { kind: "add" as const, text: "new" }] }],
    };
    const { container } = view({ patch: "", parsed, layout: "split" });
    const halves = Array.from(container.querySelectorAll<HTMLElement>("[data-diff-side]")).map((h) => h.textContent);
    expect(halves).toEqual(["-old", "+new"]); // no number in front of either
    expect(container.querySelector("[data-diff-expand]")).toBeNull();
  });

  it("keeps the no-newline note on the side of its line", () => {
    const eof = [...HEAD, "@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b", ""].join("\n");
    const { container } = view({ patch: eof, layout: "split", onExpandContext: undefined });
    const [old, now] = Array.from(container.querySelectorAll<HTMLElement>("[data-diff-side]"));
    expect(old!.textContent).toMatch(/No newline at end of file/);
    expect(now!.textContent).not.toMatch(/No newline/);
  });

  it("keeps a window of long context lines to the node budget: a context pair counts twice towards the 12,000 characters", async () => {
    // Windows after the first wait for the screen, which a stub that never fires keeps them from reaching.
    vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
    const long = (i: number) => `const value${i} = "${"x".repeat(380)}";`;
    const body = Array.from({ length: 200 }, (_, i) => ` ${long(i)}`);
    const flat = [...HEAD, "@@ -1,200 +1,200 @@", ...body, ""].join("\n");
    const stacked = view({ patch: flat, layout: "stacked", onExpandContext: undefined });
    await waitFor(() => expect(stacked.container.querySelector("[class*=hljs-]")).not.toBeNull());
    const stackedNodes = stacked.container.querySelectorAll("*").length;
    stacked.unmount();
    const split = view({ patch: flat, layout: "split", onExpandContext: undefined });
    await waitFor(() => expect(split.container.querySelector("[class*=hljs-]")).not.toBeNull());
    // 12,000 characters over a pair's two sides of 400: 15 rows in a window (stacked: 30).
    expect(split.container.querySelectorAll("[role=row]").length).toBeLessThanOrEqual(15);
    // The first window of a split file stays within the 5,000-node budget, and about the size of a stacked one.
    expect(split.container.querySelectorAll("*").length).toBeLessThanOrEqual(5000);
    expect(split.container.querySelectorAll("*").length).toBeLessThanOrEqual(stackedNodes * 1.3);
    vi.unstubAllGlobals();
  });

  it("opens a gap in split too, drawing the revealed line on both sides", async () => {
    const { container } = view({ layout: "split" });
    await tap(control(container, "Show all 90"));
    const row = rowNew(container, 50) ?? Array.from(container.querySelectorAll<HTMLElement>("[role=row]")).find((r) => r.textContent?.includes("const v50 = 50;"));
    expect(row).toBeTruthy();
    const halves = Array.from((row as HTMLElement).closest("[role=row]")!.querySelectorAll<HTMLElement>("[data-diff-side]"));
    expect(halves.map((h) => h.textContent?.includes("const v50 = 50;"))).toEqual([true, true]);
  });
});
