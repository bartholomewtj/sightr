// The non-v2 bridge calls web2 needs: the lock endpoints (copied from web/src/lib/api.ts, same
// `/api/lock/*` routes) and the request headers every web2 call sends.
import type { LockStatus } from "@shared/wire";

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
