import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMidEntry, RELOAD_DEFER_MAX_MS, reloadWhenIdle } from "./reload-when-idle";

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const deps = () => ({
  document,
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
});

function typeInto(value: string): HTMLTextAreaElement {
  const ta = document.createElement("textarea");
  document.body.append(ta);
  ta.value = value;
  ta.focus();
  return ta;
}

describe("reloadWhenIdle", () => {
  it("reloads at once when nobody is typing", () => {
    const reload = vi.fn();
    reloadWhenIdle(reload, deps());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not count an empty focused field as typing", () => {
    typeInto("");
    expect(isMidEntry(document)).toBe(false);
  });

  it("waits while a field holds text, then reloads when it is cleared", async () => {
    const ta = typeInto("half a mess");
    const reload = vi.fn();
    reloadWhenIdle(reload, deps());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reload).not.toHaveBeenCalled();
    ta.value = "";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("waits while direct typing is armed", async () => {
    const strip = document.createElement("div");
    strip.dataset.directTyping = "armed";
    document.body.append(strip);
    const reload = vi.fn();
    reloadWhenIdle(reload, deps());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reload).not.toHaveBeenCalled();
    strip.remove();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads when the page is hidden, even mid-entry", () => {
    typeInto("draft");
    const reload = vi.fn();
    reloadWhenIdle(reload, deps());
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("gives up waiting after the cap, and only reloads once", async () => {
    typeInto("draft");
    const reload = vi.fn();
    reloadWhenIdle(reload, deps());
    await vi.advanceTimersByTimeAsync(RELOAD_DEFER_MAX_MS + 2_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
