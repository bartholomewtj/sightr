import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BLANK_CHECK_MS,
  BLANK_CONFIRM_LOOKS,
  BLANK_COOLDOWN_MS,
  BLANK_IDLE_MS,
  useBlankViewportGuard,
  viewportIsBlank,
} from "./useBlankViewportGuard";

const rect = (top: number, bottom: number, width = 400): DOMRect =>
  ({ top, bottom, left: 0, right: width, x: 0, y: top, width, height: bottom - top, toJSON() {} }) as DOMRect;

/** A scroller with a 600 px band at 0..600 and frames at the given [top, bottom] spans. */
function build(frames: Array<[number, number]>, band: [number, number] = [0, 600]) {
  const container = document.createElement("div");
  const scroller = document.createElement("div");
  scroller.className = "messages-timeline-scroll";
  scroller.getBoundingClientRect = () => rect(band[0], band[1], band[1] - band[0] > 0 ? 400 : 0);
  const els = frames.map(([top, bottom]) => {
    const el = document.createElement("div");
    el.className = "messages-timeline-row-frame";
    el.getBoundingClientRect = () => rect(top, bottom);
    scroller.append(el);
    return el;
  });
  container.append(scroller);
  return { container, scroller, els };
}

describe("viewportIsBlank", () => {
  it("is false while any frame touches the band", () => {
    expect(viewportIsBlank(build([[500, 700]]).scroller)).toBe(false);
    expect(viewportIsBlank(build([[-100, 20]]).scroller)).toBe(false);
    expect(viewportIsBlank(build([[-100, 900]]).scroller)).toBe(false); // one row taller than the window
  });

  it("is true when every frame is off the band: the gap the phone showed", () => {
    expect(viewportIsBlank(build([[-4000, -3000], [-3000, -2800], [2600, 3000]]).scroller)).toBe(true);
  });

  it("is false for a list that has drawn nothing yet, and for a scroller with no size", () => {
    expect(viewportIsBlank(build([]).scroller)).toBe(false);
    expect(viewportIsBlank(build([[2000, 2100]], [0, 0]).scroller)).toBe(false);
  });
});

describe("useBlankViewportGuard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(frames: Array<[number, number]>, opts: { enabled?: boolean } = {}) {
    const clock = { now: 100_000 };
    const onBlank = vi.fn();
    const dom = build(frames);
    const hook = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useBlankViewportGuard({ container: dom.container, enabled, onBlank, now: () => clock.now }),
      { initialProps: { enabled: opts.enabled ?? true } },
    );
    /** One look: time moves on by the check interval, then the interval fires. */
    const look = (times = 1) => {
      for (let i = 0; i < times; i++) {
        clock.now += BLANK_CHECK_MS;
        act(() => void vi.advanceTimersByTime(BLANK_CHECK_MS));
      }
    };
    return { ...dom, hook, onBlank, clock, look };
  }

  it("rebuilds the list once two looks in a row find only a gap", () => {
    const { onBlank, look } = setup([[3000, 3200]]);
    look();
    expect(onBlank).not.toHaveBeenCalled();
    look(BLANK_CONFIRM_LOOKS - 1);
    expect(onBlank).toHaveBeenCalledTimes(1);
  });

  it("does nothing while a row is on screen, and one good look forgets an earlier bad one", () => {
    const { onBlank, look, els } = setup([[3000, 3200]]);
    look();
    els[0]!.getBoundingClientRect = () => rect(100, 300);
    look(4);
    expect(onBlank).not.toHaveBeenCalled();
    els[0]!.getBoundingClientRect = () => rect(3000, 3200);
    look();
    expect(onBlank).not.toHaveBeenCalled(); // the count started over
  });

  it("leaves a list that is being scrolled alone: a fling is allowed to blank for a moment", () => {
    const { onBlank, look, scroller, clock } = setup([[3000, 3200]]);
    const scrollJustNow = () => {
      clock.now += 1; // the scroll event stamps the (fake) clock
      scroller.dispatchEvent(new Event("scroll"));
    };
    look(2);
    expect(onBlank).toHaveBeenCalledTimes(1);
    onBlank.mockClear();
    clock.now += BLANK_COOLDOWN_MS;
    // A scroll just before each look keeps the list "moving", so the looks do not count.
    for (let i = 0; i < 4; i++) {
      scrollJustNow();
      clock.now += BLANK_IDLE_MS - 50;
      act(() => void vi.advanceTimersByTime(BLANK_CHECK_MS));
    }
    expect(onBlank).not.toHaveBeenCalled();
  });

  it("waits for a finger to lift", () => {
    const { onBlank, look, scroller } = setup([[3000, 3200]]);
    scroller.dispatchEvent(new Event("touchstart", { bubbles: true }));
    look(6);
    expect(onBlank).not.toHaveBeenCalled();
    scroller.dispatchEvent(new Event("touchend", { bubbles: true }));
    look(2 + Math.ceil(BLANK_IDLE_MS / BLANK_CHECK_MS));
    expect(onBlank).toHaveBeenCalledTimes(1);
  });

  it("acts once per cooldown, so a cause the rebuild cannot cure does not loop", () => {
    const { onBlank, look } = setup([[3000, 3200]]);
    look(2);
    expect(onBlank).toHaveBeenCalledTimes(1);
    look(Math.floor(BLANK_COOLDOWN_MS / BLANK_CHECK_MS) - 3);
    expect(onBlank).toHaveBeenCalledTimes(1);
    look(6);
    expect(onBlank).toHaveBeenCalledTimes(2);
  });

  it("is off with no rows, and while the page is hidden", () => {
    const off = setup([[3000, 3200]], { enabled: false });
    off.look(6);
    expect(off.onBlank).not.toHaveBeenCalled();
    off.hook.unmount();

    const hidden = setup([[3000, 3200]]);
    const spy = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    hidden.look(6);
    expect(hidden.onBlank).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
