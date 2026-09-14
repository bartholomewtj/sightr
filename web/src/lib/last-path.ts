// Remember the screen you were on so a relaunch at "/" opens it again.
const KEY = "sightr:last-path";

/** Save the current path. Called from router.subscribe on every settled location. */
export function rememberPath(path: string): void {
  try { sessionStorage.setItem(KEY, path); } catch { /* storage is optional */ }
}

/** Pure boot rule: only a bare home boot can resume an in-app path. */
export function restorePath(current: string, saved: string | null): string | null {
  if (current !== "/" || !saved || saved === "/" || !saved.startsWith("/")) return null;
  return saved;
}

/** Rewrite the initial URL to the last screen, when one was remembered. */
export function restoreOnBoot(): void {
  try {
    const current = window.location.pathname + window.location.search;
    const target = restorePath(current, sessionStorage.getItem(KEY));
    if (target) window.history.replaceState(null, "", target);
  } catch { /* resuming is a nicety */ }
}
