import { extname, join, normalize, relative, sep } from "node:path";
import type { Config } from "./config.ts";
import { isHostAllowed } from "./access.ts";
import { CONTENT_TYPES, CSP, secure, text } from "./responses.ts";
import { BUILD_HEADER, UI_HEADER } from "../shared/limits.ts";
export { BUILD_HEADER, UI_HEADER };

// The two built apps. Since the T15 cutover web2 (the thread app) is the front door at `/` and v1
// lives at `/v1/` for one release; the release after removes it. If a tree is missing, the bridge
// still runs the API — only that tree's pages 503 with a hint to build.
const WEB_DIR = join(import.meta.dir, "..", "web", "dist");
const WEB2_DIR = join(import.meta.dir, "..", "web2", "dist");

/** The two built trees `serveStatic` reads. Tests pass their own. */
export interface StaticDirs {
  web: string;
  web2: string;
}
const DEFAULT_DIRS: StaticDirs = { web: WEB_DIR, web2: WEB2_DIR };

// Build id of the bundle currently on disk (written by the Vite build to dist/build-info.json), per
// tree. Surfaced via the X-Sightr-Build header and /api/config so a stale, service-worker-cached client
// can tell it's behind. Cached by file mtime so a frontend rebuild (live, no restart) is picked up.
// The default is web2's: it is the app at `/`. v1 asks for its own with `x-sightr-ui: v1`.
const buildCache = new Map<string, { id: string; mtime: number }>();
export async function buildId(dir: string = WEB2_DIR): Promise<string> {
  try {
    const f = Bun.file(join(dir, "build-info.json"));
    const mtime = f.lastModified;
    let cached = buildCache.get(dir);
    if (!cached || cached.mtime !== mtime) {
      const data = (await f.json()) as { id?: string };
      cached = { id: data.id ?? "unknown", mtime };
      buildCache.set(dir, cached);
    }
    return cached.id;
  } catch {
    return "unknown";
  }
}

/** v1's build id (web/dist), for the route only v1 calls (the snapshot SSE, which cannot send headers). */
export function v1BuildId(): Promise<string> {
  return buildId(WEB_DIR);
}

/**
 * The build id a request's own UI should compare against: v1's when it says `x-sightr-ui: v1`,
 * web2's otherwise. Each UI reloads on a mismatch (spec 10), so neither may see the other's id, or
 * the one at `/v1/` would loop on `registration.update()`. A v1 bundle from before the cutover sends
 * no header, sees web2's id, and so updates itself into web2's worker (the in-place migration).
 */
export function buildIdFor(req: Request, dirs: StaticDirs = DEFAULT_DIRS): Promise<string> {
  return buildId(req.headers.get(UI_HEADER) === "v1" ? dirs.web : dirs.web2);
}

/** Which UI serves the front door (`SIGHTR_UI`, see Config.ui). */
export type UiMode = "v1" | "v2";

/** Where a static request goes: a tree and the path inside it, a redirect, or the retiring worker. */
export type StaticRoute =
  | { tree: "web" | "web2"; pathname: string }
  | { redirect: string }
  | { retireWorker: true };

// v1 paths a rollback redirect keeps (web2's own paths, like /thread/x, land on v1's home).
const V1_KEPT_PATHS = /^\/(?:pane\/|files(?:\/|$)|local$|settings$)/;

/**
 * Which tree a request path belongs to. Pure + exported for tests.
 * - `/v1` and `/v1/...` are v1's, with the prefix stripped.
 * - `/v2` and `/v2/...` (the pre-cutover preview address) redirect to the same path under `/`.
 * - Everything else is web2's.
 * With `ui: "v1"` (the rollback) navigations outside `/v1/` redirect into it, `/sw.js` is the
 * retiring worker, and web2's other files stay readable so a cached web2 page keeps working until
 * its worker is gone.
 */
export function staticTree(pathname: string, ui: UiMode = "v2", search = ""): StaticRoute {
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return { tree: "web", pathname: pathname.slice(3) || "/" };
  const inV2 = pathname === "/v2" || pathname.startsWith("/v2/");
  if (ui === "v1") {
    if (pathname === "/sw.js") return { retireWorker: true };
    const inner = inV2 ? pathname.slice(3) || "/" : pathname;
    if (extname(inner) === "") return { redirect: V1_KEPT_PATHS.test(inner) ? `/v1${inner}${search}` : "/v1/" };
    return { tree: "web2", pathname: inner };
  }
  if (inV2) return { redirect: `${pathname.slice(3) || "/"}${search}` };
  return { tree: "web2", pathname };
}

/**
 * What `/sw.js` answers under `SIGHTR_UI=v1`. An installed PWA holds web2's worker at scope `/` and
 * would keep answering `/` from its precache. web2 re-checks `/sw.js` every minute; this script
 * replaces that worker, drops its precache, unregisters itself and reloads its pages, which then
 * reach the network and are redirected to `/v1/`. It has no fetch handler, so nothing is served from
 * a cache in between. v1 never registers `/sw.js`, so this cannot loop.
 */
export const RETIRE_WORKER_JS = `// Sightr: SIGHTR_UI=v1 retires the web2 worker at this scope.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("workbox-precache") && name.endsWith(self.registration.scope)) await caches.delete(name);
    }
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url).catch(() => null);
  })());
});
`;

// The response header carrying the on-disk bundle's build id. A polling client reads it off every
// snapshot/pane response (web/src/lib/server-build.ts) to notice a live rebuild WITHOUT a service
// worker — the plain-HTTP deployments where the SW can't register, so the SW-based auto-reload never
// runs. Also set on static responses (serveStatic). A named constant
// so both sides agree on the spelling.

/**
 * Attach the current bundle's build id to a response so a polling client can observe a server-side
 * rebuild continuously, not just on a full document load. Pure given the id (the disk read stays in
 * buildId(), mtime-cached) — exported for unit tests.
 */
export function withBuildHeader(res: Response, id: string): Response {
  res.headers.set(BUILD_HEADER, id);
  return res;
}

/**
 * Resolve a request pathname to an absolute path under `webDir`, or null if it escapes. Pure +
 * exported for tests. The `full === webDir || full.startsWith(webDir + sep)` check rejects both
 * `..` traversal AND a sibling dir that merely shares the prefix (e.g. `web/dist-x` vs `web/dist`) —
 * a bare `startsWith(webDir)` would let the latter through.
 */
export function resolveStaticPath(
  pathname: string,
  webDir: string = WEB_DIR,
): { rel: string; full: string } | null {
  const raw = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(webDir, raw));
  if (full !== webDir && !full.startsWith(webDir + sep)) return null;
  // `rel` is derived from the NORMALISED path, never from the request string. Otherwise a dot
  // segment presents one path to the containment check above and a different one to the three
  // checks keyed on `rel` below: "/./build-info.json" would dodge the private-file denial
  // (issue #11), "/./sw.js" would lose its Service-Worker-Allowed header, and "/./assets/x.js"
  // would be served no-cache instead of immutable. Forward slashes so `rel` reads the same on
  // Windows as on the deployment host.
  return { rel: relative(webDir, full).split(sep).join("/"), full };
}

/**
 * The namespace reserved for the operator's front door. Matches `/auth` with or without a trailing
 * slash and anything beneath it — a proxy may serve one page or a whole flow. Kept in lockstep with
 * the service worker's navigation denylist (`web/src/lib/sw-routes.ts`); if these two disagree, an
 * installed PWA either can't reach the proxy or can't reach Sightr. Pure + exported for tests.
 */
export function isReservedAuthPath(pathname: string): boolean {
  return pathname === "/auth" || pathname.startsWith("/auth/");
}

/**
 * What `/auth/` says when nothing is in front of the bridge. Deliberately a 404: the path is
 * reserved, not implemented — Sightr has no sign-in of its own and must not imply otherwise. Plain
 * HTML with no inline style or script (the strict CSP forbids both) and a link home, because in an
 * installed PWA this page may be the only thing on screen and there is no address bar to leave it.
 * Unauthenticated by design: it sits outside every gate, since the reason to be here is that a gate
 * refused you.
 */
export function reservedAuthPlaceholder(): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Nothing configured here — Sightr</title>
</head>
<body>
<h1>Nothing is configured at this address</h1>
<p>Sightr reserves <code>/auth/</code> for a reverse proxy sitting in front of it, so that an
installed app has somewhere to reach a sign-in or device-enrolment page. Sightr itself serves
nothing here and has no sign-in of its own.</p>
<p>If you are the operator: point this path at your proxy's sign-in flow. See <em>Serving Sightr
behind your own reverse proxy</em> in the README.</p>
<p><a href="/">Back to Sightr</a></p>
</body>
</html>
`;
  return secure(
    new Response(body, {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": CSP,
        "cache-control": "no-store",
      },
    }),
  );
}

/**
 * Extensions whose bytes gzip well. Anything else a dist tree holds (png, ico, woff2, wasm) is
 * already compressed, so re-gzipping spends CPU to add bytes. `.map` is in so a source map, when a
 * build ships one, is not sent raw.
 */
const COMPRESSIBLE_EXT = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".webmanifest", ".map", ".txt"]);

/** Below this, deflate's overhead and the extra header bytes outweigh the saving. */
const STATIC_GZIP_MIN_BYTES = 1024;

// Gzipped bytes per file, keyed by absolute path and invalidated by mtime. Hashed assets are
// content-addressed and immutable, so this is one gzip per build; index.html and sw.js are mutable
// and small, so the mtime guard keeps them honest. Bounded because a rebuild mints new hashed names
// and the old entries would otherwise never leave.
const GZIP_CACHE_MAX = 256;
const gzipCache = new Map<string, { mtime: number; bytes: Uint8Array<ArrayBuffer> }>();

async function gzipCached(full: string, file: Bun.BunFile): Promise<Uint8Array<ArrayBuffer>> {
  const mtime = file.lastModified;
  const hit = gzipCache.get(full);
  if (hit && hit.mtime === mtime) return hit.bytes;
  const bytes = Bun.gzipSync(await file.bytes());
  if (gzipCache.size >= GZIP_CACHE_MAX) {
    const oldest = gzipCache.keys().next();
    if (!oldest.done) gzipCache.delete(oldest.value);
  }
  gzipCache.set(full, { mtime, bytes });
  return bytes;
}

/** Test helper: drop the gzip memo so a rewritten fixture is re-read. */
export function __clearStaticGzipCache(): void {
  gzipCache.clear();
}

export async function serveStatic(
  pathname: string,
  host: string,
  cfg: Config,
  dirs: StaticDirs = DEFAULT_DIRS,
  search = "",
  acceptEncoding: string | null = null,
): Promise<Response> {
  // The Host allowlist, which every /api/* route gets via guard() → checkAccess. The static route
  // was the last one that skipped it, so with SIGHTR_PUBLIC_HOSTS set a rebound DNS name was still
  // served the app shell, build-info.json, and the X-Sightr-Build header on every asset — the same
  // hole that was closed for /api/config in collie#32 (issue #11). Deliberately ONLY the host check and
  // not guard(): a top-level navigation carries no Origin, and the identity gate would 403 the whole
  // PWA rather than one endpoint. Rebinding is a Host problem. First, before any path handling, so a
  // rebound host cannot tell 403/404/503 apart by probing paths.
  if (cfg.publicHosts.length > 0 && !isHostAllowed(host, cfg)) return text("host not allowed", 403);

  // `/v1/...` is v1's tree (prefix stripped), `/v2/...` redirects to `/...`, everything else is
  // web2's. Each tree has its own SPA fallback, build id and service-worker scope.
  const route = staticTree(pathname, cfg.ui ?? "v2", search);
  if ("redirect" in route) {
    return secure(new Response(null, { status: 302, headers: { location: route.redirect, "cache-control": "no-store" } }));
  }
  if ("retireWorker" in route) {
    return secure(
      new Response(RETIRE_WORKER_JS, {
        headers: { "content-type": CONTENT_TYPES[".js"] ?? "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" },
      }),
    );
  }
  const v1 = route.tree === "web";
  const dir = v1 ? dirs.web : dirs.web2;
  const resolved = resolveStaticPath(route.pathname, dir);
  if (!resolved) return text("forbidden", 403);
  let { rel, full } = resolved;

  // 404, not 403: a refusal that differs from "no such file" confirms the file is there.
  if (isPrivateStaticFile(rel)) return text("not found", 404);

  let file = Bun.file(full);
  if (!(await file.exists())) {
    // SPA fallback: extension-less paths fall back to index.html; missing assets 404.
    if (extname(rel) === "") {
      rel = "index.html";
      full = join(dir, "index.html");
      file = Bun.file(full);
      if (!(await file.exists())) {
        return text(v1 ? "v1 not built — run `bun run build:web`" : "frontend not built — run `bun run build`", 503);
      }
    } else {
      return text("not found", 404);
    }
  }

  const ext = extname(full);
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    [BUILD_HEADER]: await buildId(dir), // which bundle the server is serving (vs the client's stamp)
    "cache-control": cacheControlFor(rel),
  };
  if (ext === ".html") headers["content-security-policy"] = CSP;
  // `/sw.js` is web2's worker at the URL and scope v1's had, so an installed PWA updates in place.
  if (rel === "sw.js") headers["service-worker-allowed"] = v1 ? "/v1/" : "/";
  // A dist tree is text-heavy and was served raw, so a cold thread open pulled ~1.7 MB over 4G.
  // Gzip it (cached by mtime) when the client asks and the type is worth compressing; `vary` goes on
  // either way so no shared cache hands a gzipped body to a client that cannot read it.
  if (COMPRESSIBLE_EXT.has(ext)) {
    headers["vary"] = "accept-encoding";
    if ((acceptEncoding ?? "").includes("gzip") && file.size >= STATIC_GZIP_MIN_BYTES) {
      headers["content-encoding"] = "gzip";
      return secure(new Response(await gzipCached(full, file), { headers }));
    }
  }
  return secure(new Response(file, { headers }));
}

/**
 * Cache-Control for a served dist file, keyed by its path relative to web/dist. Hashed assets under
 * `assets/` are content-addressed, so cache them hard + immutable. EVERYTHING else — index.html,
 * sw.js, manifest.webmanifest, the favicons — is MUTABLE across a rebuild and must
 * always be revalidated (`no-cache`), so neither the browser NOR an intermediary reverse proxy can
 * pin a stale copy. This matters most for sw.js: a proxy that heuristically caches it (it shipped
 * with no Cache-Control before) starves `registration.update()` and wedges the whole SW update
 * pipeline — the exact failure this build metadata helps diagnose,
 * but which this header prevents at the source. Pure + exported for unit tests.
 */
export function cacheControlFor(rel: string): string {
  return rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

/**
 * Dist files that exist on disk but must never be answered over HTTP.
 *
 * `build-info.json` is the build id in a file. Nothing fetches it: the bridge reads it off DISK for
 * the X-Sightr-Build header and /api/config (see `buildId`), sightr-ctl reads it off disk, and the
 * frontend learns the server build from that header and from /api/config — it has no fetch for this
 * path. Serving it was purely an artefact of the whole dist tree being public, and it put the build
 * id behind no gate at all (issue #11). Pure + exported for unit tests.
 */
export function isPrivateStaticFile(rel: string): boolean {
  return rel === "build-info.json";
}
