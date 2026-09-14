# 0023 — Host validation is fail-closed

Status: **Accepted** (2026-08-17)

## Context

Prior to 1.0.0, the Host-header allowlist was opt-in: `COLLIE_PUBLIC_HOSTS` defaulted to empty, and
`server.ts` only evaluated `isHostAllowed` when `cfg.publicHosts.length > 0`.

In that shipped default, a DNS-rebound page sending `Host: evil.example:8787` and
`Origin: http://evil.example:8787` satisfied `originHost === host` in `server.ts` and obtained full
read and write access against the bridge on `127.0.0.1:8787` (issue #3). The README described the
allowlist as "strongly recommended", leaving documentation to do the work that code must do.

Opt-in security is not security. Rebinding attacks exploit the gap between what an operator configures
and what the application permits. Leaving Host validation off by default left every unconfigured
installation vulnerable to cross-site read and write abuse via DNS rebinding.

## Decision

**Make Host-header validation always on and fail-closed.**

1. **Reject non-loopback Hosts by default:** Unless explicitly configured or discovered, any request
   whose `Host` is not a loopback address(`localhost`, `127.0.0.1`, `[::1]`) is rejected with
   `403 host not allowed` before any Origin check runs.
2. **Acceptable identities include:**
   - Loopback forms (`localhost`, `127.0.0.1`, `[::1]`).
   - Operator-pinned hosts in `COLLIE_PUBLIC_HOSTS`.
   - Hostnames parsed from `COLLIE_ALLOWED_ORIGINS`.
   - Discovered Tailscale hostnames and IPs (`COLLIE_TAILSCALE_HOSTS`).
3. **Discovered via `collie-ctl.sh`, not bridge subprocesses:** The bridge does not shell out to
   `tailscale`. `scripts/collie-ctl.sh` queries `tailscale status --json` at startup to extract
   `Self.DNSName` and `Self.TailscaleIPs`, injecting them as `COLLIE_TAILSCALE_HOSTS`. Normal tailnet
   deployments continue working without manual allowlist configuration.
4. **Deliberate breakage for `COLLIE_SKIP_SERVE=1`:** Under `COLLIE_SKIP_SERVE=1` (reverse proxies,
   custom ingress), Collie discovers no tailnet identities. Unpinned installations will fail closed
   with `403 host not allowed` until `COLLIE_PUBLIC_HOSTS` is set. A clear startup warning acts as the
   diagnostic.
5. **Explicit, loudly-warned opt-out:** `COLLIE_ALLOW_ANY_HOST=1` exists for rare setups where hosts
   cannot be enumerated. The insecure state must be deliberately typed, not defaulted into.

## Consequences

- Reverse-proxy installations (`COLLIE_SKIP_SERVE=1` / Variant C/E) that have not configured
  `COLLIE_PUBLIC_HOSTS` break on upgrade until `COLLIE_PUBLIC_HOSTS` is set. This is a breaking change
  necessitating a MAJOR version bump (`1.0.0`).
- The default installation is protected against DNS rebinding without requiring operators to define
  `COLLIE_PUBLIC_HOSTS` manually on standard tailnets.
- The insecure state requires deliberate opt-in (`COLLIE_ALLOW_ANY_HOST=1`) and emits a prominent
  startup warning.
