// T27: the hand adapter's windowing (README "What T27 to T29 inherit"): a window closes at 60 rows or 12,000
// characters, only the first mounts at once (and only when `eager`), a window highlights its own lines in slices
// of at most 200, and nothing highlight-related outlives the component.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ParsedLine } from "../parsePatch.ts";
import { parsePatch } from "../parsePatch.ts";
import HandAdapter from "./hand.tsx";
import { HIGHLIGHT_SLICE, highlightLines } from "./hand.highlight.ts";
import { stackedRows, WINDOW_MAX_CHARS, WINDOW_MAX_ROWS, windowLines, windowRows } from "./hand.rows.ts";

const addedFile = (count: number, text = (i: number) => `const value${i} = ${i};`, path = "src/big.ts") => {
  const body = Array.from({ length: count }, (_, i) => `+${text(i)}`);
  return [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${count} @@`, ...body, ""].join("\n");
};

describe("windowRows", () => {
  it("closes a window at 60 rows", () => {
    const rows = stackedRows(parsePatch(addedFile(150))[0]!);
    const windows = windowRows(rows);
    expect(WINDOW_MAX_ROWS).toBe(60);
    expect(windows.map((w) => w.length)).toEqual([60, 60, 31]); // 150 lines + the hunk header
    expect(windows.flat()).toEqual(rows);
  });

  it("closes a window at 12,000 characters of line text: 400-character lines get 30 rows", () => {
    const rows = stackedRows(parsePatch(addedFile(100, () => "x".repeat(400)))[0]!);
    const windows = windowRows(rows);
    expect(WINDOW_MAX_CHARS).toBe(12_000);
    expect(windows[0]).toHaveLength(31); // the hunk header costs no characters
    expect(windows[1]).toHaveLength(30);
    for (const w of windows) {
      const chars = w.reduce((n, r) => n + (r.type === "line" ? r.line.text.length : 0), 0);
      expect(chars).toBeLessThanOrEqual(WINDOW_MAX_CHARS);
    }
  });

  it("gives a row longer than the cap a window of its own, and never an empty window", () => {
    const rows = stackedRows(parsePatch(addedFile(3, (i) => "y".repeat(i === 1 ? 20_000 : 5)))[0]!);
    const windows = windowRows(rows);
    expect(windows.every((w) => w.length > 0)).toBe(true);
    expect(windows.map((w) => w.length)).toEqual([2, 1, 1]); // header + line 0 | the long line | line 2
  });

  it("lists a window's distinct lines (a context pair is one line)", () => {
    const lines = windowLines(stackedRows(parsePatch(addedFile(5))[0]!));
    expect(lines).toHaveLength(5);
  });
});

describe("highlightLines", () => {
  it("calls highlight with at most 200 lines at a time, and yields between slices", async () => {
    const core = (await import("highlight.js/lib/core")).default;
    const spy = vi.spyOn(core, "highlight");
    const lines = stackedRows(parsePatch(addedFile(450))[0]!).flatMap((r) => (r.type === "line" ? [r.line] : []));
    const out = await highlightLines(lines, "src/big.ts", () => false);
    expect(HIGHLIGHT_SLICE).toBe(200);
    expect(spy.mock.calls.map((c) => c[0].split("\n").length)).toEqual([200, 200, 50]);
    expect(out?.size).toBe(450);
    spy.mockRestore();
  });

  it("stops at a slice edge when cancelled, and reports nothing", async () => {
    const lines = stackedRows(parsePatch(addedFile(450))[0]!).flatMap((r) => (r.type === "line" ? [r.line] : []));
    let calls = 0;
    const out = await highlightLines(lines, "src/big.ts", () => ++calls > 2);
    expect(out).toBeNull();
  });

  it("highlights removals against the old side and keeps only them", async () => {
    const del: ParsedLine = { kind: "del", text: "const a = 1;", oldLine: 1 };
    const add: ParsedLine = { kind: "add", text: "let a = 2;", newLine: 1 };
    const out = await highlightLines([del, add], "x.ts", () => false);
    expect(new Set(out?.keys())).toEqual(new Set([del, add]));
  });

  it("has nothing for a path with no grammar", async () => {
    expect(await highlightLines([{ kind: "add", text: "a", newLine: 1 }], "data.bin", () => false)).toBeNull();
  });
});

type IoCallback = (entries: { isIntersecting: boolean }[]) => void;
let observers: { el: Element; fire: () => void }[] = [];

beforeEach(() => {
  observers = [];
  class FakeIO {
    private cb: IoCallback;
    constructor(cb: IoCallback) {
      this.cb = cb;
    }
    observe(el: Element) {
      observers.push({ el, fire: () => this.cb([{ isIntersecting: true }]) });
    }
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
});
afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
});

const windowsOf = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-diff-window]")).map((w) => w.getAttribute("data-diff-window"));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

describe("HandAdapter windows", () => {
  const patch = addedFile(150);

  it("mounts only the first window at once; the rest mount as they near the screen", async () => {
    const { container } = render(<HandAdapter patch={patch} filePath="src/big.ts" wrap />);
    expect(windowsOf(container)).toEqual(["on", "off", "off"]);
    expect(container.querySelectorAll("[data-diff-line]").length).toBe(60 - 1); // the first window's lines (one row is the hunk header)
    const second = observers.find((o) => o.el.getAttribute("data-diff-window") === "off");
    await act(async () => second?.fire());
    expect(windowsOf(container)).toEqual(["on", "on", "off"]);
  });

  it("with eager false even the first window waits for the screen", () => {
    const { container } = render(<HandAdapter patch={patch} filePath="src/big.ts" wrap eager={false} />);
    expect(windowsOf(container)).toEqual(["off", "off", "off"]);
    expect(container.querySelectorAll("[data-diff-line]").length).toBe(0);
  });

  it("holds an estimated height for a window that is not mounted", () => {
    const { container } = render(<HandAdapter patch={patch} filePath="src/big.ts" wrap />);
    const off = container.querySelector<HTMLElement>("[data-diff-window=off]");
    expect(off?.style.height).toBe("1200px"); // 60 rows at 20 px
  });

  it("highlights only the mounted window's lines, and a later window when it mounts", async () => {
    const core = (await import("highlight.js/lib/core")).default;
    const spy = vi.spyOn(core, "highlight");
    const { container } = render(<HandAdapter patch={patch} filePath="src/big.ts" wrap />);
    await settle();
    const first = spy.mock.calls.map((c) => c[0].split("\n").length);
    expect(first.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(WINDOW_MAX_ROWS);
    expect(container.querySelector("[class*=hljs-]")).not.toBeNull();
    const before = spy.mock.calls.length;
    await act(async () => observers.find((o) => o.el.getAttribute("data-diff-window") === "off")?.fire());
    await settle();
    expect(spy.mock.calls.length).toBeGreaterThan(before);
    spy.mockRestore();
  });

  it("cancels the highlight when the component unmounts mid-way", async () => {
    const core = (await import("highlight.js/lib/core")).default;
    const spy = vi.spyOn(core, "highlight");
    const long = addedFile(60, (i) => `const value${i} = ${i};`);
    const { unmount } = render(<HandAdapter patch={long} filePath="src/big.ts" wrap />);
    unmount();
    await settle();
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });
});
