import { isLoopbackBindHost, type Config } from "./config.ts";
import { looksPrivateHost } from "./push-endpoint.ts";
import type { DeviceAuth } from "../shared/wire.ts";
import { text } from "./responses.ts";
import { effectiveSettings } from "./runtime-settings.ts";
import { SEEN_HEADER } from "../shared/limits.ts";
export { SEEN_HEADER };

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Whether a TCP peer address is loopback. Unlike the `Host` header — which the client writes and
 * `LOOPBACK_HOST` above merely parses — this comes from the kernel and cannot be forged, so it is
 * the one honest answer to "is this caller on the box".
 *
 * Bun gives IPv4 peers as `127.0.0.1` and IPv6 peers as `::1`; a dual-stack listener can also report
 * an IPv4 peer in v4-mapped form (`::ffff:127.0.0.1`), so all three shapes are matched.
 *
 * A null/absent address is treated as loopback, i.e. this check abstains rather than rejecting.
 * `Server.requestIP` returns null for a request whose socket has already gone, and the bind gate in
 * config.ts is the primary control — this one is defence in depth. Failing closed on an
 * unknowable address would trade a real hole for a flaky one.
 *
 * Pure + exported so the address table is unit-tested without standing up Bun.serve.
 */
export function isLoopbackPeer(address: string | null | undefined): boolean {
  if (!address) return true;
  const a = address.trim().toLowerCase();
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}


/**
 * Whether this request proves it came from Sightr's own page, and may therefore stamp the pane as
 * seen (bridge/activity.ts).
 *
 * This exists because marking-seen made a **read-level GET mutate server state**, which it never did
 * before. `checkAccess` deliberately does not demand an `Origin` on reads — browsers omit it on
 * same-origin GETs, so demanding one would reject the real client — and that exemption was safe only
 * while reads had no side effects. Without this check, a page the operator visits while on the
 * tailnet could fire `<img src="https://sightr…/api/pane/w1:p1">` at guessable pane ids and silently
 * clear the "Ready · unseen" section: the response is opaque to the attacker, but the write lands,
 * and the operator simply stops being told their agents finished.
 *
 * A custom request header is the check because a no-cors cross-site request **cannot set one** —
 * doing so promotes it to a preflighted CORS request, and the bridge answers no preflight. Our own
 * same-origin `fetch` sets it freely.
 *
 * Write actions (reply/keys/upload/close/rename) need no header: they already cleared
 * `guard(…, "write")`, which requires an `Origin`. `history` is a read despite being an action
 * segment, so it needs the header like any other read.
 */
export function marksPaneSeen(req: Request, action: string | undefined): boolean {
  if (req.headers.get(SEEN_HEADER) !== null) return true;
  return action !== undefined && action !== "history";
}
export function isStateChangingMethod(req: Request): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  return method !== "GET" && method !== "HEAD";
}

/**
 * Access gate for the API:
 *  - Host allowlist (fail-closed): the request's Host header must be a loopback form, an explicit
 *    SIGHTR_PUBLIC_HOSTS entry, a ctl-discovered Tailscale host (SIGHTR_TAILSCALE_HOSTS), or the
 *    host of an allowed origin — otherwise rejected, BEFORE any Origin logic (fail-closed). This
 *    defeats DNS rebinding (issue #3), where a browser is tricked into sending Host==Origin==evil.example
 *    so a bare same-origin check trivially passes. SIGHTR_ALLOW_ANY_HOST=1 is the explicit opt-out.
 *  - Same-origin only: the Origin host must equal the Host header, or the exact Origin must be
 *    listed in SIGHTR_ALLOWED_ORIGINS. A loopback Origin gets no special pass — a page on
 *    http://localhost:<any port> is a different origin from a remote Sightr, and treating it as
 *    trusted handed any local page a CSRF write against the bridge. Browsers omit Origin on
 *    same-origin GETs (so the snapshot poll passes); they send it on POSTs.
 *  - Origin required for anything state-changing: a request with no Origin is trusted only from
 *    loopback (curl on the host) if it is a write OR its method is not GET/HEAD. Browsers always
 *    send Origin on fetch/SW POSTs, so a missing Origin on a remote POST is a non-browser or
 *    Origin-stripped request — reject it whatever access level the route asks for (issue #8).
 *  - Optional Tailscale identity: when a trusted user is configured under `tailscale serve`, the
 *    request must carry a matching `Tailscale-User-Login`. A missing header is rejected too —
 *    serve injects none for tagged nodes, so tolerating it let any tagged node write. Under
 *    SIGHTR_SKIP_SERVE=1 (no injector) or SIGHTR_TRUSTED_USER_OPTIONAL=1, only a mismatch is
 *    rejected.
 */
export function checkAccess(
  req: Request,
  cfg: Config,
  level: "read" | "write" = "read",
): { ok: true } | { ok: false; reason: string } {
  const host = req.headers.get("host") ?? "";

  // Host-header allowlist — ALWAYS ON, before the Origin logic, so a rebinding request
  // (Host==Origin==evil) never reaches it. SIGHTR_ALLOW_ANY_HOST=1 is the operator's explicit
  // opt-out and re-opens issue #3.
  if (!cfg.allowAnyHost && !isHostAllowed(host, cfg)) {
    return { ok: false, reason: "host not allowed" };
  }

  const origin = req.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, reason: "bad origin" };
    }
    // No loopback-Origin exemption: a page on http://localhost:NNNN is cross-origin to this bridge.
    // Local dev through the vite proxy re-permits itself via SIGHTR_ALLOWED_ORIGINS.
    const allowed = originHost === host || cfg.allowedOrigins.includes(origin);
    if (!allowed) return { ok: false, reason: "cross-origin rejected" };
  } else if ((level === "write" || isStateChangingMethod(req)) && !LOOPBACK_HOST.test(host)) {
    // A state-changing request with no Origin header from a non-loopback Host isn't a real browser
    // request — refuse. Loopback (curl on the host) is still exempt.
    return { ok: false, reason: "origin required" };
  }

  if (cfg.trustedUser) {
    const login = req.headers.get("tailscale-user-login");
    if (login) {
      if (login !== cfg.trustedUser) return { ok: false, reason: "identity not trusted" };
    } else if (!cfg.skipServe && !cfg.trustedUserOptional) {
      // Fail closed: `tailscale serve` injects no Tailscale-User-* for TAGGED nodes, so an absent
      // header is not "a loopback caller" — it is any tagged node on the tailnet (issue #2). There
      // is no safe loopback exemption here: serve proxies from 127.0.0.1 so the peer IP is always
      // loopback, and the Host header is the client's to set.
      return { ok: false, reason: "identity required" };
    }
  }
  return { ok: true };
}

/**
 * Whether a Host header is one the bridge will answer to under the fail-closed host allowlist: a
 * loopback form, an explicit SIGHTR_PUBLIC_HOSTS entry, a discovered Tailscale host (bare or with
 * port), or the host of a configured allowed origin. Pure + exported for tests.
 */
export function isHostAllowed(host: string, cfg: Config): boolean {
  if (!host) return false;
  if (LOOPBACK_HOST.test(host)) return true;
  if (cfg.publicHosts.includes(host)) return true;
  // Discovered Tailscale identities match bare or with any port: https serve answers on 443 (no
  // port in Host), http serve answers on SIGHTR_PORT. One entry covers both modes.
  const bare = host.replace(/:\d+$/, "");
  if (cfg.tailscaleHosts.some((h) => h === host || h === bare)) return true;
  return cfg.allowedOrigins.some((o) => {
    try {
      return new URL(o).host === host;
    } catch {
      return false;
    }
  });
}

/**
 * Combined API gate used by every handler. A request must always pass {@link checkAccess}
 * (same-origin / CSRF + optional Tailscale identity). A `"write"` request — one that types into a
 * terminal or creates panes — must additionally come from an authorised device (see
 * {@link deviceAuth}). Returns a 403 Response to short-circuit on denial, or null to proceed.
 *
 * Exported for tests: {@link deviceAuth} being correct in isolation proves nothing if this wiring
 * regresses, and the write/read asymmetry below is exactly what a device gate stands or falls on.
 */
export function guard(req: Request, cfg: Config, level: "read" | "write"): Response | null {
  const gate = checkAccess(req, cfg, level);
  if (!gate.ok) return text(gate.reason, 403);
  if (level === "write" && !deviceAuth(req, cfg).authorized) {
    return text("device not authorised", 403);
  }
  return null;
}

/**
 * Optional per-device authorisation, layered on top of {@link checkAccess}. Off by default; enabled
 * by setting SIGHTR_DEVICE_HEADER to the header a trusted upstream proxy injects, carrying an opaque
 * device identifier. The header is trusted only because the bridge binds loopback behind the proxy,
 * so a direct client can't forge it (the same trust basis as the Tailscale identity header). Matrix:
 *
 *   - feature off (no header configured) → not enforced, fully authorised (today's behaviour).
 *   - header absent                      → read-only, same as an unlisted device. Configuring the
 *                                          header is the operator asserting that the proxy sets it
 *                                          on every request, so a request without one did not come
 *                                          through that proxy and must not drive a terminal.
 *   - header present, value allowlisted  → authorised; the session is attributed to that device.
 *   - header present, value not listed   → read-only. The "unknown" sentinel is never authorised,
 *                                          and an empty allowlist makes every device read-only — a
 *                                          fail-closed default for a security toggle you turned on.
 *
 * "Read-only" is the whole scope of this gate, deliberately: {@link guard} consults it only for
 * `"write"`, so a header-less caller still reads panes. That is the existing design (a read-only
 * device is meant to watch), and this function does not change it. What changes is that a missing
 * header no longer counts as the operator.
 *
 * The absent-header case deliberately has no loopback exemption. It looks like the natural place for
 * one, but every supported front door is a proxy co-located with the bridge (tailscale serve and the
 * documented reverse proxies all connect to 127.0.0.1), so a loopback peer says nothing about
 * whether the caller is the operator on the host or a remote client whose proxy failed to inject the
 * header. Driving a pane from the host is still one flag away: send an allowlisted id yourself.
 */
export function deviceAuth(req: Request, cfg: Config): DeviceAuth {
  if (!cfg.deviceHeader) return { enforced: false, device: null, authorized: true };
  const raw = req.headers.get(cfg.deviceHeader);
  const device = raw?.trim() ? raw.trim() : null;
  if (!device) return { enforced: true, device: null, authorized: false };
  // Runtime settings are checked on every request, so a revoke is effective without a restart.
  const authorized = device !== "unknown" && effectiveSettings(cfg).deviceAllowlist.includes(device);
  return { enforced: true, device, authorized };
}

// Apply the shared hardening headers (nosniff / no-referrer) to any response. Every response the
// bridge emits funnels through json(), text(), serveStatic(), or a handful of inline responses —
export function startupWarnings(cfg: Config): string[] {
  const warnings: string[] = [];
  if (!isLoopbackBindHost(cfg.host)) {
    warnings.push(
      `[bridge] WARNING: bound to ${cfg.host} via SIGHTR_ALLOW_NON_LOOPBACK_BIND — the identity, device and same-origin gates are all client-settable on a wide bind, and the peer-address check is off. Whatever fronts this port is now the only control.`,
    );
  }
  if (cfg.deviceHeader && cfg.deviceAllowlist.length === 0) {
    warnings.push(
      `[bridge] WARNING: SIGHTR_DEVICE_HEADER set but SIGHTR_DEVICE_ALLOWLIST is empty — every device is read-only`,
    );
  }
  if (cfg.skipServe) {
    // Reverse-proxy mode: no tailscale serve injects Tailscale-User-Login, so checkAccess never has
    // an identity to enforce — trustedUser is dead config. Only nag when it's set (a likely mistake).
    if (cfg.trustedUser) {
      warnings.push(
        `[bridge] WARNING: SIGHTR_TRUSTED_USER has no effect under SIGHTR_SKIP_SERVE=1 — without tailscale serve in front, the Tailscale-User-Login header is never injected. Use SIGHTR_DEVICE_HEADER for per-device auth (see README.md → Configuration).`,
      );
    }
  } else if (!cfg.trustedUser) {
    warnings.push(
      `[bridge] WARNING: SIGHTR_TRUSTED_USER is empty — any tailnet device/user that reaches the bridge gets full write access. Set it to your tailnet login (see README.md → Security).`,
    );
  } else if (cfg.trustedUserOptional) {
    warnings.push(
      `[bridge] WARNING: SIGHTR_TRUSTED_USER_OPTIONAL=1 — a request with no Tailscale-User-Login is accepted, so any TAGGED tailnet node (which serve injects no identity for) gets full write access. Unset it outside host-local development.`,
    );
  }
  if (cfg.allowAnyHost) {
    warnings.push(
      `[bridge] WARNING: SIGHTR_ALLOW_ANY_HOST=1 — Host-header validation is OFF, so a DNS-rebound page can reach this bridge as if it were same-origin. Unset it and set SIGHTR_PUBLIC_HOSTS to the host(s) you serve on.`,
    );
  } else if (
    cfg.publicHosts.length === 0 &&
    cfg.tailscaleHosts.length === 0 &&
    cfg.allowedOrigins.length === 0
  ) {
    warnings.push(
      `[bridge] WARNING: no non-loopback Host is allowed — every request except one addressed to localhost/127.0.0.1 will be rejected with "host not allowed". Set SIGHTR_PUBLIC_HOSTS to the exact host(s) you serve on (required behind your own reverse proxy, see README.md → Configuration).`,
    );
  }
  const risky = cfg.pushAllowedHosts.filter(looksPrivateHost);
  if (risky.length) {
    warnings.push(
      `[bridge] WARNING: SIGHTR_PUSH_ALLOWED_HOSTS contains private/loopback host(s) (${risky.join(", ")}) — any read-level client can now make the bridge POST to them (issue #7)`,
    );
  }
  return warnings;
}
