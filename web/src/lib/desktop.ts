import { useSyncExternalStore } from "react";

export type DesktopTyping = "composer" | "direct";
export type DesktopLayout = "system" | "on" | "off";
interface DesktopPrefs { layout: DesktopLayout; typing: DesktopTyping; sidebarPx: number; on: boolean }
type StoredPrefs = Omit<DesktopPrefs, "on">;

const STORAGE_KEY = "sightr:desktop:v2";
const OLD_STORAGE_KEY = "sightr:desktop:v1";
const DEFAULT_PREFS: StoredPrefs = { layout: "system", typing: "composer", sidebarPx: 280 };
const DEFAULT_STATE: DesktopPrefs = { ...DEFAULT_PREFS, on: false };
const QUERY = "(min-width: 768px) and (hover: hover) and (pointer: fine)";
let prefs: StoredPrefs | undefined;
let snapshot: DesktopPrefs | undefined;
const listeners = new Set<() => void>();
let mediaQuery: MediaQueryList | undefined;
let mediaNotify: (() => void) | undefined;

function systemOn(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY)?.matches ?? false;
}
function clampSidebar(value: unknown): number {
  return Math.min(480, Math.max(200, typeof value === "number" && Number.isFinite(value) ? value : 280));
}
function parse(raw: string | null): StoredPrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPrefs> & { on?: boolean };
    const layout: DesktopLayout = parsed.layout === "on" || parsed.layout === "off" || parsed.layout === "system"
      ? parsed.layout : parsed.on === true ? "on" : "system";
    return { layout, typing: parsed.typing === "direct" ? "direct" : "composer", sidebarPx: clampSidebar(parsed.sidebarPx) };
  } catch { return { ...DEFAULT_PREFS }; }
}
function load(): StoredPrefs {
  if (typeof localStorage === "undefined") return { ...DEFAULT_PREFS };
  let currentRaw: string | null = null;
  try { currentRaw = localStorage.getItem(STORAGE_KEY); } catch { return { ...DEFAULT_PREFS }; }
  if (currentRaw) return parse(currentRaw);
  let oldRaw: string | null = null;
  try { oldRaw = localStorage.getItem(OLD_STORAGE_KEY); } catch { return { ...DEFAULT_PREFS }; }
  const loaded = parse(oldRaw);
  if (oldRaw) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(loaded));
      try { localStorage.removeItem(OLD_STORAGE_KEY); } catch { /* migration cleanup is best effort */ }
    } catch { /* retain the old key; memory still uses the migrated value */ }
  }
  return loaded;
}
function current(): StoredPrefs { return (prefs ??= load()); }
function getSnapshot(): DesktopPrefs {
  const state = current();
  const on = state.layout === "on" || (state.layout === "system" && systemOn());
  if (!snapshot || snapshot.layout !== state.layout || snapshot.typing !== state.typing || snapshot.sidebarPx !== state.sidebarPx || snapshot.on !== on) snapshot = { ...state, on };
  return snapshot;
}
function unbindMedia(): void {
  if (!mediaQuery || !mediaNotify) return;
  if (mediaQuery.removeEventListener) mediaQuery.removeEventListener("change", mediaNotify);
  else mediaQuery.removeListener?.(mediaNotify);
  mediaQuery = undefined;
  mediaNotify = undefined;
}
function bindMedia(): void {
  if (mediaQuery || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  mediaQuery = window.matchMedia(QUERY);
  if (!mediaQuery) return;
  const notify = () => { snapshot = undefined; listeners.forEach((fn) => fn()); };
  mediaNotify = notify;
  if (mediaQuery.addEventListener) mediaQuery.addEventListener("change", notify);
  else mediaQuery.addListener?.(notify);
}
function save(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current())); } catch { /* memory remains authoritative */ }
  snapshot = undefined;
  listeners.forEach((fn) => fn());
}
export function desktopPrefs(): DesktopPrefs { return getSnapshot(); }
export function setDesktop(on: boolean): void { prefs = { ...current(), layout: on ? "on" : "off" }; save(); }
export function setLayout(layout: DesktopLayout): void { prefs = { ...current(), layout }; save(); }
export function setTyping(typing: DesktopTyping): void { prefs = { ...current(), typing }; save(); }
export function setSidebarPx(sidebarPx: number): void { prefs = { ...current(), sidebarPx: clampSidebar(sidebarPx) }; save(); }
export function useDesktop(): DesktopPrefs {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    if (listeners.size === 1) bindMedia();
    return () => { listeners.delete(fn); if (listeners.size === 0) unbindMedia(); };
  }, desktopPrefs, () => DEFAULT_STATE);
}
export function __resetDesktop(): void { unbindMedia(); prefs = undefined; snapshot = undefined; try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(OLD_STORAGE_KEY); } catch { /* ignore */ } if (listeners.size > 0) bindMedia(); listeners.forEach((fn) => fn()); }
