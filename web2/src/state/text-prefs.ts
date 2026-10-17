/**
 * Text size and code wrapping, per device (localStorage, try/catch), under web2's own key so v1's
 * display prefs (which rewrite their key whole) cannot drop them.
 *
 * - **Text size** is a percentage of the browser's base size, set on the root element: every rem in the
 *   app (chat, composer, sidebar, menus) follows it. The Terminal tab keeps its own pixel size
 *   (rightPanelStore), which has its own stepper and pinch zoom.
 * - **Code wrapping** is the starting state of each code block's own "Wrap lines" toggle in the chat:
 *   `auto` wraps below the `sm` breakpoint (a phone), as before; `wrap` and `scroll` force it.
 */
import { useSyncExternalStore } from "react";

export const TEXT_PREFS_KEY = "sightr:v2:display:text";

export const TEXT_SCALES = [90, 100, 115, 130] as const;
export type TextScale = (typeof TEXT_SCALES)[number];
export type CodeWrap = "auto" | "wrap" | "scroll";

export interface TextPrefs {
  textScale: TextScale;
  codeWrap: CodeWrap;
}

const DEFAULTS: TextPrefs = { textScale: 100, codeWrap: "auto" };

/** Read stored prefs; a value that is not one of the offered ones falls back to the default. */
export function parseTextPrefs(raw: unknown): TextPrefs {
  const p = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const scale = TEXT_SCALES.find((s) => s === p.textScale);
  const wrap = p.codeWrap === "wrap" || p.codeWrap === "scroll" ? p.codeWrap : "auto";
  return { textScale: scale ?? DEFAULTS.textScale, codeWrap: wrap };
}

/** Should a new code block start wrapped? `phone` is the viewport test the chat already uses. */
export function codeStartsWrapped(codeWrap: CodeWrap, phone: boolean): boolean {
  return codeWrap === "auto" ? phone : codeWrap === "wrap";
}

function load(): TextPrefs {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(TEXT_PREFS_KEY);
    return parseTextPrefs(raw ? (JSON.parse(raw) as unknown) : null);
  } catch {
    return DEFAULTS;
  }
}

function applyTextScale(scale: TextScale): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.fontSize = scale === 100 ? "" : `${scale}%`;
}

let prefs: TextPrefs = load();
applyTextScale(prefs.textScale);
const listeners = new Set<() => void>();

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const snapshot = () => prefs;

export const getTextPrefs = (): TextPrefs => prefs;

export function useTextPrefs(): TextPrefs {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function setTextPref<K extends keyof TextPrefs>(key: K, value: TextPrefs[K]): void {
  prefs = parseTextPrefs({ ...prefs, [key]: value });
  applyTextScale(prefs.textScale);
  try {
    localStorage.setItem(TEXT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // private mode: the pref lasts this page only
  }
  for (const fn of listeners) fn();
}

/** Test helper: re-read storage, as a reload would. */
export function __resetTextPrefs(): void {
  prefs = load();
  applyTextScale(prefs.textScale);
  for (const fn of listeners) fn();
}
