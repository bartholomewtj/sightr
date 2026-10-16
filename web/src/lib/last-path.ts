// Remember the screen you were on so a relaunch at "/" opens it again. Paths are router paths
// (`/pane/x`); the URL carries vite's base in front (`/v1/pane/x` since the T15 cutover).
import { stripBase, withBase } from "./base";

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
    const inApp = stripBase(window.location.pathname);
    if (inApp === null) return;
    // A path saved with the base still on it (`/v1/pane/x`) is the same screen.
    const saved = sessionStorage.getItem(KEY);
    const app = saved?.startsWith(withBase("/")) ? stripBase(saved) : saved;
    const target = restorePath(inApp + window.location.search, app);
    if (target) window.history.replaceState(null, "", withBase(target));
  } catch { /* resuming is a nicety */ }
}
