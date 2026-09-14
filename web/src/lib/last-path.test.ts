import { beforeEach, describe, expect, it, vi } from "vitest";
import { rememberPath, restoreOnBoot, restorePath } from "./last-path";

describe("last path", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it.each([
    ["/", "/pane/w1:p1", "/pane/w1:p1"],
    ["/files", "/pane/w1:p1", null],
    ["/", null, null],
    ["/", "/", null],
    ["/", "https://evil.example", null],
  ])("restores only a valid saved path (%s, %s)", (current, saved, expected) => {
    expect(restorePath(current, saved)).toBe(expected);
  });

  it("restores a saved path on relaunch", () => {
    rememberPath("/pane/w1:p1");
    const replace = vi.spyOn(window.history, "replaceState");
    replace.mockClear();
    restoreOnBoot();
    expect(replace).toHaveBeenCalledWith(null, "", "/pane/w1:p1");
  });

  it("does not rewrite a deep-link boot", () => {
    rememberPath("/pane/w1:p1");
    window.history.replaceState(null, "", "/files/src");
    const replace = vi.spyOn(window.history, "replaceState");
    replace.mockClear();
    restoreOnBoot();
    expect(replace).not.toHaveBeenCalled();
  });
});
