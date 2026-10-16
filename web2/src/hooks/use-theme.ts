// Copied from web/src/hooks/use-theme.ts (same storage key, same origin), adapted to web2's dark
// default (style/tokens.md, recipe console):
// - absent or "dark" → dark, no class; "light" → `.light`; "system" → `.system`, which index.css turns
//   into `color-scheme: light dark` so the OS picks the half.
// - v1 removes the key for its System, so a v1 System user sees web2's dark until they pick System
//   here. web2 writes "system" as a bare string, which v1 also reads as System.
// The visual switch is CSS (every token is light-dark()); this owns the class on <html> and the
// theme-color meta. State lives at module scope so every reader agrees and the OS listener survives
// remounts.
import { useCallback, useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "sightr:theme:v1";
const DEFAULT: Theme = "dark";

/** Browser chrome (Android's URL bar, the task switcher): --paper's two halves in index.css. */
const META_COLOR: Record<ResolvedTheme, string> = { light: "#f4f5f6", dark: "#171b21" };

/** Bare string, not JSON: public/theme-init.js does the same strict compare before first paint. */
function loadTheme(): Theme {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(THEME_STORAGE_KEY) : null;
    return raw === "light" || raw === "dark" || raw === "system" ? raw : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function saveTheme(theme: Theme): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode: the theme still applies for this page.
  }
}

function darkMediaQuery(): MediaQueryList | null {
  return typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
}

function prefersDark(): boolean {
  return darkMediaQuery()?.matches ?? false;
}

function apply(theme: Theme, resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("light", "dark", "system");
  if (theme !== "dark") root.classList.add(theme);
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = META_COLOR[resolved];
  });
}

export interface ThemeState {
  /** What the operator chose. */
  theme: Theme;
  /** What that renders as now: `system` resolved against the OS. */
  resolved: ResolvedTheme;
}

function computeState(theme: Theme): ThemeState {
  return { theme, resolved: theme === "system" ? (prefersDark() ? "dark" : "light") : theme };
}

let state: ThemeState = computeState(loadTheme());
const listeners = new Set<() => void>();

function refresh(theme: Theme): void {
  state = computeState(theme);
  apply(state.theme, state.resolved);
  for (const listener of listeners) listener();
}

apply(state.theme, state.resolved);

// Follow the OS while on System, so the meta colour and readouts stay honest without a reload.
darkMediaQuery()?.addEventListener("change", () => {
  if (state.theme === "system") refresh("system");
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ThemeState {
  return state;
}

export interface UseThemeReturn extends ThemeState {
  setTheme: (theme: Theme) => void;
}

export function useTheme(): UseThemeReturn {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setTheme = useCallback((theme: Theme) => {
    saveTheme(theme);
    refresh(theme);
  }, []);
  return { ...snapshot, setTheme };
}

/** Test helper: re-read the stored theme (as a reload would) and re-apply it. */
export function __reloadTheme(): void {
  refresh(loadTheme());
}
