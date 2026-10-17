import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachScrollMemory, forgetScroll, RESTORE_GIVE_UP_MS, rememberedScroll } from "./use-scroll-memory";

/** A scroller whose scrollTop clamps to its content like a real one. */
function scroller(contentHeight: number, viewport = 300) {
  const el = document.createElement("div");
  let top = 0;
  let content = contentHeight;
  Object.defineProperty(el, "scrollHeight", { get: () => content });
  Object.defineProperty(el, "clientHeight", { get: () => viewport });
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, content - viewport));
    },
  });
  document.body.append(el);
  return {
    el,
    grow: (to: number) => {
      content = to;
      el.append(document.createElement("p")); // the mutation the observer hears
    },
    scrollTo: (v: number) => {
      el.scrollTop = v;
      el.dispatchEvent(new Event("scroll"));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  forgetScroll();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("scroll memory", () => {
  it("records where the operator scrolled and puts it back on the next mount", () => {
    const first = scroller(2000);
    const detach = attachScrollMemory(first.el, "git:t1");
    first.scrollTo(640);
    detach();
    expect(rememberedScroll("git:t1")).toBe(640);

    const second = scroller(2000);
    attachScrollMemory(second.el, "git:t1");
    expect(second.el.scrollTop).toBe(640);
  });

  it("waits for async content to grow tall enough, and does not record the climb", async () => {
    const first = scroller(2000);
    attachScrollMemory(first.el, "files:t1");
    first.scrollTo(900);

    const second = scroller(300); // listing not here yet
    attachScrollMemory(second.el, "files:t1");
    expect(second.el.scrollTop).toBe(0);
    second.el.dispatchEvent(new Event("scroll")); // a clamped scroll event must not overwrite the memory
    expect(rememberedScroll("files:t1")).toBe(900);
    second.grow(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.el.scrollTop).toBe(900);
  });

  it("lets the operator win: a touch cancels the restore", async () => {
    const first = scroller(2000);
    attachScrollMemory(first.el, "k");
    first.scrollTo(500);
    const second = scroller(300);
    attachScrollMemory(second.el, "k");
    second.el.dispatchEvent(new Event("touchstart"));
    second.grow(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.el.scrollTop).toBe(0);
  });

  it("gives up after a while", async () => {
    const first = scroller(2000);
    attachScrollMemory(first.el, "k");
    first.scrollTo(500);
    const second = scroller(300);
    attachScrollMemory(second.el, "k");
    await vi.advanceTimersByTimeAsync(RESTORE_GIVE_UP_MS + 1);
    second.grow(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.el.scrollTop).toBe(0);
  });

  it("keeps keys apart", () => {
    const a = scroller(2000);
    attachScrollMemory(a.el, "git:t1");
    a.scrollTo(100);
    expect(rememberedScroll("git:t2")).toBe(0);
  });
});
