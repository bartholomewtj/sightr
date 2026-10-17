import { describe, expect, it } from "vitest";

import { attachPinchZoom, pinchValue } from "./use-pinch-zoom";

describe("pinchValue", () => {
  it("scales with the finger distance and clamps", () => {
    expect(pinchValue(12, 100, 150, 10, 16)).toBe(16);
    expect(pinchValue(12, 100, 50, 10, 16)).toBe(10);
    expect(pinchValue(12, 100, 100, 10, 16)).toBe(12);
    expect(pinchValue(12, 100, 125, 10, 16)).toBe(15);
  });
  it("ignores a degenerate start", () => {
    expect(pinchValue(12, 0, 80, 10, 16)).toBe(12);
  });
});

function touch(type: string, points: [number, number][]): Event {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, "touches", { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
  return e;
}

describe("attachPinchZoom", () => {
  it("changes the value on a two-finger pinch only", () => {
    const el = document.createElement("div");
    let value = 12;
    const detach = attachPinchZoom(el, { get: () => value, set: (v) => (value = v), min: 10, max: 16 });

    el.dispatchEvent(touch("touchstart", [[0, 0]]));
    el.dispatchEvent(touch("touchmove", [[0, 0]]));
    expect(value).toBe(12); // one finger scrolls

    el.dispatchEvent(touch("touchstart", [[0, 0], [100, 0]]));
    el.dispatchEvent(touch("touchmove", [[0, 0], [150, 0]]));
    expect(value).toBe(16);
    el.dispatchEvent(touch("touchmove", [[0, 0], [60, 0]]));
    expect(value).toBe(10);

    el.dispatchEvent(touch("touchend", [[0, 0]]));
    el.dispatchEvent(touch("touchmove", [[0, 0], [100, 0]]));
    expect(value).toBe(10); // the pinch ended

    detach();
    el.dispatchEvent(touch("touchstart", [[0, 0], [100, 0]]));
    el.dispatchEvent(touch("touchmove", [[0, 0], [150, 0]]));
    expect(value).toBe(10);
  });
});
