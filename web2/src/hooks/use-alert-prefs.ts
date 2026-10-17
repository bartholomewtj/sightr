// The per-device "In-app alerts" switch (Settings, Notifications): a toast when another thread needs you
// or finishes, and the app-icon badge count. Default on. Per device on purpose: a desk and a phone want
// different things. A module store, so Settings and the coordinator agree without a reload.
import { useSyncExternalStore } from "react";

export const ALERT_PREFS_KEY = "sightr:web2:in-app-alerts:v1";

function load(): boolean {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(ALERT_PREFS_KEY);
    return raw === null ? true : raw !== "off";
  } catch {
    return true;
  }
}

let enabled = load();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getInAppAlerts(): boolean {
  return enabled;
}

export function useInAppAlerts(): boolean {
  return useSyncExternalStore(subscribe, getInAppAlerts, () => true);
}

export function setInAppAlerts(next: boolean): void {
  enabled = next;
  try {
    localStorage.setItem(ALERT_PREFS_KEY, next ? "on" : "off");
  } catch {
    // Private mode: the choice lasts this page only.
  }
  for (const fn of listeners) fn();
}

/** Test helper: re-read storage, as a reload would. */
export function __reloadAlertPrefs(): void {
  enabled = load();
  for (const fn of listeners) fn();
}
