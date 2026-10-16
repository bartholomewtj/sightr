import { useSyncExternalStore } from "react";

/**
 * The one layout rule (T09): at 1024 px and wider the shell shows Sidebar | Chat | RightPanel; below
 * it the sidebar is the home screen and a thread is a full screen. A plain width rule, no user override
 * (v1's `useDesktop` with its `hover: hover` test is deliberately not ported).
 */
export const DESKTOP_QUERY = "(min-width: 1024px)";

export type Layout = "desktop" | "phone";

function query(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(DESKTOP_QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const mql = query();
  if (!mql) return () => {};
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const snapshot = (): Layout => (query()?.matches ? "desktop" : "phone");

export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, snapshot, () => "phone");
}
