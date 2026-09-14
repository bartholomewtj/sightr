import type { PushSubscription } from "./push.ts";

/** Longest endpoint we will store. Real push endpoints are ~150-400 chars; 2 KB is generous. */
export const PUSH_ENDPOINT_MAX = 2048;

/** Ceiling on stored subscriptions. A household has a handful of devices; this is a flood stop. */
export const MAX_SUBSCRIPTIONS = 20;

/** Hosts that operate a real Web Push service. Matched as an exact host OR a dot-suffix, so
 *  "notify.windows.com" covers "db5p.notify.windows.com". */
export const DEFAULT_PUSH_HOSTS: readonly string[] = [
  "fcm.googleapis.com", // Chrome / Chromium, FCM
  "android.googleapis.com", // legacy GCM-era Chrome endpoints
  "push.services.mozilla.com", // Firefox (updates.push.services.mozilla.com)
  "push.apple.com", // Safari / iOS (web.push.apple.com)
  "notify.windows.com", // Edge / WNS (<region>.notify.windows.com)
  "push.services.microsoft.com", // Edge, newer
];

/**
 * Check whether a hostname matches the push service allowlist (built-in + operator extra).
 * Matched as an exact host OR a dot-suffix (e.g. "notify.windows.com" covers "db5p.notify.windows.com").
 * Case-insensitive.
 */
export function hostAllowedForPush(host: string, extra: readonly string[] = []): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  const list = [...DEFAULT_PUSH_HOSTS, ...extra];
  for (const raw of list) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (h === entry || h.endsWith("." + entry)) return true;
  }
  return false;
}

/**
 * Whether a host looks like a private or loopback destination. Used ONLY for the startup warning
 * on operator-supplied entries in SIGHTR_PUSH_ALLOWED_HOSTS — NOT part of endpoint validation.
 */
export function looksPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h === "0.0.0.0" || h === "::" || h === "::1" || h === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) {
    return true;
  }
  // Single-label host (no dots and not an IPv6 address)
  if (!h.includes(".") && !h.includes(":")) {
    return true;
  }
  // IPv4 private/loopback/link-local/CGNAT ranges
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(h)) return true;

  // IPv6 private/link-local/ULA ranges: fc00::/7 (fc, fd), fe80::/10 (fe8, fe9, fea, feb)
  if (/^f[cd][0-9a-f]{0,2}:/i.test(h)) return true;
  if (/^fe[89ab][0-9a-f]{0,1}:/i.test(h)) return true;

  return false;
}

/**
 * Validates a base64 / base64url key against an expected byte length (or minimum).
 */
export function validPushKey(value: string, bytes: number, exact: boolean): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!/^[A-Za-z0-9_+\/-]+={0,2}$/.test(value)) return false;
  try {
    const len = Buffer.from(value, "base64url").length;
    return exact ? len === bytes : len >= bytes;
  } catch {
    return false;
  }
}

/**
 * Validates a push endpoint URL against scheme, length, credentials, and the host allowlist.
 */
export function validPushEndpoint(endpoint: string, extra: readonly string[] = []): boolean {
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > PUSH_ENDPOINT_MAX) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (!hostAllowedForPush(url.hostname, extra)) return false;
  return true;
}

/**
 * Validates and normalizes an untrusted push subscription payload.
 * Returns a freshly built PushSubscription object or null if invalid.
 */
export function parsePushSubscription(
  v: unknown,
  extra: readonly string[] = [],
): PushSubscription | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const keys = o.keys as Record<string, unknown> | undefined;
  if (typeof o.endpoint !== "string" || typeof keys !== "object" || keys === null) return null;
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;

  if (!validPushEndpoint(o.endpoint, extra)) return null;
  if (!validPushKey(keys.p256dh, 65, true)) return null;
  if (!validPushKey(keys.auth, 16, false)) return null;

  return {
    endpoint: o.endpoint,
    keys: {
      p256dh: keys.p256dh,
      auth: keys.auth,
    },
  };
}
