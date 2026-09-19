// Thin REST client for the bridge. Everything is same-origin, so credentials/headers are
// minimal. Each call throws on a non-2xx so callers (route loaders / action handlers) surface errors.

import { trackBusy } from "./busy";
import { noteLockRequired } from "./lock";
import { markLive } from "./connection-health";
import { observeServerBuild, SERVER_BUILD_HEADER } from "./server-build";
import { SEEN_HEADER } from "@shared/limits";
import { EVENTS_PATH } from "./sw-routes";
import type {
  ActionResponse,
  DecisionReplyRequest,
  FileSearchResponse,
  FilesResponse,
  BridgeConfig,
  CreateResponse,
  NotifyPrefs,
  BridgeSettings,
  PaneHistoryResponse,
  PaneReadResponse,
  SnapshotResponse,
  UploadResponse,
  FolderGitResponse,
  LockStatus,
  SaveFileResponse,
} from "./types";

export type { NotifyPrefs, BridgeSettings };

/**
 * Marks every API request as XHR so a fronting identity proxy answers it with a status we can read.
 *
 * The refusal banner (components/connection-banner.tsx) is reached only through `isAuthError`
 * (lib/loaders.ts), which matches 401/403 on an {@link ApiError}. A proxy that answers an
 * unauthenticated request with a REDIRECT never produces one: `fetch` follows the 302 to the
 * identity provider's origin, that response carries no CORS headers, and the call rejects as a
 * `TypeError` — a transport failure with no status. The user then gets the connection banner
 * ("can't reach Sightr") and, worse, loses the Sign-in link that would have fixed it, since a
 * missing session is precisely the thing it recovers from.
 *
 * Measured against Cloudflare Access with no session: a plain request, `Accept: application/json`
 * and `Sec-Fetch-Mode: cors` all still redirect; only this header flips the answer to a same-origin
 * 401. `X-Requested-With: XMLHttpRequest` is the conventional "this is XHR, don't redirect me"
 * signal rather than one vendor's feature — oauth2-proxy and Authelia read it too — so it stays a
 * single unconditional header with no proxy-specific branching, in keeping with a bridge that gates
 * on vendor-neutral headers and manages nobody else's front door (ADR 0001).
 *
 * Costs nothing against the bridge itself: it is same-origin by design, so no preflight in practice,
 * and the bridge ignores headers it does not read.
 */
export const XHR_HEADER = "x-requested-with";
export const XHR_HEADER_VALUE = "XMLHttpRequest";
const LOCK_HEADER = "x-sightr-lock";
export class ApiError extends Error {
  readonly status: number;
  readonly lockRequired: boolean;
  constructor(message: string, status: number, lockRequired = false) {
    super(message); this.name = "ApiError"; this.status = status; this.lockRequired = lockRequired;
  }
}
export function isLockRequiredError(error: unknown): boolean {
  return error instanceof ApiError && error.lockRequired;
}

/** True when an API request failed with the given HTTP status. */
export function isApiErrorStatus(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.status === status;
}

// Every request gets a deadline so a black-holed connection (phone sleep/wake, a Tailscale route
// that goes dark) can't leave a fetch pending forever — which would zombify the app: the poller
// gates on `revalidator.state === "idle"` and never fires again, and route navigations wait on a
// loader that never settles. On timeout the fetch aborts with a DOMException named "TimeoutError";
// the loaders rethrow ONLY "AbortError" (a superseded revalidation), so a timeout falls into their
// catch → stale-data-with-error, and the poller/nav can retry. Budgets by request class:
//   - GET reads (snapshot/pane polls) are small and frequent — a short leash surfaces a dead link
//     fast so the UI can show "reconnecting…" and retry on the next tick.
const GET_TIMEOUT_MS = 10_000;
//   - Mutations drive a real terminal on the host, which can legitimately take a beat — more slack.
const MUTATION_TIMEOUT_MS = 20_000;
//   - Uploads carry a whole file over the phone's uplink — the most generous budget.
const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Compose the caller's abort signal (a loader's `request.signal`, used to supersede a stale poll)
 * with a fresh timeout signal, so a fetch aborts on EITHER cause. Returns the timeout signal alone
 * when there's no caller signal. Runtime-guarded: on an older WebView missing `AbortSignal.timeout`
 * or `AbortSignal.any` we return the caller's signal unchanged rather than crash — degrading to the
 * old no-timeout behaviour instead of taking the app down.
 *
 * Exported for unit tests (the timeout wiring is otherwise unobservable).
 */
function withTimeout(
  signal: AbortSignal | null | undefined,
  ms: number,
): AbortSignal | undefined {
  if (typeof AbortSignal.timeout !== "function") return signal ?? undefined;
  const timeoutSignal = AbortSignal.timeout(ms);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any !== "function") return signal;
  return AbortSignal.any([signal, timeoutSignal]);
}

// Best-effort human-readable failure detail: the response body if present, else the status text.
async function errorDetail(res: Response): Promise<string> {
  try {
    return (await res.text()) || res.statusText;
  } catch {
    return res.statusText;
  }
}

/**
 * The recover handler for the two endpoints that accept `expected_prompt`: reply and keys. A
 * rejected binding is their normal answer, not a transport failure. The bridge refuses the write
 * because the prompt moved, and the caller renders "the dialog changed". Both must share it, or one
 * of them starts throwing where the other returns a value.
 */
const recoverPromptChanged = (status: number, detail: string): ActionResponse | null =>
  status === 409 ? promptChangedResponse(detail) : null;

function recoverFileBusy(status: number, detail: string): ActionResponse | null {
  if (status !== 409) return null;
  try {
    const body = JSON.parse(detail) as { ok?: unknown; error?: unknown };
    if (body.ok === false && typeof body.error === "string") return { ok: false, error: body.error };
  } catch { /* fixed fallback */ }
  return { ok: false, error: "file is in use" };
}

export function deleteFile(path: string): Promise<ActionResponse> {
  return req<ActionResponse>("/api/files/delete", {
    method: "POST", body: JSON.stringify({ path }),
  }, recoverFileBusy);
}

function recoverFileSave(status: number, detail: string): SaveFileResponse | null {
  if (status === 413) {
    try { const body = JSON.parse(detail) as { error?: unknown }; if (typeof body.error === "string") return { ok: false, error: body.error }; } catch { /* fallback */ }
    return { ok: false, error: "file too large" };
  }
  if (status !== 409) return null;
  try { const body = JSON.parse(detail) as { ok?: unknown; error?: unknown }; if (body.ok === false && typeof body.error === "string") return { ok: false, error: body.error }; } catch { /* fallback */ }
  return { ok: false, error: "not saved" };
}

export function saveFile(path: string, text: string, mtimeMs: number): Promise<SaveFileResponse> {
  return req<SaveFileResponse>("/api/files/save", {
    method: "POST", body: JSON.stringify({ path, text, mtimeMs }),
  }, recoverFileSave);
}

function promptChangedResponse(detail: string): ActionResponse | null {
  try {
    const body = JSON.parse(detail) as {
      ok?: unknown;
      code?: unknown;
      error?: unknown;
    };
    if (
      body.ok === false &&
      body.code === "prompt_changed" &&
      typeof body.error === "string"
    ) {
      return { ok: false, error: body.error, code: "prompt_changed" };
    }
  } catch {
    // A non-JSON error body follows the existing ApiError path below.
  }
  return null;
}

// Capture the bridge's build id off any response that carries it. Every poll (snapshot/pane) — and
// config + mutations — funnels through the two fetch sites below, so the store stays current for
// free, powering the Settings server-build row. Absent header (older
// bridge) → no-op, so nothing activates.
function captureBuild(res: Response): void {
  observeServerBuild(res.headers.get(SERVER_BUILD_HEADER));
}

/**
 * Lets ONE caller claim a non-ok response instead of having it thrown. The transport stays generic:
 * it knows a caller may recognise a refusal and turn it into a normal value, but nothing about which
 * status or which body shape. Return null to fall through to the usual {@link ApiError}.
 */
type Recover<T> = (status: number, detail: string) => T | null;

async function doReq<T>(path: string, init?: RequestInit, recover?: Recover<T>): Promise<T> {
  // GET reads get the short leash; anything mutating gets the longer mutation budget.
  const method = init?.method?.toUpperCase() ?? "GET";
  const timeoutMs = method === "GET" ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS;
  const res = await fetch(path, {
    ...init,
    signal: withTimeout(init?.signal, timeoutMs),
    headers: {
      "content-type": "application/json",
      [XHR_HEADER]: XHR_HEADER_VALUE,
      ...init?.headers,
    },
  });
  captureBuild(res);
  if (!res.ok) {
    const detail = await errorDetail(res);
    const recovered = recover?.(res.status, detail);
    if (recovered !== null && recovered !== undefined) return recovered;
    const lockRequired = res.headers.get(LOCK_HEADER) === "required";
    if (lockRequired) noteLockRequired();
    throw new ApiError(`${path} → ${res.status} ${detail}`, res.status, lockRequired);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Every mutating request (non-GET) feeds the app-wide busy signal so the top progress bar shows
// while it's in flight; GET reads (snapshot/config polling) don't, or the bar would never rest.
// trackBusy increments synchronously, so a caller sees `isBusy()` true the instant it fires.
function req<T>(path: string, init?: RequestInit, recover?: Recover<T>): Promise<T> {
  const op = doReq<T>(path, init, recover);
  const method = init?.method?.toUpperCase() ?? "GET";
  return method === "GET" ? op : trackBusy(op);
}

/** Read-only git status and diff for the enclosing repo of a Files folder, plus panes inside it. */
const MAX_GIT_PANES = 50;
export function fetchFolderGit(path: string, paneIds: string[], signal?: AbortSignal): Promise<FolderGitResponse> {
  const q = new URLSearchParams(); q.set("path", path); for (const id of paneIds.slice(0, MAX_GIT_PANES)) q.append("pane", id);
  return req<FolderGitResponse>(`/api/files/git?${q}`, { signal });
}
export function fetchFiles(path: string, signal?: AbortSignal): Promise<FilesResponse> {
  return req<FilesResponse>(`/api/files?path=${encodeURIComponent(path)}`, { signal });
}
export function searchFiles(q: string, signal?: AbortSignal): Promise<FileSearchResponse> {
  return req<FileSearchResponse>(`/api/files/search?q=${encodeURIComponent(q)}`, { signal });
}
export function downloadFileUrl(path: string): string {
  return `/api/files/download?path=${encodeURIComponent(path)}`;
}
export function openFileUrl(path: string): string {
  return `/api/files/open/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}

const EVENT_CLIENT_ID = typeof crypto !== "undefined" && "randomUUID" in crypto
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random()}`;

export function openSnapshotStream(
  onSnapshot: (snapshot: SnapshotResponse) => void,
  onError: () => void,
): EventSource {
  const query = new URLSearchParams({ client: EVENT_CLIENT_ID });
  const path = `${EVENTS_PATH}?${query}`;
  const source = new EventSource(path);
  source.addEventListener("snapshot", (event) => {
    try { onSnapshot(JSON.parse((event as MessageEvent).data) as SnapshotResponse); } catch { onError(); }
  });
  source.addEventListener("build", (event) => {
    try { observeServerBuild(JSON.parse((event as MessageEvent).data) as string); } catch { /* older bridge */ }
  });
  source.addEventListener("error", onError);
  return source;
}

export async function fetchSnapshot(signal?: AbortSignal): Promise<SnapshotResponse> {
  const snap = await req<SnapshotResponse>("/api/snapshot", { signal });
  // A snapshot whose herd link is UP is a provably-live moment — stamp the shared connection-health
  // anchor so escalation is measured from here. A snapshot that 200s but reports `bridge:
  // "disconnected"` is NOT live (the pill/banner still escalate on it), so it must NOT reset the
  // clock, or the "Herdr is down" escalation could never surface.
  if (snap.bridge !== "disconnected") markLive();
  return snap;
}

// Per-pane cache of the last ETag AND the body it belongs to, kept together on purpose. We send
// If-None-Match on the next poll to skip re-transferring unchanged scrollback; on a 304 we return
// the cached body (with its text) so the mirror stays populated. Two invariants make this safe:
//   1. The ETag is recorded ONLY together with its response — never on its own.
//   2. It is recorded only AFTER the body parses successfully, so a transient parse/abort (e.g. a
//      bridge restart truncating an in-flight read) can't leave an ETag with no text behind — which
//      would otherwise make every later poll 304 into an empty mirror (a permanent blank pane).
// Entirely client-managed — we never rely on the browser HTTP cache (the server sends
// cache-control: no-store for privacy). Module-scoped, so it lives for the page's lifetime.
interface PaneCacheEntry {
  etag: string;
  response: PaneReadResponse;
}
const paneCache = new Map<string, PaneCacheEntry>();
// Bound the cache so it can't grow forever across a long session of opening many panes. Evict the
// oldest (insertion-order) entry beyond the cap — a plain FIFO is fine here (each entry is one
// pane's last body). 20 comfortably covers any panes in flight on a phone.
const PANE_CACHE_MAX = 20;

/** Drop the cached ETag/body for a pane so the next read is unconditional. Used after shell keys. */
export function invalidatePaneCache(paneId: string): void {
  paneCache.delete(paneId);
}

export async function fetchPane(
  paneId: string,
  lines?: number,
  signal?: AbortSignal,
): Promise<PaneReadResponse> {
  const q = lines ? `?lines=${lines}` : "";
  const url = `/api/pane/${encodeURIComponent(paneId)}${q}`;
  const cacheKey = paneId;

  const cached = paneCache.get(cacheKey);
  // SEEN_HEADER is what tells the bridge this read came from our own page and may mark the pane
  // seen. A cross-site no-cors GET can't set a custom header, so it can't clear your alerts by
  // guessing pane ids (bridge/server.ts → marksPaneSeen).
  const headers: Record<string, string> = {
    [SEEN_HEADER]: "1",
    [XHR_HEADER]: XHR_HEADER_VALUE,
  };
  if (cached) headers["if-none-match"] = cached.etag;

  const res = await fetch(url, { signal: withTimeout(signal, GET_TIMEOUT_MS), headers });
  captureBuild(res); // pane polls carry the build header too (incl. 304s) — keep the store fresh

  if (res.status === 304 && cached) {
    // Unchanged — hand back the cached body (text included) so the mirror keeps its content. An
    // unchanged poll is still a live poll: stamp the connection-health anchor (a 304 counts as live).
    markLive();
    return { ...cached.response, notModified: true };
  }

  if (!res.ok) {
    const lockRequired = res.headers.get(LOCK_HEADER) === "required";
    if (lockRequired) noteLockRequired();
    throw new ApiError(`${url} → ${res.status} ${await errorDetail(res)}`, res.status, lockRequired);
  }

  // Parse the body BEFORE recording the ETag, so the cache only ever holds an (etag, text) pair
  // that actually arrived intact.
  const data = (await res.json()) as PaneReadResponse;
  const etag = res.headers.get("etag");
  if (etag) {
    paneCache.set(cacheKey, { etag, response: data });
    if (paneCache.size > PANE_CACHE_MAX) {
      const oldest = paneCache.keys().next().value;
      if (oldest !== undefined) paneCache.delete(oldest);
    }
  }

  // A pane body served from Herdr is provably-live data — stamp the connection-health anchor.
  markLive();
  return data;
}

/**
 * Fetch a page of the pane's conversation history — the scrollback its terminal can't hold (a Claude
 * pane runs on the alternate screen, which has no scrollback ring). Newest-anchored: no cursor gives
 * the most recent turns; `before` walks backwards from a turn already on screen.
 *
 * Deliberately NOT ETag-cached like fetchPane: history is fetched on navigation and on an explicit
 * "load older" tap, never on the poll loop, so there's no repeat-fetch to save.
 */
export function fetchHistory(
  paneId: string,
  opts: { limit?: number; before?: string } = {},
  signal?: AbortSignal,
): Promise<PaneHistoryResponse> {
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.before) q.set("before", opts.before);
  const qs = q.toString();
  const path = `/api/pane/${encodeURIComponent(paneId)}/history${qs ? `?${qs}` : ""}`;
  // Reading the transcript is looking at the pane — and history is a READ, so like fetchPane it
  // carries the header that lets the bridge count it (bridge/server.ts → marksPaneSeen).
  return req<PaneHistoryResponse>(path, {
    signal,
    headers: { [SEEN_HEADER]: "1" }
  });
}

export function sendReply(
  paneId: string,
  text: string,
  submit = true,
  expectedPrompt?: string,
  submitKeys?: string[],
): Promise<ActionResponse> {
  return req<ActionResponse>(
    `/api/pane/${encodeURIComponent(paneId)}/reply`,
    {
      method: "POST",
      body: JSON.stringify({
        text,
        submit,
        ...(expectedPrompt !== undefined ? { expected_prompt: expectedPrompt } : {}),
        ...(submitKeys && submitKeys.length > 0 ? { submit_keys: submitKeys } : {}),
      }),
    },
    recoverPromptChanged,
  );
}

export function sendKeys(
  paneId: string,
  keys: string[],
  expectedPrompt?: string,
): Promise<ActionResponse> {
  return req<ActionResponse>(
    `/api/pane/${encodeURIComponent(paneId)}/keys`,
    {
      method: "POST",
      body: JSON.stringify({
        keys,
        ...(expectedPrompt !== undefined ? { expected_prompt: expectedPrompt } : {}),
      }),
    },
    recoverPromptChanged,
  );
}

export function decisionReply(
  paneId: string,
  body: DecisionReplyRequest,
): Promise<ActionResponse> {
  return req<ActionResponse>(
    `/api/pane/${encodeURIComponent(paneId)}/decision-reply`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    recoverPromptChanged,
  );
}

/** Close a pane ("kill the agent"). */
export function closePane(paneId: string): Promise<ActionResponse> {
  return req<ActionResponse>(`/api/pane/${encodeURIComponent(paneId)}/close`, {
    method: "POST",
  });
}

/** Set (or clear) a pane's label. An empty/blank `label` clears it (the bridge sends `null` on). */
export function renamePane(
  paneId: string,
  label: string,
): Promise<ActionResponse> {
  return req<ActionResponse>(`/api/pane/${encodeURIComponent(paneId)}/rename`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

/** Set a tab's label. Non-empty required — a tab has no "clear" (the bridge 400s a blank label). */
export function renameTab(
  tabId: string,
  label: string,
): Promise<ActionResponse> {
  return req<ActionResponse>(`/api/tab/${encodeURIComponent(tabId)}/rename`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

/** Set a space's (workspace's) label. Non-empty required — like a tab, a space has no "clear". */
export function renameSpace(
  workspaceId: string,
  label: string,
): Promise<ActionResponse> {
  return req<ActionResponse>(
    `/api/workspace/${encodeURIComponent(workspaceId)}/rename`,
    { method: "POST", body: JSON.stringify({ label }) },
  );
}

/** Close a tab, killing every pane inside it. */
export function closeTab(tabId: string): Promise<ActionResponse> {
  return req<ActionResponse>(`/api/tab/${encodeURIComponent(tabId)}/close`, {
    method: "POST",
  });
}

/** Close a space. `closeGroup` closes the whole linked-worktree group (Herdr requires it on the parent). */
export function closeSpace(
  workspaceId: string,
  opts: { closeGroup?: boolean } = {},
): Promise<ActionResponse> {
  return req<ActionResponse>(
    `/api/workspace/${encodeURIComponent(workspaceId)}/close`,
    { method: "POST", body: JSON.stringify({ closeGroup: !!opts.closeGroup }) },
  );
}

/** Delete a linked worktree checkout (`git worktree remove`). `force` for a dirty tree. */
export function removeWorktree(
  workspaceId: string,
  opts: { force?: boolean } = {},
): Promise<ActionResponse> {
  return req<ActionResponse>(
    `/api/workspace/${encodeURIComponent(workspaceId)}/worktree/remove`,
    { method: "POST", body: JSON.stringify({ force: !!opts.force }) },
  );
}

/** Open an existing Git worktree as a space, grouped with the parent repo. */
export function openWorktree(
  opts: { workspaceId?: string; cwd?: string; path?: string; branch?: string },
): Promise<CreateResponse> {
  return req<CreateResponse>("/api/worktree/open", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

/** Create a new tab in a space, opening a fresh shell pane. `cwd` omitted = inherits the space dir. */
export function createTab(
  workspaceId: string,
  opts: { label?: string; cwd?: string } = {},
): Promise<CreateResponse> {
  return req<CreateResponse>("/api/tab", {
    method: "POST",
    body: JSON.stringify({ workspaceId, ...opts }),
  });
}

/** Create a new space (workspace) with a fresh shell pane. `cwd` omitted = the host's home dir. */
export function createWorkspace(
  opts: { label?: string; cwd?: string } = {},
): Promise<CreateResponse> {
  return req<CreateResponse>("/api/workspace", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export function fetchConfig(): Promise<BridgeConfig> {
  return req<BridgeConfig>("/api/config");
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
const recoverUnlock = (status: number) => (status === 401 ? { ok: false } : null);
export function unlockWebauthn(body: {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}): Promise<{ ok: boolean }> {
  return req("/api/lock/webauthn/unlock", { method: "POST", body: JSON.stringify(body) }, recoverUnlock);
}
export function registerWebauthn(body: {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  attestationObject: string;
  name: string;
}) {
  return req<{ ok: boolean }>("/api/lock/webauthn/register", { method: "POST", body: JSON.stringify(body) });
}
export function removeWebauthn(id: string) {
  return req<{ ok: boolean }>("/api/lock/webauthn/remove", { method: "POST", body: JSON.stringify({ id }) });
}
export function clearLock() {
  return req<{ ok: boolean }>("/api/lock/clear-all", { method: "POST" });
}

/** Fetch the bridge-wide notification-type preferences (which agent statuses push). */
export function getNotifyPrefs(): Promise<NotifyPrefs> {
  return req<NotifyPrefs>("/api/notifications/prefs");
}

/**
 * Update the notification-type preferences with a partial patch (only the keys you send change).
 * Bridge-wide — it affects every device. Returns the merged prefs.
 */
export function setNotifyPrefs(patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
  return req<NotifyPrefs>("/api/notifications/prefs", {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

export function getBridgeSettings(): Promise<BridgeSettings> { return req<BridgeSettings>("/api/settings"); }
export function setBridgeSettings(patch: Partial<BridgeSettings>): Promise<BridgeSettings> {
  return req<BridgeSettings>("/api/settings", { method: "POST", body: JSON.stringify(patch) });
}

export function uploadImage(paneId: string, file: File): Promise<UploadResponse> {
  // Multipart, so it bypasses `req` (the browser sets the boundary) — track it explicitly instead.
  return trackBusy(
    (async () => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/pane/${encodeURIComponent(paneId)}/upload`, {
        method: "POST",
        body: fd,
        // No content-type: the browser sets the multipart boundary. The XHR marker still applies —
        // an upload refused by a lapsed proxy session must surface as a status, not a redirect.
        headers: { [XHR_HEADER]: XHR_HEADER_VALUE },
        signal: withTimeout(undefined, UPLOAD_TIMEOUT_MS),
      });
      if (!res.ok) {
        const lockRequired = res.headers.get(LOCK_HEADER) === "required";
        if (lockRequired) noteLockRequired();
        throw new ApiError(`upload → ${res.status} ${await errorDetail(res)}`, res.status, lockRequired);
      }
      return (await res.json()) as UploadResponse;
    })(),
  );
}
