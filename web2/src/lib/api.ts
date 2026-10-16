// The non-v2 bridge calls web2 needs: the lock endpoints (copied from web/src/lib/api.ts, same
// `/api/lock/*` routes) and the request headers every web2 call sends.
import type { ActionResponse, BridgeConfig, LockStatus, UploadResponse } from "@shared/wire";

import { noteLockRequired } from "./lock";

/** Marks a request as XHR so a fronting identity proxy answers with a status, not a redirect (see web/src/lib/api.ts). */
export const XHR_HEADER = "x-requested-with";
export const XHR_HEADER_VALUE = "XMLHttpRequest";
/** The bridge sets `x-sightr-lock: required` on a 401 the lock caused. */
export const LOCK_HEADER = "x-sightr-lock";

/** True (and the unlock prompt raised) when `res` is a lock refusal. */
export function noteIfLocked(res: Response): boolean {
  if (res.status === 401 && res.headers.get(LOCK_HEADER) === "required") {
    noteLockRequired();
    return true;
  }
  return false;
}

async function req<T>(path: string, init?: RequestInit, recover?: (status: number) => T | null): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", [XHR_HEADER]: XHR_HEADER_VALUE, ...init?.headers },
  });
  if (!res.ok) {
    const recovered = recover?.(res.status);
    if (recovered !== null && recovered !== undefined) return recovered;
    noteIfLocked(res);
    throw new Error(`${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchLockStatus(): Promise<LockStatus> {
  return req<LockStatus>("/api/lock");
}

export const b64uToBytes = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const bytesToB64u = (b: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

interface WebauthnChallenge {
  challenge: string;
  rpId: string;
  rpName: string;
  userId: string;
  allowCredentials: string[];
  timeout: number;
}

export function webauthnChallenge(purpose: "register" | "assert"): Promise<WebauthnChallenge> {
  return req("/api/lock/webauthn/challenge", { method: "POST", body: JSON.stringify({ purpose }) });
}

export function unlockWebauthn(body: {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}): Promise<{ ok: boolean }> {
  return req("/api/lock/webauthn/unlock", { method: "POST", body: JSON.stringify(body) }, (status) =>
    status === 401 ? { ok: false } : null,
  );
}

// ── T12: the composer's non-v2 calls (copied from web/src/lib/api.ts, same routes) ──────────────

/** The operator's palette rows and Keys presets (`commands.toml`, `keys.toml`), read once per page. */
export function fetchConfig(): Promise<BridgeConfig> {
  return req<BridgeConfig>("/api/config");
}

/** Keys for a pane, through the bridge's key route (the Keys pad). */
export function sendKeys(paneId: string, keys: string[]): Promise<ActionResponse> {
  return req<ActionResponse>(`/api/pane/${encodeURIComponent(paneId)}/keys`, {
    method: "POST",
    body: JSON.stringify({ keys }),
  });
}

/** How long one upload may take before it fails (as v1). */
export const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Upload one attachment for a pane. The reply's `path` is where the agent can read it. Multipart, so
 * it does not go through `req` (the browser sets the boundary).
 */
export async function uploadImage(paneId: string, file: File): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append("file", file);
  const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(UPLOAD_TIMEOUT_MS) : undefined;
  const res = await fetch(`/api/pane/${encodeURIComponent(paneId)}/upload`, {
    method: "POST",
    body: fd,
    headers: { [XHR_HEADER]: XHR_HEADER_VALUE },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    noteIfLocked(res);
    let detail = "";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // not JSON
    }
    return { ok: false, error: detail || `Upload failed (${res.status})` };
  }
  return (await res.json()) as UploadResponse;
}
