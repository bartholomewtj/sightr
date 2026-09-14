import { extname, join, normalize, relative, sep } from "node:path";
import type { Config } from "./config.ts";
import { isHostAllowed } from "./access.ts";
import { CONTENT_TYPES, CSP, secure, text } from "./responses.ts";
import { BUILD_HEADER } from "../shared/limits.ts";
export { BUILD_HEADER };

// The built PWA lives in web/dist (Vite output). If it's missing, the bridge still runs the API
// — only the static UI 503s with a hint to build.
const WEB_DIR = join(import.meta.dir, "..", "web", "dist");
// Build id of the bundle currently on disk (written by the Vite build to dist/build-info.json).
// Surfaced via the X-Sightr-Build header and /api/config so a stale, service-worker-cached client
// can tell it's behind. Cached by file mtime so a frontend rebuild (live, no restart) is picked up.
let buildCache: { id: string; mtime: number } | null = null;
export async function buildId(): Promise<string> {
  try {
    const f = Bun.file(join(WEB_DIR, "build-info.json"));
    const mtime = f.lastModified;
    if (!buildCache || buildCache.mtime !== mtime) {
      const data = (await f.json()) as { id?: string };
      buildCache = { id: data.id ?? "unknown", mtime };
    }
    return buildCache.id;
  } catch {
    return "unknown";
  }
}

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

export async function serveStatic(pathname: string, host: string, cfg: Config): Promise<Response> {
  // The Host allowlist, which every /api/* route gets via guard() → checkAccess. The static route
  // was the last one that skipped it, so with SIGHTR_PUBLIC_HOSTS set a rebound DNS name was still
  // served the app shell, build-info.json, and the X-Sightr-Build header on every asset — the same
  // hole that was closed for /api/config in collie#32 (issue #11). Deliberately ONLY the host check and
  // not guard(): a top-level navigation carries no Origin, and the identity gate would 403 the whole
  // PWA rather than one endpoint. Rebinding is a Host problem. First, before any path handling, so a
  // rebound host cannot tell 403/404/503 apart by probing paths.
  if (cfg.publicHosts.length > 0 && !isHostAllowed(host, cfg)) return text("host not allowed", 403);

  const resolved = resolveStaticPath(pathname);
  if (!resolved) return text("forbidden", 403);
  let { rel, full } = resolved;

  // 404, not 403: a refusal that differs from "no such file" confirms the file is there.
  if (isPrivateStaticFile(rel)) return text("not found", 404);

  let file = Bun.file(full);
  if (!(await file.exists())) {
    // SPA fallback: extension-less paths fall back to index.html; missing assets 404.
    if (extname(rel) === "") {
      rel = "index.html";
      full = join(WEB_DIR, "index.html");
      file = Bun.file(full);
      if (!(await file.exists())) {
        return text("frontend not built — run `bun run build` in web/", 503);
      }
    } else {
      return text("not found", 404);
    }
  }

  const ext = extname(full);
  const headers: Record<string, string> = {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    [BUILD_HEADER]: await buildId(), // which bundle the server is serving (vs the client's stamp)
    "cache-control": cacheControlFor(rel),
  };
  if (ext === ".html") headers["content-security-policy"] = CSP;
  if (rel === "sw.js") headers["service-worker-allowed"] = "/";
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
