// attachAnchorMemory (T27): the scroll position comes back as a file plus an offset into it, a restore waits for
// content that arrives late, gives way to the operator's first touch and to a reveal, and only records when told
// not to restore. jsdom has no layout, so the scroller and its sections get a tiny one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetDiffMemory, attachAnchorMemory, readAnchor, readDiffMemory, writeDiffMemory, ANCHOR_GIVE_UP_MS } from "./diffPanelMemory";

const KEY = "diff:t1:w";
const sleep = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const detach: Array<() => void> = [];

/** A scroller of sections `a` (0), `b` (500), `c` (1500) tall as listed; `scrollTop` is a plain property. */
function scroller(tops: Record<string, number> = { a: 0, b: 500, c: 1500 }): { el: HTMLElement; add: (path: string, top: number) => void } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  el.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 300, width: 300, height: 600, x: 0, y: 0, toJSON: () => ({}) });
  const add = (path: string, top: number) => {
    const s = document.createElement("section");
    s.dataset.diffFile = path;
    s.getBoundingClientRect = () => {
      const t = top - el.scrollTop;
      return { top: t, bottom: t + 400, left: 0, right: 300, width: 300, height: 400, x: 0, y: t, toJSON: () => ({}) };
    };
    el.appendChild(s);
  };
  for (const [path, top] of Object.entries(tops)) add(path, top);
  return { el, add };
}

beforeEach(() => __resetDiffMemory());
afterEach(() => {
  for (const d of detach.splice(0)) d();
  document.body.replaceChildren();
});

function attach(el: HTMLElement, opts?: { restore?: boolean }) {
  const m = attachAnchorMemory(el, KEY, opts);
  detach.push(m.detach);
  return m;
}

describe("attachAnchorMemory", () => {
  it("restores the remembered file and offset: the section's top plus how far into it", () => {
    writeDiffMemory(KEY, { anchor: { path: "b", offset: 40 } });
    const { el } = scroller();
    attach(el);
    expect(el.scrollTop).toBe(540);
  });

  it("waits for a section that arrives late, then restores", async () => {
    writeDiffMemory(KEY, { anchor: { path: "late", offset: 10 } });
    const { el, add } = scroller({ a: 0 });
    attach(el);
    expect(el.scrollTop).toBe(0);
    add("late", 900);
    await sleep();
    expect(el.scrollTop).toBe(910);
  });

  it("restores nothing when nothing was remembered", () => {
    const { el } = scroller();
    attach(el);
    expect(el.scrollTop).toBe(0);
  });

  it("gives up after a while on a file that never comes, so a late arrival no longer moves the page", async () => {
    vi.useFakeTimers();
    try {
      writeDiffMemory(KEY, { anchor: { path: "never", offset: 0 } });
      const { el, add } = scroller({ a: 0 });
      attach(el);
      vi.advanceTimersByTime(ANCHOR_GIVE_UP_MS + 10);
      add("never", 700);
      await vi.advanceTimersByTimeAsync(50);
      expect(el.scrollTop).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the operator's first touch ends the restore", async () => {
    writeDiffMemory(KEY, { anchor: { path: "late", offset: 0 } });
    const { el, add } = scroller({ a: 0 });
    attach(el);
    el.dispatchEvent(new Event("wheel"));
    add("late", 900);
    await sleep();
    expect(el.scrollTop).toBe(0);
  });

  it("a reveal wins: stopRestoring cancels a restore that is waiting, and the file the reveal scrolled to stays", async () => {
    writeDiffMemory(KEY, { anchor: { path: "late", offset: 0 } });
    const { el, add } = scroller({ a: 0 });
    const m = attach(el);
    m.stopRestoring(); // the reveal arrived
    el.scrollTop = 321; // what scrollIntoView did
    add("late", 900);
    await sleep();
    expect(el.scrollTop).toBe(321);
  });

  it("a reveal wins: with restore false it never moves the scroller, and still records where the operator goes", async () => {
    writeDiffMemory(KEY, { anchor: { path: "b", offset: 40 } });
    const { el } = scroller();
    attach(el, { restore: false });
    expect(el.scrollTop).toBe(0);
    el.scrollTop = 1600; // inside c, 100 down
    el.dispatchEvent(new Event("scroll"));
    await sleep(60);
    expect(readDiffMemory(KEY).anchor).toEqual({ path: "c", offset: 100 });
  });

  it("records the file at the top and the offset into it as the scroller moves, not a raw scrollTop", async () => {
    const { el } = scroller();
    attach(el);
    el.scrollTop = 620; // 120 into b
    el.dispatchEvent(new Event("scroll"));
    await sleep(60);
    expect(readDiffMemory(KEY).anchor).toEqual({ path: "b", offset: 120 });
  });

  it("does not record while the restore itself is scrolling", async () => {
    writeDiffMemory(KEY, { anchor: { path: "late", offset: 0 } });
    const { el } = scroller({ a: 0 });
    attach(el);
    el.scrollTop = 50;
    el.dispatchEvent(new Event("scroll"));
    await sleep(60);
    expect(readDiffMemory(KEY).anchor).toEqual({ path: "late", offset: 0 });
  });

  it("readAnchor names the first section whose bottom is below the top edge", () => {
    const { el } = scroller();
    el.scrollTop = 450; // a ends at 400, b starts at 500: b is the first not wholly above
    expect(readAnchor(el)).toEqual({ path: "b", offset: 0 });
    el.scrollTop = 0;
    expect(readAnchor(el)).toEqual({ path: "a", offset: 0 });
  });
});
