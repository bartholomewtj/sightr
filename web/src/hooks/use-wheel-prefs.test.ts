import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  coerceWheelPrefs,
  STORAGE_KEY,
  useWheelPrefs,
} from "./use-wheel-prefs";
import { MAX_SLICES } from "@/lib/wheel";

describe("coerceWheelPrefs", () => {
  it("defaults an empty object or invalid types to empty picks", () => {
    expect(coerceWheelPrefs({})).toEqual({ picks: [] });
    expect(coerceWheelPrefs(null)).toEqual({ picks: [] });
    expect(coerceWheelPrefs("not-an-object")).toEqual({ picks: [] });
    expect(coerceWheelPrefs({ picks: "not-an-array" })).toEqual({ picks: [] });
  });

  it("filters non-strings, dedupes, and caps at MAX_SLICES", () => {
    const raw = {
      picks: [
        "p1",
        123,
        null,
        "p2",
        "p1",
        "p3",
        "p4",
        "p5",
        "p6",
        "p7",
      ],
    };
    const coerced = coerceWheelPrefs(raw);
    expect(coerced.picks).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    expect(coerced.picks).toHaveLength(MAX_SLICES);
  });
});

describe("useWheelPrefs", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to no picks on a clean localStorage", () => {
    const { result } = renderHook(() => useWheelPrefs());
    expect(result.current.picks).toEqual([]);
    expect(result.current.full).toBe(false);
  });

  it("toggle adds, toggle again removes, and the value survives a remount", () => {
    const first = renderHook(() => useWheelPrefs());
    act(() => first.result.current.toggle("keys:ctrl+c"));
    expect(first.result.current.picks).toEqual(["keys:ctrl+c"]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      picks: ["keys:ctrl+c"],
    });

    // Remount
    const second = renderHook(() => useWheelPrefs());
    expect(second.result.current.picks).toEqual(["keys:ctrl+c"]);

    // Toggle again removes
    act(() => second.result.current.toggle("keys:ctrl+c"));
    expect(second.result.current.picks).toEqual([]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      picks: [],
    });
  });

  it("corrupt JSON in the key -> defaults, no throw", () => {
    localStorage.setItem(STORAGE_KEY, "invalid{json");
    const { result } = renderHook(() => useWheelPrefs());
    expect(result.current.picks).toEqual([]);
    expect(result.current.full).toBe(false);
  });

  it("six picks; a seventh toggle is ignored and full is true", () => {
    const { result } = renderHook(() => useWheelPrefs());
    for (let i = 1; i <= 6; i++) {
      act(() => result.current.toggle(`pick-${i}`));
    }
    expect(result.current.picks).toHaveLength(6);
    expect(result.current.full).toBe(true);

    // Seventh toggle
    act(() => result.current.toggle("pick-7"));
    expect(result.current.picks).toHaveLength(6);
    expect(result.current.picks).not.toContain("pick-7");
    expect(result.current.full).toBe(true);
  });

  it("clear() empties picks", () => {
    const { result } = renderHook(() => useWheelPrefs());
    act(() => result.current.toggle("keys:ctrl+c"));
    act(() => result.current.toggle("keys:ctrl+d"));
    expect(result.current.picks).toEqual(["keys:ctrl+c", "keys:ctrl+d"]);

    act(() => result.current.clear());
    expect(result.current.picks).toEqual([]);
    expect(result.current.full).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      picks: [],
    });
  });
});
