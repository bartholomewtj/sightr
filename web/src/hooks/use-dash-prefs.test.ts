import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  coerceDashPrefs,
  COLLAPSE_THRESHOLD,
  openForCount,
  useDashPrefs,
} from "./use-dash-prefs";

describe("openForCount", () => {
  it("starts expanded on a small install", () => {
    expect(openForCount(null, 2)).toBe(true);
    expect(openForCount(null, COLLAPSE_THRESHOLD)).toBe(true);
  });

  it("starts collapsed once the list is a wall", () => {
    expect(openForCount(null, COLLAPSE_THRESHOLD + 1)).toBe(false);
    expect(openForCount(null, 45)).toBe(false);
  });

  it("an explicit choice always beats the threshold, in both directions", () => {
    expect(openForCount(true, 45)).toBe(true);
    expect(openForCount(false, 1)).toBe(false);
  });
});

describe("coerceDashPrefs", () => {
  it("defaults an empty object", () => {
    expect(coerceDashPrefs({})).toEqual({
      spaceOpen: {},
      expandedTabs: [],
      shellsOpen: null,
      recentOpen: true,
      recentDir: "newest",
    });
  });

  it("keeps valid values", () => {
    expect(
      coerceDashPrefs({
        spaceOpen: { w1: true, w2: false },
        expandedTabs: ["t1", "t2"],
        shellsOpen: true,
        recentOpen: false,
        recentDir: "oldest",
      }),
    ).toEqual({
      spaceOpen: { w1: true, w2: false },
      expandedTabs: ["t1", "t2"],
      shellsOpen: true,
      recentOpen: false,
      recentDir: "oldest",
    });
  });

  it("rejects a bogus direction rather than trusting it", () => {
    expect(coerceDashPrefs({ recentDir: "sideways" }).recentDir).toBe("newest");
  });

  it("survives garbage", () => {
    expect(coerceDashPrefs(null).recentDir).toBe("newest");
    expect(coerceDashPrefs("nope").recentOpen).toBe(true);
    expect(coerceDashPrefs({ spaceOpen: "yes" }).spaceOpen).toEqual({});
    expect(coerceDashPrefs({ spaceOpen: { w1: "invalid", w2: true } }).spaceOpen).toEqual({ w2: true });
    expect(coerceDashPrefs({ expandedTabs: "nope" }).expandedTabs).toEqual([]);
    expect(coerceDashPrefs({ expandedTabs: [123, "t1", null] }).expandedTabs).toEqual(["t1"]);
    expect(coerceDashPrefs({ shellsOpen: "yes" }).shellsOpen).toBeNull();
  });
});

describe("useDashPrefs", () => {
  beforeEach(() => localStorage.clear());

  it("starts at the defaults", () => {
    const { result } = renderHook(() => useDashPrefs());
    expect(result.current.prefs).toEqual({
      spaceOpen: {},
      expandedTabs: [],
      shellsOpen: null,
      recentOpen: true,
      recentDir: "newest",
    });
  });

  it("persists each setting across a remount", () => {
    const first = renderHook(() => useDashPrefs());
    act(() => first.result.current.setSpaceOpen("w1", true));
    act(() => first.result.current.setTabOpen("t1", true));
    act(() => first.result.current.setShellsOpen(true));
    act(() => first.result.current.setRecentOpen(false));
    act(() => first.result.current.setRecentDir("oldest"));

    const second = renderHook(() => useDashPrefs());
    expect(second.result.current.prefs).toEqual({
      spaceOpen: { w1: true },
      expandedTabs: ["t1"],
      shellsOpen: true,
      recentOpen: false,
      recentDir: "oldest",
    });

    // Toggle tab and expand space
    act(() => second.result.current.toggleTab("t1"));
    act(() => second.result.current.expandSpace("w2"));
    expect(second.result.current.prefs.expandedTabs).toEqual([]);
    expect(second.result.current.prefs.spaceOpen).toEqual({ w1: true, w2: true });
  });

  it("reads back a corrupt stored value as the defaults instead of throwing", () => {
    localStorage.setItem("sightr:dash-prefs:v2", "{not json");
    const { result } = renderHook(() => useDashPrefs());
    expect(result.current.prefs.recentDir).toBe("newest");
  });
});
