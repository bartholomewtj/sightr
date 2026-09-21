import { gzipJsonResponse } from "./http-cache.ts";

export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Strict CSP. Scripts are external, hashed bundles (script-src 'self'); pane text is rendered by
// React as text nodes, never markup, so terminal output can't inject. 'unsafe-inline' is allowed
// for styles only (the toast library injects a <style> tag) — it can't execute code.
export const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self'; " +
  "manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'";

// Hardening headers set on EVERY response (static + API), applied centrally in the fetch wrapper.
// nosniff stops content-type confusion; no-referrer keeps the tailnet URL out of any Referer.
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// Loopback Host/Origin forms (with an optional port). Loopback is always trusted — only tailscaled
export function secure(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

export function json(data: unknown, acceptEncoding: string | null, status = 200): Response {
  const response = gzipJsonResponse(data, acceptEncoding);
  if (status === 200) return secure(response);
  return secure(new Response(response.body, { status, headers: response.headers }));
}

/**
 * A JSON error body with a non-200 status (e.g. an unknown-session 404). The body is tiny (below the
 * gzip threshold), so a plain uncompressed JSON response is the whole story — no need for the gzip
 * path. `acceptEncoding` is accepted for call-site symmetry with {@link json} but not needed here.
 */
export function jsonError(message: string, status: number, _acceptEncoding: string | null): Response {
  return secure(
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

export function text(body: string, status: number): Response {
  return secure(new Response(body, { status }));
}
export function decodePathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * The single place an exception becomes a client-visible string.
 *
 * The real error — which routinely carries absolute journal, state-dir and Herdr-socket paths, and
 * for a socket failure the whole raw reply line — goes to the log, where the operator reads it with
 * `sightr-ctl.ps1 logs`. The client gets a fixed phrase naming only what was being
 * attempted. Never interpolate `err` into the return value.
 */
export function failureText(context: string, err: unknown): string {
  console.error(`[bridge] ${context} failed:`, err);
  return `${context} failed`;
}

/**
 * Whether a request body declares JSON. The gate on every JSON route: a cross-site POST can only
 * set text/plain, form-urlencoded or multipart without a CORS preflight, so demanding
 * application/json forces a preflight the bridge never answers. Pure + exported for tests.
 */
export function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  return value.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/** 415 short-circuit for a JSON route, or null to proceed. */
export function requireJsonBody(req: Request): Response | null {
  if (isJsonContentType(req.headers.get("content-type"))) return null;
  return text("expected application/json", 415);
}
