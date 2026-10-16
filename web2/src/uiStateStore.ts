/**
 * Shell UI state that outlives a route (T3 keeps the same job in apps/web/src/uiStateStore.ts): the
 * desktop sidebar's width and whether it is shown (mod+b). Both persist per browser. The right panel's
 * state lives in `rightPanelStore.ts` (T13).
 */
import { create } from "zustand";

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 288;
const WIDTH_KEY = "sightr:v2:sidebar-width";
const SIDEBAR_OPEN_KEY = "sightr:v2:sidebar";

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT;
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)));
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the value lives for this page only */
  }
}

interface UiState {
  sidebarWidth: number;
  sidebarOpen: boolean;
  setSidebarWidth(px: number): void;
  setSidebarOpen(open: boolean): void;
}

function initial(): Pick<UiState, "sidebarWidth" | "sidebarOpen"> {
  const stored = read(WIDTH_KEY);
  return {
    sidebarWidth: stored === null ? SIDEBAR_DEFAULT : clampSidebarWidth(Number(stored)),
    sidebarOpen: read(SIDEBAR_OPEN_KEY) !== "closed",
  };
}

export const useUiState = create<UiState>((set) => ({
  ...initial(),
  setSidebarWidth(px) {
    const sidebarWidth = clampSidebarWidth(px);
    write(WIDTH_KEY, String(sidebarWidth));
    set({ sidebarWidth });
  },
  setSidebarOpen(open) {
    write(SIDEBAR_OPEN_KEY, open ? "open" : "closed");
    set({ sidebarOpen: open });
  },
}));

/** Test helper: re-read storage. */
export function __resetUiState(): void {
  useUiState.setState(initial());
}
