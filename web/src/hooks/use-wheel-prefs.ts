import { useCallback, useState } from "react";
import { MAX_SLICES } from "@/lib/wheel";

// Gesture wheel slice preferences, persisted in localStorage.
// Freshness contract: prefs load on mount. The wheel is phone-only and the pane route unmounts
// when you navigate to Settings, so a change is picked up the next time the composer mounts.
// No cross-component store needed.
// Safe to call in SSR contexts (localStorage guarded throughout).

export interface WheelPrefs {
  picks: string[];
}

export const STORAGE_KEY = "sightr:wheel-prefs:v1";

export function coerceWheelPrefs(raw: unknown): WheelPrefs {
  if (typeof raw !== "object" || raw === null) {
    return { picks: [] };
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.picks)) {
    return { picks: [] };
  }
  const picks: string[] = [];
  const seen = new Set<string>();
  for (const item of obj.picks) {
    if (typeof item === "string" && !seen.has(item)) {
      seen.add(item);
      picks.push(item);
      if (picks.length >= MAX_SLICES) break;
    }
  }
  return { picks };
}

function loadPrefs(): WheelPrefs {
  try {
    if (typeof localStorage === "undefined") return { picks: [] };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { picks: [] };
    return coerceWheelPrefs(JSON.parse(raw));
  } catch {
    return { picks: [] };
  }
}

function savePrefs(prefs: WheelPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    }
  } catch {
    // Ignore quota / SSR write errors.
  }
}

export interface UseWheelPrefsReturn {
  picks: readonly string[];
  toggle: (id: string) => void;
  clear: () => void;
  full: boolean;
}

export function useWheelPrefs(): UseWheelPrefsReturn {
  const [prefs, setPrefs] = useState<WheelPrefs>(loadPrefs);

  const toggle = useCallback((id: string) => {
    setPrefs((prev) => {
      const exists = prev.picks.includes(id);
      let nextPicks: string[];
      if (exists) {
        nextPicks = prev.picks.filter((p) => p !== id);
      } else {
        if (prev.picks.length >= MAX_SLICES) {
          return prev;
        }
        nextPicks = [...prev.picks, id];
      }
      const next: WheelPrefs = { picks: nextPicks };
      savePrefs(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    const next: WheelPrefs = { picks: [] };
    savePrefs(next);
    setPrefs(next);
  }, []);

  return {
    picks: prefs.picks,
    toggle,
    clear,
    full: prefs.picks.length >= MAX_SLICES,
  };
}
