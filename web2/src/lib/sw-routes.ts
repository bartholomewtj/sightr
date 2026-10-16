/**
 * What web2's service worker must leave to the network, and which caches it inherits. Free of
 * workbox imports so the rules are unit-testable (sw-routes.test.ts) and shared by sw.ts and pwa.ts.
 *
 * Since the T15 cutover web2's worker is `/sw.js` with scope `/`: the URL and scope v1's worker had,
 * so an installed PWA swaps v1's worker for this one in place (spec 10's update path). v1 now lives at
 * `/v1/` with its own worker, so `/v1/` must never be answered with web2's cached shell.
 */

/**
 * Navigations the worker passes to the network (matched against `pathname + search`, as workbox's
 * NavigationRoute does; see web/src/lib/sw-routes.ts for the `[/?]` reasoning). `/v1/` loads v1 from
 * the network so it can register its own worker; `/api/` is never cached; `/auth` and `/cdn-cgi/`
 * belong to a fronting proxy.
 */
export const NAVIGATION_NETWORK_ONLY: readonly RegExp[] = [
  /^\/v1(?:[/?]|$)/,
  /^\/api\//,
  /^\/auth(?:[/?]|$)/,
  /^\/cdn-cgi\//,
];

/**
 * The pre-cutover preview address. The bridge redirects `/v2/...` to `/...`; a worker at scope `/`
 * would otherwise answer it from the precache with a shell whose router has no `/v2` routes.
 */
export const V2_PREVIEW_NAVIGATION = /^\/v2(?:[/?]|$)/;

/** The denylist web2's worker installs for its `base` (the `/v2/` entry only when it lives at `/`). */
export function navigationDenylist(base: string): RegExp[] {
  return base === "/" ? [...NAVIGATION_NETWORK_ONLY, V2_PREVIEW_NAVIGATION] : [...NAVIGATION_NETWORK_ONLY];
}

export function isNetworkOnlyNavigation(pathnameAndSearch: string, base = "/"): boolean {
  return navigationDenylist(base).some((re) => re.test(pathnameAndSearch));
}

/** v1's lazy font cache. Before the cutover its entries were `/fonts/...`; v1 now uses `/v1/fonts/...`. */
export const V1_FONT_CACHE = "sightr-fonts";

/**
 * An entry of v1's font cache that only the pre-cutover v1 (at `/`) could use. web2's worker drops
 * these on activate; entries under `/v1/` belong to v1's own worker and stay.
 */
export function isStaleV1FontEntry(pathname: string): boolean {
  return pathname.startsWith("/fonts/");
}

/** True when `scriptURL` is this app's own worker (`<base>sw.js`), not v1's at `/v1/sw.js`. */
export function isOwnWorker(scriptURL: string | undefined, base: string): boolean {
  if (!scriptURL) return false;
  try {
    return new URL(scriptURL, "http://x").pathname === `${base}sw.js`;
  } catch {
    return false;
  }
}

/** True when a registration's scope is exactly this app's (`base`), not v1's `/v1/`. */
export function isOwnScope(scope: string, base: string): boolean {
  try {
    return new URL(scope, "http://x").pathname === base;
  } catch {
    return false;
  }
}
