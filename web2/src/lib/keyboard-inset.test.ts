import { afterEach, describe, expect, it } from "vitest";

import { KEYBOARD_MIN_PX, keyboardInset, watchKeyboardInset } from "./keyboard-inset";

describe("keyboardInset", () => {
  it("is the gap between the layout viewport's bottom and the visual viewport's bottom", () => {
    expect(keyboardInset(800, { height: 500, offsetTop: 0, scale: 1 })).toBe(300);
    // iOS scrolls the visual viewport to keep the focused field in view: the gap is measured from its bottom.
    expect(keyboardInset(800, { height: 500, offsetTop: 100, scale: 1 })).toBe(200);
  });
  it("is zero with no keyboard, for browser chrome moving, and while pinch-zoomed", () => {
    expect(keyboardInset(800, { height: 800, offsetTop: 0, scale: 1 })).toBe(0);
    expect(keyboardInset(800, { height: 800 - (KEYBOARD_MIN_PX - 1), offsetTop: 0, scale: 1 })).toBe(0);
    expect(keyboardInset(800, { height: 400, offsetTop: 0, scale: 2 })).toBe(0);
  });
});

describe("watchKeyboardInset", () => {
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  afterEach(() => {
    if (original) Object.defineProperty(window, "visualViewport", original);
    else delete (window as { visualViewport?: unknown }).visualViewport;
    document.documentElement.removeAttribute("style");
  });

  function fakeViewport(height: number) {
    const listeners = new Map<string, Set<() => void>>();
    const vv = {
      height,
      offsetTop: 0,
      scale: 1,
      addEventListener: (n: string, fn: () => void) => void (listeners.get(n) ?? listeners.set(n, new Set()).get(n)!).add(fn),
      removeEventListener: (n: string, fn: () => void) => void listeners.get(n)?.delete(fn),
      fire: () => listeners.get("resize")?.forEach((fn) => fn()),
      count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    return vv;
  }

  it("publishes --kb-inset and --kb-open while watched, and clears them when released", () => {
    const vv = fakeViewport(window.innerHeight);
    const root = document.documentElement;
    const release = watchKeyboardInset();
    expect(root.style.getPropertyValue("--kb-inset")).toBe("0px");
    expect(root.style.getPropertyValue("--kb-open")).toBe("0");
    vv.height = window.innerHeight - 300;
    vv.fire();
    expect(root.style.getPropertyValue("--kb-inset")).toBe("300px");
    expect(root.style.getPropertyValue("--kb-open")).toBe("1");
    release();
    expect(root.style.getPropertyValue("--kb-inset")).toBe("");
    expect(vv.count()).toBe(0);
  });

  it("shares one listener between overlapping users", () => {
    const vv = fakeViewport(window.innerHeight);
    const a = watchKeyboardInset();
    const b = watchKeyboardInset();
    expect(vv.count()).toBe(2); // resize + scroll, once
    a();
    expect(vv.count()).toBe(2);
    b();
    b(); // releasing twice is harmless
    expect(vv.count()).toBe(0);
  });

  it("does nothing without a visual viewport", () => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    expect(() => watchKeyboardInset()()).not.toThrow();
  });
});
