// Where v1 is served. Since the T15 cutover the thread app (web2) is the front door at `/` and v1 lives
// at `/v1/` for one release (vite `base`); the release after removes v1. Router paths stay `/pane/x`
// etc. (the router's `basename` adds the prefix); these helpers cover the places that build or read a
// full URL path outside the router. Unit tests run at vite's default base `/`.
//
// Free of any import, so the service worker can use it too.

/** Vite's `base` with its trailing slash: `/v1/` in a build, `/` under Vitest. */
export const BASE: string = import.meta.env.BASE_URL;

/** The router basename for `base`: `/v1/` → "/v1", `/` → "/". */
export function basenameFor(base: string = BASE): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** An app path (`/pane/x`) as a full URL path under `base` (`/v1/pane/x`). */
export function withBase(path: string, base: string = BASE): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** A full URL path under `base` as an app path; null when it lies outside `base`. */
export function stripBase(pathname: string, base: string = BASE): string | null {
  const prefix = base.replace(/\/+$/, "");
  if (prefix === "") return pathname;
  if (pathname === prefix) return "/";
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : null;
}
