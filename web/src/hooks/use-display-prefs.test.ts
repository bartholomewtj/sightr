import { renderHook, act } from "@testing-library/react";
import { useDisplayPrefs } from "./use-display-prefs";

// Minimal localStorage stub — Vitest/jsdom includes a real one but this ensures it's clean per test.
const STORAGE_KEY = "sightr:display-prefs:v6";
const LEGACY_KEY = "sightr:display-prefs:v5";

describe("useDisplayPrefs", () => {
  beforeEach(() => localStorage.clear());

  it("returns defaults when localStorage is empty", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ fontSize: 12, rawTerminal: true, tapToFocus: true, showTerminal: false, showThinking: true });
  });

  it("loads persisted prefs from localStorage on mount", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 14, rawTerminal: true, tapToFocus: false, showTerminal: true }));
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ fontSize: 14, rawTerminal: true, tapToFocus: false, showTerminal: true, showThinking: true });
  });

  it("persists showTerminal and reloads it on mount", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setShowTerminal(true));
    expect(result.current.prefs.showTerminal).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).showTerminal).toBe(true);
    const { result: reloaded } = renderHook(() => useDisplayPrefs());
    expect(reloaded.current.prefs.showTerminal).toBe(true);
  });

  it("persists showThinking and reloads it on mount", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.showThinking).toBe(true);
    act(() => result.current.setShowThinking(false));
    expect(result.current.prefs.showThinking).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).showThinking).toBe(false);
    const { result: reloaded } = renderHook(() => useDisplayPrefs());
    expect(reloaded.current.prefs.showThinking).toBe(false);
  });

  it("persists rawTerminal and reloads it on mount (the choice survives a reload)", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.rawTerminal).toBe(true);
    act(() => result.current.setRawTerminal(false));
    expect(result.current.prefs.rawTerminal).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).rawTerminal).toBe(false);
    const { result: reloaded } = renderHook(() => useDisplayPrefs());
    expect(reloaded.current.prefs.rawTerminal).toBe(false);
  });

  it("persists tapToFocus and reloads it on mount", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs.tapToFocus).toBe(true);
    act(() => result.current.setTapToFocus(false));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).tapToFocus).toBe(false);
    const { result: reloaded } = renderHook(() => useDisplayPrefs());
    expect(reloaded.current.prefs.tapToFocus).toBe(false);
  });

  // The storage key was bumped to v6 to flip the showTerminal default. New fields missing from a v6
  // payload continue to take their defaults without another bump.
  it("reads a pre-tapToFocus payload without discarding the prefs it does have", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 15, rawTerminal: true }));
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ fontSize: 15, rawTerminal: true, tapToFocus: true, showTerminal: false, showThinking: true });
  });

  it("reads a pre-showThinking payload without discarding existing choices", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ fontSize: 15, rawTerminal: true, tapToFocus: false, showTerminal: true }),
    );
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({
      fontSize: 15,
      rawTerminal: true,
      tapToFocus: false,
      showTerminal: true,
      showThinking: true,
    });
  });

  // A stored v6 payload missing showTerminal takes the new false default while keeping existing choices.
  it("reads a pre-showTerminal payload without discarding existing choices", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 15, rawTerminal: true, tapToFocus: false }));
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ fontSize: 15, rawTerminal: true, tapToFocus: false, showTerminal: false, showThinking: true });
  });

  it("ignores a leftover wrap key from older installs", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 15, rawTerminal: true, tapToFocus: false, wrap: true }));
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ fontSize: 15, rawTerminal: true, tapToFocus: false, showTerminal: false, showThinking: true });
  });

  it("setFontSize clamps below minimum to 9", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setFontSize(3));
    expect(result.current.prefs.fontSize).toBe(9);
  });

  it("setFontSize clamps above maximum to 16", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.setFontSize(99));
    expect(result.current.prefs.fontSize).toBe(16);
  });

  it("stepFontSize increments within range", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.stepFontSize(2)); // 12 + 2 = 14
    expect(result.current.prefs.fontSize).toBe(14);
  });

  it("stepFontSize does not exceed max", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.stepFontSize(10)); // 12 + 10 = 22 → clamp to 16
    expect(result.current.prefs.fontSize).toBe(16);
  });

  it("stepFontSize does not go below min", () => {
    const { result } = renderHook(() => useDisplayPrefs());
    act(() => result.current.stepFontSize(-10)); // 12 - 10 = 2 → clamp to 9
    expect(result.current.prefs.fontSize).toBe(9);
  });

  it("falls back to defaults on malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "not-json{{{");
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ fontSize: 12, rawTerminal: true, tapToFocus: true, showTerminal: false, showThinking: true });
  });

  it("falls back to defaults when stored value is not an object", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(42));
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({ fontSize: 12, rawTerminal: true, tapToFocus: true, showTerminal: false, showThinking: true });
  });

  it("migrates a v5 payload to v6 taking the new showTerminal default and deletes the v5 key", () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ fontSize: 14, rawTerminal: false, tapToFocus: false, showTerminal: true }),
    );
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({
      fontSize: 14,
      rawTerminal: false,
      tapToFocus: false,
      showTerminal: false,
      showThinking: true,
    });
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      fontSize: 14,
      rawTerminal: false,
      tapToFocus: false,
      showTerminal: false,
      showThinking: true,
    });
  });

  it("prefers a v6 payload over a leftover v5 payload", () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ fontSize: 10, rawTerminal: false, tapToFocus: false, showTerminal: false }),
    );
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ fontSize: 14, rawTerminal: true, tapToFocus: true, showTerminal: true }),
    );
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({
      fontSize: 14,
      rawTerminal: true,
      tapToFocus: true,
      showTerminal: true,
      showThinking: true,
    });
  });

  it("clamps and type-checks values during v5 migration", () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ fontSize: 99, rawTerminal: "yes", tapToFocus: 1 }),
    );
    const { result } = renderHook(() => useDisplayPrefs());
    expect(result.current.prefs).toEqual({
      fontSize: 16,
      rawTerminal: true,
      tapToFocus: true,
      showTerminal: false,
      showThinking: true,
    });
  });
});
