// From web/src/hooks/use-display-prefs.ts: the per-device display prefs, in v1's own key (same origin),
// so a choice made in either UI holds in both. web2 uses one of v1's fields, `showThinking` (the
// timeline's thought rows). The others (raw terminal, tap to type, show terminal) are v1 pane-screen
// prefs with no web2 meaning; they are kept as stored, never dropped. The Terminal tab's text size is
// T13's own (rightPanelStore). A module store, so the timeline and Settings agree without a reload.
import { useSyncExternalStore } from "react";

export const DISPLAY_PREFS_KEY = "sightr:display-prefs:v6";

export interface DisplayPrefs {
  /** Show model thought traces in the timeline (default on, as v1). */
  showThinking: boolean;
}

const DEFAULTS: DisplayPrefs = { showThinking: true };

function readRaw(): Record<string, unknown> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(DISPLAY_PREFS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function load(): DisplayPrefs {
  const p = readRaw();
  return { showThinking: typeof p.showThinking === "boolean" ? p.showThinking : DEFAULTS.showThinking };
}

let prefs: DisplayPrefs = load();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const snapshot = () => prefs;

export function useDisplayPrefs(): DisplayPrefs {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function setDisplayPref<K extends keyof DisplayPrefs>(key: K, value: DisplayPrefs[K]): void {
  prefs = { ...prefs, [key]: value };
  try {
    localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify({ ...readRaw(), [key]: value }));
  } catch {
    // Private mode: the pref lasts this page only.
  }
  for (const fn of listeners) fn();
}

/** Test helper: re-read storage, as a reload would. */
export function __reloadDisplayPrefs(): void {
  prefs = load();
  for (const fn of listeners) fn();
}
