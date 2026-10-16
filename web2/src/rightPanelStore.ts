// Same job and name as T3 Code apps/web/src/rightPanelStore.ts @ e3b35d1b (pattern; MIT, see
// THIRD_PARTY.md). T3 keeps an open/closed panel with a list of surfaces per thread; Sightr's panel has
// three fixed tabs (Terminal, Files, Git) and, per the T13 spec, its open state, active tab and width
// are per-device preferences rather than per thread. On a phone the same tabs open as one sheet at a
// time. T3's action names are kept where the job is the same (`open`, `toggle`, `close`, `show`,
// `toggleVisibility`).
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { DESKTOP_QUERY } from "@/hooks/useLayout";

export const RIGHT_PANEL_KINDS = ["terminal", "files", "git"] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

export const RIGHT_PANEL_LABEL: Record<RightPanelKind, string> = { terminal: "Terminal", files: "Files", git: "Git" };

export const RIGHT_PANEL_MIN = 320;
export const RIGHT_PANEL_MAX = 720;
export const RIGHT_PANEL_DEFAULT = 420;
const RIGHT_PANEL_STORAGE_KEY = "sightr:v2:right-panel-state:v1";
export const TERMINAL_FONT_MIN = 10;
export const TERMINAL_FONT_MAX = 16;
export const TERMINAL_FONT_DEFAULT = 12;

export function clampTerminalFont(px: number): number {
  if (!Number.isFinite(px)) return TERMINAL_FONT_DEFAULT;
  return Math.round(Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, px)));
}

export function clampRightPanelWidth(px: number): number {
  if (!Number.isFinite(px)) return RIGHT_PANEL_DEFAULT;
  return Math.round(Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, px)));
}

/** A request for the Terminal tab to arm direct typing (T12's password flow, or ctrl+`). */
export interface DirectTypingRequest {
  id: number;
  threadId: string;
  /** The prompt the strip names (a password request). */
  prompt?: string;
}

interface RightPanelStoreState {
  /** Desktop: the panel is shown. */
  isOpen: boolean;
  activeSurfaceId: RightPanelKind;
  width: number;
  /** The Terminal tab's font size (10–16 px), per device. */
  terminalFontSize: number;
  /** Phone: the one open sheet. Never persisted. */
  sheet: RightPanelKind | null;
  directTyping: DirectTypingRequest | null;
  open: (kind: RightPanelKind) => void;
  toggle: (kind: RightPanelKind) => void;
  show: () => void;
  close: () => void;
  toggleVisibility: () => void;
  setWidth: (px: number) => void;
  setTerminalFontSize: (px: number) => void;
  openSheet: (kind: RightPanelKind) => void;
  closeSheet: () => void;
  requestDirectTyping: (threadId: string, prompt?: string) => void;
  consumeDirectTyping: (id: number) => void;
}

/** localStorage behind try/catch: a private window keeps the state for the page only. */
const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      /* memory stays authoritative */
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

let nextRequestId = 1;

const initial = () => ({
  isOpen: true,
  activeSurfaceId: "terminal" as RightPanelKind,
  width: RIGHT_PANEL_DEFAULT,
  terminalFontSize: TERMINAL_FONT_DEFAULT,
  sheet: null,
  directTyping: null,
});

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set, get) => ({
      ...initial(),
      open: (kind) => set({ isOpen: true, activeSurfaceId: kind }),
      toggle: (kind) => {
        const { isOpen, activeSurfaceId } = get();
        set(isOpen && activeSurfaceId === kind ? { isOpen: false } : { isOpen: true, activeSurfaceId: kind });
      },
      show: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
      toggleVisibility: () => set({ isOpen: !get().isOpen }),
      setWidth: (px) => set({ width: clampRightPanelWidth(px) }),
      setTerminalFontSize: (px) => set({ terminalFontSize: clampTerminalFont(px) }),
      openSheet: (kind) => set({ sheet: kind, activeSurfaceId: kind }),
      closeSheet: () => set({ sheet: null }),
      requestDirectTyping: (threadId, prompt) =>
        set({ directTyping: { id: nextRequestId++, threadId, ...(prompt ? { prompt } : {}) } }),
      consumeDirectTyping: (id) => {
        if (get().directTyping?.id === id) set({ directTyping: null });
      },
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => ({ isOpen: s.isOpen, activeSurfaceId: s.activeSurfaceId, width: s.width, terminalFontSize: s.terminalFontSize }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<RightPanelStoreState>;
        return {
          ...current,
          ...(typeof p.isOpen === "boolean" ? { isOpen: p.isOpen } : {}),
          ...(p.activeSurfaceId && RIGHT_PANEL_KINDS.includes(p.activeSurfaceId) ? { activeSurfaceId: p.activeSurfaceId } : {}),
          ...(typeof p.width === "number" ? { width: clampRightPanelWidth(p.width) } : {}),
          ...(typeof p.terminalFontSize === "number" ? { terminalFontSize: clampTerminalFont(p.terminalFontSize) } : {}),
        };
      },
    },
  ),
);

function isDesktopLayout(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DESKTOP_QUERY).matches;
}

/** Open a tab where this layout shows it: the desktop panel, or a phone sheet. */
export function openRightPanelSurface(kind: RightPanelKind): void {
  const store = useRightPanelStore.getState();
  if (isDesktopLayout()) store.open(kind);
  else store.openSheet(kind);
}

/** mod+j and friends: open the tab, or close it when it is already the one showing. */
export function toggleRightPanelSurface(kind: RightPanelKind): void {
  const store = useRightPanelStore.getState();
  if (isDesktopLayout()) store.toggle(kind);
  else if (store.sheet === kind) store.closeSheet();
  else store.openSheet(kind);
}

/** The panel or a sheet is showing. */
export function selectRightPanelOpen(s: Pick<RightPanelStoreState, "isOpen" | "sheet">, desktop: boolean): boolean {
  return desktop ? s.isOpen : s.sheet !== null;
}

/** Test helper: back to defaults, storage re-read. */
export function __resetRightPanelStore(): void {
  // setState writes through to storage, so keep what storage held and re-read it after.
  const raw = safeStorage.getItem(RIGHT_PANEL_STORAGE_KEY) as string | null;
  useRightPanelStore.setState(initial());
  if (raw === null) safeStorage.removeItem(RIGHT_PANEL_STORAGE_KEY);
  else safeStorage.setItem(RIGHT_PANEL_STORAGE_KEY, raw);
  void useRightPanelStore.persist.rehydrate();
}
