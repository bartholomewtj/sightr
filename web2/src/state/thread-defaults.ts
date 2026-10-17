/**
 * The operator's new-thread defaults and model list, per device (localStorage, try/catch). Settings →
 * New threads edits it; the new-thread draft (state/draft-thread.ts) reads it when a harness or project is
 * chosen, and the model picker reads the list. The rules are pure, in
 * components/new-thread/ThreadDefaults.logic.ts. Nothing here goes to the bridge.
 */
import { create } from "zustand";

import {
  addCustomModel,
  EMPTY_THREAD_DEFAULTS,
  removeCustomModel,
  sanitizePrefs,
  setDefaultHarness,
  setHarnessDefault,
  toggleFavourite,
  toggleHidden,
  type HarnessDefaults,
  type ThreadDefaultsPrefs,
} from "@/components/new-thread/ThreadDefaults.logic";

export const THREAD_DEFAULTS_KEY = "sightr:v2:new-thread:defaults";

function load(): ThreadDefaultsPrefs {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(THREAD_DEFAULTS_KEY);
    return raw ? sanitizePrefs(JSON.parse(raw) as unknown) : EMPTY_THREAD_DEFAULTS;
  } catch {
    return EMPTY_THREAD_DEFAULTS;
  }
}

export const useThreadDefaults = create<ThreadDefaultsPrefs>(load);

useThreadDefaults.subscribe((s, prev) => {
  if (s === prev) return;
  try {
    const { harness, perHarness, models } = s;
    localStorage.setItem(THREAD_DEFAULTS_KEY, JSON.stringify({ harness, perHarness, models }));
  } catch {
    // private mode or full: the defaults last this page only
  }
});

const get = () => useThreadDefaults.getState();
const replace = (next: ThreadDefaultsPrefs) => {
  if (next !== get()) useThreadDefaults.setState(next, true);
};

export const getThreadDefaults = (): ThreadDefaultsPrefs => get();

export function setDefaultHarnessPref(harness: string | null): void {
  replace(setDefaultHarness(get(), harness));
}

export function setHarnessDefaultPref(harness: string, patch: Partial<HarnessDefaults>): void {
  replace(setHarnessDefault(get(), harness, patch));
}

/** Add a model id to a harness's list; returns the reason when it is refused. */
export function addModelPref(harness: string, id: string): string | null {
  const res = addCustomModel(get(), harness, id);
  if ("error" in res) return res.error;
  replace(res.prefs);
  return null;
}

export function toggleFavouriteModelPref(harness: string, id: string): void {
  replace(toggleFavourite(get(), harness, id));
}

export function toggleHiddenModelPref(harness: string, id: string): void {
  replace(toggleHidden(get(), harness, id));
}

export function removeModelPref(harness: string, id: string): void {
  replace(removeCustomModel(get(), harness, id));
}

/** Test helper: re-read storage, as a reload would. */
export function __resetThreadDefaults(): void {
  useThreadDefaults.setState(load(), true);
}
