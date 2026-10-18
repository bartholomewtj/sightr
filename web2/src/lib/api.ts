// The non-v2 bridge calls web2 needs: the lock endpoints (copied from web/src/lib/api.ts, same
// `/api/lock/*` routes) and the request headers every web2 call sends.
import { BUILD_HEADER, SEEN_HEADER } from "@shared/limits";
import { V2_SEARCH_PATH, type ThreadSearchResponse } from "@shared/v2/contracts";
import type {
  ActionResponse,
  BridgeConfig,
  BridgeSettingKey,
  BridgeSettings,
  BridgeSettingsView,
  FileSearchResponse,
  FileResolveResponse,
  FilesResponse,
  FolderGitDiffResponse,
  FolderGitResponse,
  LockStatus,
  NotifyPrefs,
  PaneFolderResponse,
  PaneReadResponse,
  SaveFileResponse,
  UploadResponse,
} from "@shared/wire";
import { fetchClassOf, timedFetch } from "@v1/lib/conn-telemetry";

import { noteLockRequired } from "./lock";
import type { DecisionReplyRequest } from "@shared/wire";

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

/**
 * Keys for a pane, through the bridge's key route (the Keys pad, and T13's direct typing). `typed`
 * marks keystrokes the operator typed: the bridge then writes runs of plain characters in one go (as
 * v1). The reply guard never runs on this route.
 */
export function sendKeys(paneId: string, keys: string[], typed?: boolean): Promise<ActionResponse> {
  return req<ActionResponse>(`/api/pane/${encodeURIComponent(paneId)}/keys`, {
    method: "POST",
    body: JSON.stringify({ keys, ...(typed ? { typed: true } : {}) }),
  });
}

/**
 * Answer a whistlr-marked operator decision (T19): v1's route, copied from web/src/lib/api.ts. The
 * bridge runs `whistlr reply`; nothing is typed into the pane. `{ ok: false, error }` is the bridge's
 * own refusal (no marker, whistlr failed, pane busy).
 */
export function decisionReply(paneId: string, body: DecisionReplyRequest): Promise<ActionResponse> {
  return req<ActionResponse>(`/api/pane/${encodeURIComponent(paneId)}/decision-reply`, {
    method: "POST",
    body: JSON.stringify(body),
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

// ── T13: the right panel's reads (copied from web/src/lib/api.ts, same routes) ─────────────────

/** Short leash on reads, longer on writes, as v1 (`GET_TIMEOUT_MS`, `MUTATION_TIMEOUT_MS`). */
const GET_TIMEOUT_MS = 10_000;
const MUTATION_TIMEOUT_MS = 20_000;

function withTimeout(signal: AbortSignal | null | undefined, ms: number): AbortSignal | undefined {
  if (typeof AbortSignal.timeout !== "function") return signal ?? undefined;
  const timeoutSignal = AbortSignal.timeout(ms);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any !== "function") return signal;
  return AbortSignal.any([signal, timeoutSignal]);
}

/** A bridge refusal, with its status (v1's `ApiError`). */
export class ApiError extends Error {
  readonly status: number;
  /** The bridge's own words for the refusal (its response body), when it gave any. */
  readonly detail: string;
  constructor(message: string, status: number, detail = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function readJson<T>(path: string, init: RequestInit = {}, recover?: (status: number, detail: string) => T | null): Promise<T> {
  const method = init.method?.toUpperCase() ?? "GET";
  const res = await timedFetch(fetchClassOf(path, method), () =>
    fetch(path, {
      ...init,
      signal: withTimeout(init.signal, method === "GET" ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS),
      headers: { "content-type": "application/json", [XHR_HEADER]: XHR_HEADER_VALUE, ...init.headers },
    }),
  );
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* no body */
    }
    const recovered = recover?.(res.status, detail);
    if (recovered !== null && recovered !== undefined) return recovered;
    noteIfLocked(res);
    throw new ApiError(`${path} -> ${res.status} ${detail}`, res.status, detail.trim());
  }
  return (await res.json()) as T;
}

// The mirror's ETag cache (v1 `fetchPane`): a 304 hands back the cached body, so an unchanged poll
// keeps the text. Client-managed; the bridge sends `cache-control: no-store`.
interface PaneCacheEntry {
  etag: string;
  response: PaneReadResponse;
}
const paneCache = new Map<string, PaneCacheEntry>();
const PANE_CACHE_MAX = 20;

/** Drop the cached ETag and body so the next read is unconditional. */
export function invalidatePaneCache(paneId: string): void {
  paneCache.delete(paneId);
}

/** Test helper. */
export function __resetPaneCache(): void {
  paneCache.clear();
}

/**
 * One read of a pane's screen (`GET /api/pane/:id`, telemetry class `pane`). The only place v2 calls
 * it is the Terminal tab (T13). `notModified` is set when the bridge answered 304.
 */
export async function fetchPane(
  paneId: string,
  lines?: number,
  signal?: AbortSignal,
): Promise<PaneReadResponse & { notModified?: boolean }> {
  const url = `/api/pane/${encodeURIComponent(paneId)}${lines ? `?lines=${lines}` : ""}`;
  const cached = paneCache.get(paneId);
  const headers: Record<string, string> = { [SEEN_HEADER]: "1", [XHR_HEADER]: XHR_HEADER_VALUE };
  if (cached) headers["if-none-match"] = cached.etag;
  const res = await timedFetch(fetchClassOf(url), () => fetch(url, { signal: withTimeout(signal, GET_TIMEOUT_MS), headers }));
  if (res.status === 304 && cached) return { ...cached.response, notModified: true };
  if (!res.ok) {
    noteIfLocked(res);
    throw new ApiError(`${url} -> ${res.status}`, res.status);
  }
  const data = (await res.json()) as PaneReadResponse;
  const etag = res.headers.get("etag");
  if (etag) {
    paneCache.delete(paneId);
    paneCache.set(paneId, { etag, response: data });
    if (paneCache.size > PANE_CACHE_MAX) {
      const oldest = paneCache.keys().next().value;
      if (oldest !== undefined) paneCache.delete(oldest);
    }
  }
  return data;
}

/** Where a pane's folder sits in the Files root (`""` is the root); null when it is outside it. */
export function fetchPaneFolder(paneId: string, signal?: AbortSignal): Promise<PaneFolderResponse> {
  return readJson<PaneFolderResponse>(`/api/files/pane-folder?pane=${encodeURIComponent(paneId)}`, signal ? { signal } : {});
}

export function fetchFiles(path: string, signal?: AbortSignal): Promise<FilesResponse> {
  return readJson<FilesResponse>(`/api/files?path=${encodeURIComponent(path)}`, signal ? { signal } : {});
}

export function searchFiles(q: string, signal?: AbortSignal): Promise<FileSearchResponse> {
  return readJson<FileSearchResponse>(`/api/files/search?q=${encodeURIComponent(q)}`, signal ? { signal } : {});
}

/** Message search across threads (`GET /api/v2/search`): user and assistant text and command inputs. */
export function searchThreads(q: string, signal?: AbortSignal, limit = 8): Promise<ThreadSearchResponse> {
  return readJson<ThreadSearchResponse>(`${V2_SEARCH_PATH}?q=${encodeURIComponent(q)}&limit=${limit}`, signal ? { signal } : {});
}

export function downloadFileUrl(path: string): string {
  return `/api/files/download?path=${encodeURIComponent(path)}`;
}

/** The sandboxed open URL (ADR 0027): one segment per name so a page's relative links resolve. */
export function openFileUrl(path: string): string {
  return `/api/files/open/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}

function recoverFileBusy(status: number, detail: string): ActionResponse | null {
  if (status !== 409) return null;
  try {
    const body = JSON.parse(detail) as { ok?: unknown; error?: unknown };
    if (body.ok === false && typeof body.error === "string") return { ok: false, error: body.error };
  } catch {
    /* fixed fallback */
  }
  return { ok: false, error: "file is in use" };
}

export function deleteFile(path: string): Promise<ActionResponse> {
  return readJson<ActionResponse>("/api/files/delete", { method: "POST", body: JSON.stringify({ path }) }, recoverFileBusy);
}

function recoverFileSave(status: number, detail: string): SaveFileResponse | null {
  if (status !== 409 && status !== 413) return null;
  try {
    const body = JSON.parse(detail) as { error?: unknown };
    if (typeof body.error === "string") return { ok: false, error: body.error };
  } catch {
    /* fallback */
  }
  return { ok: false, error: status === 413 ? "file too large" : "not saved" };
}

export function saveFile(path: string, text: string, mtimeMs: number): Promise<SaveFileResponse> {
  return readJson<SaveFileResponse>("/api/files/save", { method: "POST", body: JSON.stringify({ path, text, mtimeMs }) }, recoverFileSave);
}

/** Loopback listeners on the PC, opened over the tailnet (spec 23). */
export interface LocalServer {
  port: number;
  name: string;
}
export interface LocalServersResponse {
  host: string;
  servers: LocalServer[];
}
export function fetchLocalServers(signal?: AbortSignal): Promise<LocalServersResponse> {
  return readJson<LocalServersResponse>("/api/local-servers", signal ? { signal } : {});
}

/** Read-only git status and diff for the repo around a Files folder, plus which panes sit in it. */
const MAX_GIT_PANES = 50;
export function fetchFolderGit(path: string, paneIds: string[], signal?: AbortSignal): Promise<FolderGitResponse> {
  const q = new URLSearchParams();
  q.set("path", path);
  for (const id of paneIds.slice(0, MAX_GIT_PANES)) q.append("pane", id);
  return readJson<FolderGitResponse>(`/api/files/git?${q}`, signal ? { signal } : {});
}

/** One commit's diff, or the branch range against its base, for the repo around a Files folder. Read-only. */
export function fetchFolderGitDiff(path: string, scope: { scope: "commit"; sha: string } | { scope: "branch" }, signal?: AbortSignal): Promise<FolderGitDiffResponse> {
  const q = new URLSearchParams();
  q.set("path", path);
  q.set("scope", scope.scope);
  if (scope.scope === "commit") q.set("sha", scope.sha);
  return readJson<FolderGitDiffResponse>(`/api/files/git/diff?${q}`, signal ? { signal } : {});
}

/** A path as an agent printed it (absolute, or relative to the pane's folder) as a Files rel path, or why not. */
export function resolveFilePath(paneId: string | null, path: string, signal?: AbortSignal): Promise<FileResolveResponse> {
  const q = new URLSearchParams();
  q.set("path", path);
  if (paneId) q.set("pane", paneId);
  return readJson<FileResolveResponse>(`/api/files/resolve?${q}`, signal ? { signal } : {});
}

// ── T18: Settings (copied from web/src/lib/api.ts, same routes) ─────────────────────────────────

/** True when an API request failed with the given HTTP status (v1's `isApiErrorStatus`). */
export function isApiErrorStatus(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.status === status;
}

export function registerWebauthn(body: {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  attestationObject: string;
  name: string;
}): Promise<{ ok: boolean }> {
  return req<{ ok: boolean }>("/api/lock/webauthn/register", { method: "POST", body: JSON.stringify(body) });
}

export function removeWebauthn(id: string): Promise<{ ok: boolean }> {
  return req<{ ok: boolean }>("/api/lock/webauthn/remove", { method: "POST", body: JSON.stringify({ id }) });
}

export function clearLock(): Promise<{ ok: boolean }> {
  return req<{ ok: boolean }>("/api/lock/clear-all", { method: "POST" });
}

/** The bridge-wide notification types (which statuses push). */
export function getNotifyPrefs(): Promise<NotifyPrefs> {
  return readJson<NotifyPrefs>("/api/notifications/prefs");
}

/** A partial patch; every device gets the merged result. */
export function setNotifyPrefs(patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
  return readJson<NotifyPrefs>("/api/notifications/prefs", { method: "POST", body: JSON.stringify(patch) });
}

export function getBridgeSettings(): Promise<BridgeSettingsView> {
  return readJson<BridgeSettingsView>("/api/settings");
}

/** Patch values and/or `reset` keys back to their `.env` value. */
export function setBridgeSettings(patch: Partial<BridgeSettings> & { reset?: BridgeSettingKey[] }): Promise<BridgeSettingsView> {
  return readJson<BridgeSettingsView>("/api/settings", { method: "POST", body: JSON.stringify(patch) });
}

/**
 * The build id of the web2 bundle the bridge serves now (its `x-sightr-build` header on web2's own
 * files), for Settings → Connection. Asks for `sw.js`: the service worker never precaches itself, so
 * the answer comes from the bridge, not from a cache. null when the bridge does not say.
 */
export async function fetchServerBuild(base: string = import.meta.env.BASE_URL): Promise<string | null> {
  const res = await fetch(`${base}sw.js`, { method: "HEAD", cache: "no-store", headers: { [XHR_HEADER]: XHR_HEADER_VALUE } });
  return res.ok ? res.headers.get(BUILD_HEADER) : null;
}
