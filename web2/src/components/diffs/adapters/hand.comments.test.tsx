// T29: what the hand adapter adds for line comments. A gutter that reports taps (a touch only when it did not scroll), a
// selection marked on its rows, an annotation under the last line of a range, windows that unmount far from the screen
// (keeping their height, never a pinned one), and a line to reveal that mounts its window first.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HandAdapter, { TAP_MAX_MS, TAP_SLOP_PX, UNMOUNT_MARGIN_PX } from "./hand.tsx";

const addedFile = (count: number, path = "src/big.ts") =>
  [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${count} @@`, ...Array.from({ length: count }, (_, i) => `+const value${i + 1} = ${i + 1};`), ""].join("\n");
const mixed = ["diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", "@@ -1,5 +1,6 @@", " one", " two", "-three", "+THREE", "+THREE-B", " four", " five", ""].join("\n");

type Obs = { el: Element; cb: (e: { isIntersecting: boolean }[]) => void; margin: string; live: boolean };
let observers: Obs[] = [];

beforeEach(() => {
  observers = [];
  class FakeIO {
    private cb: Obs["cb"];
    private margin: string;
    private mine: Obs[] = [];
    constructor(cb: Obs["cb"], init?: { rootMargin?: string }) {
      this.cb = cb;
      this.margin = init?.rootMargin ?? "0px";
    }
    observe(el: Element) {
      const o = { el, cb: this.cb, margin: this.margin, live: true };
      this.mine.push(o);
      observers.push(o);
    }
    disconnect() {
      for (const o of this.mine) o.live = false;
    }
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
});

const liveOn = (el: Element) => observers.filter((o) => o.live && o.el === el).at(-1);
const windows = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("[data-diff-window]"));
const states = (c: HTMLElement) => windows(c).map((w) => w.getAttribute("data-diff-window"));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const intersect = (el: Element, isIntersecting: boolean) => act(async () => liveOn(el)?.cb([{ isIntersecting }]));

describe("the gutter", () => {
  const gutter = (c: HTMLElement, side: "old" | "new", n: number) => Array.from(c.querySelectorAll<HTMLElement>(`[data-diff-gutter=${side}]`)).find((g) => g.textContent === String(n))!;
  const at = (n: number, side: "old" | "new" = "new") => ({ filePath: "f.ts", side, line: n });

  it("has no vertical hit-area extension: a tap on the lower part of a number is its own line's", () => {
    const { container } = render(<HandAdapter patch={mixed} filePath="f.ts" wrap onLineAction={() => undefined} />);
    const buttons = Array.from(container.querySelectorAll<HTMLElement>("[data-diff-gutter]"));
    expect(buttons.length).toBeGreaterThan(8);
    for (const b of buttons) {
      expect(b.className).toContain("pointer-coarse:min-w-11"); // 44 px wide under a coarse pointer
      expect(b.className).not.toMatch(/inset-y|after:/); // the ::after that reached 12 px into the rows above and below is gone
      expect(b.style.touchAction).toBe("pan-y");
    }
    // Each row's buttons name that row's own line.
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-diff-line]"));
    for (const row of rows) {
      const own = Array.from(row.querySelectorAll<HTMLElement>("[data-diff-gutter]"));
      for (const g of own) expect(g.getAttribute("aria-label")).toBe(`${g.getAttribute("data-diff-gutter")} line ${g.textContent}`);
    }
  });

  it("reports a mouse click with the shift key", () => {
    const onLineAction = vi.fn();
    const { container } = render(<HandAdapter patch={mixed} filePath="f.ts" wrap onLineAction={onLineAction} />);
    fireEvent.click(gutter(container, "new", 3));
    expect(onLineAction).toHaveBeenLastCalledWith(at(3), { shiftKey: false });
    fireEvent.click(gutter(container, "new", 4), { shiftKey: true });
    expect(onLineAction).toHaveBeenLastCalledWith(at(4), { shiftKey: true });
  });

  const touch = (el: Element, from: [number, number], to: [number, number], holdMs = 0) => {
    vi.useFakeTimers();
    fireEvent.pointerDown(el, { pointerType: "touch", clientX: from[0], clientY: from[1] });
    vi.advanceTimersByTime(holdMs);
    fireEvent.pointerUp(el, { pointerType: "touch", clientX: to[0], clientY: to[1] });
  };

  it("fires a touch tap on pointerup, once, and ignores the click that follows", () => {
    const onLineAction = vi.fn();
    const { container } = render(<HandAdapter patch={mixed} filePath="f.ts" wrap onLineAction={onLineAction} />);
    const g = gutter(container, "new", 3);
    touch(g, [10, 10], [12, 11], 80);
    expect(onLineAction).toHaveBeenCalledTimes(1);
    expect(onLineAction).toHaveBeenLastCalledWith(at(3), { shiftKey: false });
    fireEvent.click(g); // the synthesised click of the same tap
    expect(onLineAction).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the finger moved 20 px (a scroll that started on the gutter)", () => {
    const onLineAction = vi.fn();
    const { container } = render(<HandAdapter patch={mixed} filePath="f.ts" wrap onLineAction={onLineAction} />);
    const g = gutter(container, "new", 3);
    expect(TAP_SLOP_PX).toBe(8);
    touch(g, [10, 10], [10, 30], 60);
    fireEvent.click(g); // a click a browser might still synthesise is not a tap either
    expect(onLineAction).not.toHaveBeenCalled();
  });

  it("does not fire on a long press (500 ms or more)", () => {
    const onLineAction = vi.fn();
    const { container } = render(<HandAdapter patch={mixed} filePath="f.ts" wrap onLineAction={onLineAction} />);
    expect(TAP_MAX_MS).toBe(500);
    touch(gutter(container, "new", 3), [10, 10], [10, 10], 600);
    expect(onLineAction).not.toHaveBeenCalled();
  });

  it("does not fire when the browser cancels the touch (it took the gesture for a scroll)", () => {
    const onLineAction = vi.fn();
    const { container } = render(<HandAdapter patch={mixed} filePath="f.ts" wrap onLineAction={onLineAction} />);
    const g = gutter(container, "new", 3);
    fireEvent.pointerDown(g, { pointerType: "touch", clientX: 1, clientY: 1 });
    fireEvent.pointerCancel(g, { pointerType: "touch" });
    fireEvent.pointerUp(g, { pointerType: "touch", clientX: 1, clientY: 1 });
    expect(onLineAction).not.toHaveBeenCalled();
  });

  it("draws a number with no handler as plain text, not a button", () => {
    const { container } = render(<HandAdapter patch={mixed} filePath="f.ts" wrap />);
    expect(container.querySelector("[data-diff-gutter]")).toBeNull();
  });
});

describe("selection and annotation", () => {
  it("marks the rows of the range on its side, and only those", () => {
    const { container } = render(<HandAdapter patch={mixed} filePath="f.ts" wrap selection={{ side: "new", start: 3, end: 4 }} />);
    const marked = Array.from(container.querySelectorAll("[data-diff-selected]")).map((r) => r.textContent);
    expect(marked).toHaveLength(2);
    expect(marked[0]).toContain("THREE");
    expect(marked[1]).toContain("THREE-B");
  });

  it("an old-side range marks the deleted row and the context rows by their old numbers", () => {
    const { container } = render(<HandAdapter patch={mixed} filePath="f.ts" wrap selection={{ side: "old", start: 2, end: 4 }} />);
    const marked = Array.from(container.querySelectorAll("[data-diff-selected]")).map((r) => r.textContent ?? "");
    expect(marked).toHaveLength(3);
    expect(marked.some((t) => t.includes("three"))).toBe(true);
    expect(marked.some((t) => t.includes("THREE"))).toBe(false);
  });

  it("draws a range's annotation under its last line", () => {
    const { container } = render(
      <HandAdapter
        patch={mixed}
        filePath="f.ts"
        wrap
        selection={{ side: "new", start: 3, end: 4 }}
        annotations={[{ at: { filePath: "f.ts", side: "new", line: 4 }, key: "editor" }]}
        renderAnnotation={(a) => <b>note {a.key}</b>}
      />,
    );
    const note = container.querySelector("[data-diff-annotation=editor]")!;
    expect(note.previousElementSibling?.textContent).toContain("THREE-B");
    expect(note.nextElementSibling?.textContent).toContain("four");
  });
});

describe("windows unmount far from the screen", () => {
  const patch = addedFile(150);

  it("unmounts a window that left the screen, and keeps the height it measured", async () => {
    const { container } = render(<HandAdapter patch={patch} filePath="src/big.ts" wrap />);
    await settle();
    expect(states(container)).toEqual(["on", "off", "off"]);
    const first = windows(container)[0]!;
    first.getBoundingClientRect = () => ({ height: 1234 }) as DOMRect;
    expect(liveOn(first)?.margin).toBe(`${UNMOUNT_MARGIN_PX}px 0px`); // a mounted window is watched with the wider margin
    await intersect(first, false);
    expect(states(container)[0]).toBe("off");
    expect(first.style.height).toBe("1234px");
    expect(first.querySelector("[data-diff-line]")).toBeNull();
    expect(liveOn(first)?.margin).toBe("800px 0px"); // and mounts again on the nearer one
    await intersect(first, true);
    expect(states(container)[0]).toBe("on");
    expect(first.querySelectorAll("[data-diff-line]").length).toBeGreaterThan(0);
  });

  it("lets go of the highlight when it unmounts, and highlights again when it returns", async () => {
    const { container } = render(<HandAdapter patch={patch} filePath="src/big.ts" wrap />);
    await settle();
    const first = windows(container)[0]!;
    expect(first.querySelector("[class*=hljs-]")).not.toBeNull();
    first.getBoundingClientRect = () => ({ height: 900 }) as DOMRect;
    await intersect(first, false);
    await intersect(first, true);
    expect(first.querySelector("[class*=hljs-]")).toBeNull(); // plain at first...
    await settle();
    expect(first.querySelector("[class*=hljs-]")).not.toBeNull(); // ...then highlighted again
  });

  it("never unmounts a window that holds a selection or an annotation", async () => {
    const { container, rerender } = render(<HandAdapter patch={patch} filePath="src/big.ts" wrap selection={{ side: "new", start: 5, end: 6 }} />);
    await settle();
    const first = windows(container)[0]!;
    await intersect(first, false);
    expect(states(container)[0]).toBe("on");
    rerender(<HandAdapter patch={patch} filePath="src/big.ts" wrap annotations={[{ at: { filePath: "src/big.ts", side: "new", line: 5 }, key: "n" }]} renderAnnotation={() => <i>n</i>} />);
    await intersect(first, false);
    expect(states(container)[0]).toBe("on");
    const before = observers.filter((o) => o.el === first).length;
    rerender(<HandAdapter patch={patch} filePath="src/big.ts" wrap />);
    // Unpinning gives the window a new observer: a real one delivers a first entry, so an off-screen window unmounts.
    expect(observers.filter((o) => o.el === first).length).toBeGreaterThan(before);
    await intersect(first, false);
    expect(states(container)[0]).toBe("off");
  });

  it("forgets a measured height when the rows would measure differently (wrap toggled)", async () => {
    const { container, rerender } = render(<HandAdapter patch={patch} filePath="src/big.ts" wrap />);
    await settle();
    const first = windows(container)[0]!;
    first.getBoundingClientRect = () => ({ height: 777 }) as DOMRect;
    await intersect(first, false);
    expect(first.style.height).toBe("777px");
    rerender(<HandAdapter patch={patch} filePath="src/big.ts" wrap={false} />);
    await settle();
    expect(windows(container)[0]!.style.height).toBe("1200px"); // back to the estimate: 60 rows at 20 px
  });

  it("a sweep keeps only the windows near the screen mounted", async () => {
    const big = addedFile(600);
    const { container } = render(<HandAdapter patch={big} filePath="src/big.ts" wrap />);
    await settle();
    const all = windows(container);
    expect(all.length).toBe(11);
    // The screen moves down one window at a time: the one it reaches mounts, the one it left unmounts.
    let mountedMax = 0;
    for (let i = 1; i < all.length; i++) {
      await intersect(all[i]!, true);
      all[i - 1]!.getBoundingClientRect = () => ({ height: 1200 }) as DOMRect;
      await intersect(all[i - 1]!, false);
      mountedMax = Math.max(mountedMax, states(container).filter((s) => s === "on").length);
    }
    expect(mountedMax).toBeLessThanOrEqual(2);
    expect(states(container).filter((s) => s === "on")).toHaveLength(1);
    expect(container.querySelectorAll("[data-diff-line]").length).toBeLessThan(120);
  });
});

describe("the node budget", () => {
  it("a 3,000-line file of 400-character lines stays under 5,000 nodes through a whole sweep", async () => {
    const line = (i: number) => `+const v${i} = "${"x".repeat(380)}";`;
    const big = ["diff --git a/src/wide.ts b/src/wide.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/wide.ts", "@@ -0,0 +1,3000 @@", ...Array.from({ length: 3000 }, (_, i) => line(i + 1)), ""].join("\n");
    const { container } = render(<HandAdapter patch={big} filePath="src/wide.ts" wrap />);
    await settle();
    const all = windows(container);
    expect(all.length).toBeGreaterThan(200); // 4,000 characters of text a window: about 10 rows
    let peak = container.querySelectorAll("*").length;
    for (let i = 1; i < all.length; i++) {
      await intersect(all[i]!, true);
      all[i - 1]!.getBoundingClientRect = () => ({ height: 200 }) as DOMRect;
      await intersect(all[i - 1]!, false);
      if (i % 25 === 0) await settle(); // let the highlight land too, so its spans are counted
      const nodes = container.querySelectorAll("*").length;
      peak = Math.max(peak, nodes);
      expect(nodes).toBeLessThanOrEqual(5000);
    }
    expect(peak).toBeLessThanOrEqual(5000);
    expect(states(container).filter((s) => s === "on")).toHaveLength(1);
  }, 60_000);
});

describe("revealLine mounts the window first", () => {
  const patch = addedFile(150);

  it("mounts the target's window and scrolls its row into view", async () => {
    const scrolled: Element[] = [];
    const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    try {
      const { container, rerender } = render(<HandAdapter patch={patch} filePath="src/big.ts" wrap />);
      expect(states(container)).toEqual(["on", "off", "off"]);
      rerender(<HandAdapter patch={patch} filePath="src/big.ts" wrap revealLine={{ side: "new", line: 100, key: 1 }} />);
      expect(states(container)).toEqual(["on", "on", "off"]); // line 100 is in the second window (rows 60 to 119)
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0]!.getAttribute("data-new-line")).toBe("100");
      expect(spy).toHaveBeenCalledWith({ block: "center" });
    } finally {
      spy.mockRestore();
    }
  });

  it("scrolls once per key, and again for a new key", async () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
    try {
      const { rerender } = render(<HandAdapter patch={patch} filePath="src/big.ts" wrap revealLine={{ side: "new", line: 10, key: 1 }} />);
      expect(spy).toHaveBeenCalledTimes(1);
      rerender(<HandAdapter patch={patch} filePath="src/big.ts" wrap revealLine={{ side: "new", line: 10, key: 1 }} />);
      expect(spy).toHaveBeenCalledTimes(1);
      rerender(<HandAdapter patch={patch} filePath="src/big.ts" wrap revealLine={{ side: "new", line: 140, key: 2 }} />);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("does nothing for a line the patch does not draw", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
    try {
      const { container } = render(<HandAdapter patch={patch} filePath="src/big.ts" wrap revealLine={{ side: "old", line: 5, key: 1 }} />);
      expect(spy).not.toHaveBeenCalled();
      expect(states(container)).toEqual(["on", "off", "off"]);
    } finally {
      spy.mockRestore();
    }
  });
});
