// React Router data loaders are the data layer — there is intentionally no separate data-fetching
// library. The home/detail routes declare these as `loader`s; polling is just
// `useRevalidator().revalidate()` re-running them (see hooks/use-polling.ts). Each loader keeps the
// last good result in a module cache so a transient fetch failure shows stale-but-present data
// (flagged) instead of flashing empty — i.e. keep-previous-data while a refetch is in flight.
//
// Offline fast path (a PWA should navigate instantly to last-known data): during a KNOWN, escalated
// outage (the shared connection-health store has latched "lost"), a NAVIGATION must not block on a
// fetch that will only time out — it returns cached data immediately (flagged error). A REVALIDATION
// (the poll) must keep really fetching so recovery is discovered and the stale data swapped out. React
// Router never tells a loader which kind of run it is, but the request URL does: a revalidation re-runs
// a loader at the SAME url; a navigation runs it at a DIFFERENT one (see isNavigation below). No timer,
// no flag, no race — and because a navigation aborts any in-flight revalidation, the nav is instant
// even while a poll's doomed fetch is still hanging.

import { fetchFiles, fetchPane, fetchSnapshot, isApiErrorStatus, isLockRequiredError } from "@/lib/api";
import { withDialogPresence } from "@/lib/dialog-presence";
import { parseLines } from "@/lib/blocks";
import { isLostLatched, markLive } from "@/lib/connection-health";
import {
  dropLastPaneText,
  loadLastPaneText,
  loadLastSnapshot,
  saveLastPaneText,
  saveLastSnapshot,
} from "@/lib/last-seen";
import { detectNoEchoPrompt } from "@/lib/no-echo";
import type {
  AgentView,
  BridgeStatus,
  DeviceAuth,
  PaneReadResponse,
  SnapshotResponse,
  TabView,
  WorkspaceView,
  FilesResponse,
} from "@/lib/types";

// A superseded revalidation is aborted via the loader's request.signal; that surfaces as an
// AbortError we must RETHROW so React Router discards the stale run — swallowing it into the
// stale-data/error-banner path would flash a spurious "reconnecting…" on every fast poll.
function isAbortError<TThrown>(e: TThrown): boolean {
  // `fetch` rejects an aborted request with a DOMException, which is an Error subclass in every
  // engine Sighter runs in (and in jsdom) — so an `instanceof Error` test reaches it without having
  // to inspect the shape of an arbitrary thrown value.
  return e instanceof Error && e.name === "AbortError";
}

// The root route's id, paired with rootLoader. Children read its data via
// `useRouteLoaderData(ROOT_ROUTE_ID)`; keeping it a constant means a rename is a single edit, not a
// silent runtime `undefined` from a stale string literal.
export const ROOT_ROUTE_ID = "root";

// The pane route's id, paired with paneLoader. Used by RootLayout so the connection bar can date
// the MIRROR on screen rather than the herd behind it.
export const PANE_ROUTE_ID = "pane";

export interface HomeData {
  bridge: BridgeStatus | undefined;
  /** Per-device authorisation; undefined when the feature is off or not yet known. */
  device: DeviceAuth | undefined;
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  files?: boolean;
  /** True when this render is the last-good snapshot after a failed refresh. */
  error: boolean;
  /** True when the failed refresh was rejected with HTTP 401 or 403. */
  authError: boolean;
  /** When this snapshot was last fetched successfully (epoch ms). Absent on a never-fetched empty error. */
  lastSeenAt?: number;
}

export interface PaneData {
  paneId: string;
  text: string;
  /** True when the buffer was cut off at the requested line count — older scrollback still exists. */
  truncated: boolean;
  /** The scrollback window this result was fetched with — lets the UI tell a grown fetch from a
   * stale in-flight poll (a "Load older" tap raises this; see growRequestedLines). */
  requestedLines: number;
  /** Herdr's monotonic revision for `text` — the prompt-select race guard checks against it. 0 on
   * the degraded (stale-text) path, where the guard's fresh fetch will reject a mismatch anyway. */
  revision: number;
  error: boolean;
  /** True when the failed refresh was rejected with HTTP 401 or 403. */
  authError: boolean;
  /** When this pane's text was last fetched successfully (epoch ms). Absent if never fetched. */
  lastSeenAt?: number;
}

// Keep-previous-data cache: the last good snapshot and when it landed.
let lastSnapshot: SnapshotResponse | undefined;
let lastSnapshotAt: number | undefined;
const lastPaneAt = new Map<string, number>();
let pushedSnapshot = false;
let snapshotPushMode = false;
const snapshotAppliedListeners = new Set<() => void>();

/** SSE connected: the next revalidation may consume a pushed body. Disconnect drops that skip. */
export function setSnapshotPushMode(enabled: boolean): void {
  snapshotPushMode = enabled;
  if (!enabled) pushedSnapshot = false;
}

/** Skip GET /api/snapshot on a same-URL revalidate while SSE is applying snapshots.
 *  A pending pushed body still revalidates so the tree renders it. Navigations always load. */
export function snapshotShouldRevalidate({ currentUrl, nextUrl }: { currentUrl: URL; nextUrl: URL }): boolean {
  if (currentUrl.pathname !== nextUrl.pathname || currentUrl.search !== nextUrl.search) return true;
  if (pushedSnapshot) return true;
  return !snapshotPushMode;
}

/** Journal (and anything else) that should refresh when a snapshot lands, SSE or poll. */
export function subscribeSnapshotApplied(listener: () => void): () => void {
  snapshotAppliedListeners.add(listener);
  return () => { snapshotAppliedListeners.delete(listener); };
}

// A latched navigation skips the network, so retain whether the last real outcome was an auth
// rejection. Every other real outcome clears the marker.
let authErrorLatched = false;

function rememberAuthError(authError: boolean): void {
  authErrorLatched = authError;
}

function hasAuthError(): boolean {
  return authErrorLatched;
}

function isAuthError<TThrown>(error: TThrown): boolean {
  if (isLockRequiredError(error)) return false;
  return isApiErrorStatus(error, 401) || isApiErrorStatus(error, 403);
}

// The URL each loader last RAN for — the nav-vs-revalidate discriminator for the offline fast path (see
// the header comment). Module-scoped so it survives revalidations (the loader re-runs every poll) and
// resets on a full reload — same lifetime as the caches. `lastRootUrl` is enough for the root loader
// because it runs on EVERY navigation (it's the parent of all routes); the pane loader only runs while
// a pane is mounted, so `lastRootUrl` also CLEARS `lastPaneUrl` whenever we're on a non-pane URL — that
// way re-entering the same pane (pane → home → same pane) reads as a fresh navigation, not a poll.
let lastRootUrl: string | undefined;
let lastPaneUrl: string | undefined;

function isPaneUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.startsWith("/pane/");
  } catch {
    return url.includes("/pane/");
  }
}

function toHomeData(
  snap: SnapshotResponse,
  error: boolean,
  lastSeenAt?: number,
): HomeData {
  return {
    bridge: snap.bridge,
    device: snap.device,
    agents: withDialogPresence(snap.agents),
    shellPanes: snap.shellPanes ?? [],
    workspaces: snap.workspaces ?? [],
    tabs: snap.tabs ?? [],
    files: snap.files === true,
    error,
    authError: error && hasAuthError(),
    lastSeenAt,
  };
}

// Last-known home, flagged stale — the cached snapshot if we have one, else an empty
// error snapshot. Shared by BOTH the failed-refresh catch and the offline navigation fast path, so the
// two return byte-identical shapes (the UI can't tell "fetch just failed" from "navigated while known-
// offline" — both are "stale-but-present, flagged").
//
// Two tiers, in this order: the module cache (this page's own last good fetch), then the write-through
// sessionStorage cache (lib/last-seen.ts). The second tier is what a COLD boot reads — a discarded and
// restored PWA has an empty module cache and a failing first fetch, and without it the operator gets an
// empty herd instead of the screen they left. A restored snapshot is promoted into the module cache so
// the rest of this page session behaves exactly as if we had fetched it.
function staleHome(): HomeData {
  const restored = loadLastSnapshot();
  const cached = lastSnapshot ?? restored?.value;
  if (cached) {
    lastSnapshot = cached;
    const at = lastSnapshotAt ?? restored?.at;
    if (at !== undefined && lastSnapshotAt === undefined) lastSnapshotAt = at;
    return toHomeData(cached, true, at);
  }
  // Nothing cached at all — an outage on a tab that never saw a good snapshot. `error: true` is what
  // keeps this apart from a genuinely empty herd downstream: the empty state is only allowed to say
  // "No agents running" when the bridge really answered (components/agent-list.tsx).
  return {
    bridge: undefined,
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    files: false,
    error: true,
    authError: hasAuthError(),
  };
}

/** Apply an SSE snapshot to the same cache used by the root loader. The next revalidation then
 * renders it without issuing another snapshot fetch. */
export function applySnapshot(snap: SnapshotResponse, fromPush = true): void {
  const at = Date.now();
  lastSnapshot = snap;
  lastSnapshotAt = at;
  saveLastSnapshot(snap, at);
  rememberShellPanes(snap);
  rememberAuthError(false);
  if (fromPush) pushedSnapshot = true;
  if (snap.bridge !== "disconnected") markLive();
  for (const listener of snapshotAppliedListeners) listener();
}

export async function rootLoader({ request }: { request?: Request } = {}): Promise<HomeData> {
  // Nav-vs-revalidate: a revalidation (poll) re-runs at the SAME url; a navigation runs at a different
  // one. Cold start (lastRootUrl undefined) reads as a navigation too, but the latch gate below is
  // never set that early, so the first run always really fetches (BootSplash + escalation, as today).
  const url = request?.url;
  const isNavigation = lastRootUrl !== url;
  lastRootUrl = url;
  // Leaving a pane clears the pane loader's discriminator so a later return to it reads as a fresh nav.
  if (!isPaneUrl(url)) lastPaneUrl = undefined;

  // Fast path: a navigation during a known, escalated outage returns last-known data INSTANTLY rather
  // than hanging on a doomed fetch. Revalidations fall through and really fetch (so recovery lands and
  // markLive clears the latch → the next run fetches live and replaces the stale herd).
  if (isNavigation && isLostLatched()) return staleHome();
  const pushed = lastSnapshot;
  if (!isNavigation && pushed && (snapshotPushMode || consumePushedSnapshot())) {
    return toHomeData(pushed, false, lastSnapshotAt);
  }

  try {
    const snap = await fetchSnapshot(request?.signal);
    const at = Date.now();
    applySnapshot(snap, false);
    rememberAuthError(false);
    return toHomeData(snap, false, at);
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    rememberAuthError(isAuthError(e));
    // Keep the last good herd on screen, flagged so the ConnectionBanner can say "reconnecting…".
    return staleHome();
  }
}

function consumePushedSnapshot(): boolean {
  const had = pushedSnapshot;
  pushedSnapshot = false;
  return had;
}

export interface FilesData { rel: string; data?: FilesResponse; error?: string; }
export async function filesLoader({ params, request }: { params: Record<string, string | undefined>; request: Request }): Promise<FilesData> {
  const rel = (params["*"] ?? "").split("/").filter(Boolean).map(decodeURIComponent).join("/");
  try { return { rel, data: await fetchFiles(rel, request.signal) }; }
  catch (e) { if (isAbortError(e)) throw e; return { rel, error: e instanceof Error ? e.message : "Not found" }; }
}

/**
 * Poll-driven `revalidate()` re-runs every active loader, and a directory read every 1.5s is waste.
 * `() => false` also skipped navigations that stay on this same route — `/files/a` and `/files/a/b`
 * both match `files/*`, so the first folder was the last listing you'd ever see. Reload only when
 * the path actually changed.
 */
export function filesShouldRevalidate({ currentUrl, nextUrl }: { currentUrl: URL; nextUrl: URL }): boolean {
  return currentUrl.pathname !== nextUrl.pathname;
}

const lastPaneText = new Map<string, string>();
// Cap the per-pane stale-text cache so it can't grow without bound over a long session of opening
// many panes. Evict the oldest (insertion-order) entry beyond the cap — dumb FIFO is plenty for a
// phone that views one pane at a time.
const PANE_TEXT_MAX = 20;

function rememberPaneText(key: string, text: string): void {
  lastPaneText.set(key, text);
  if (lastPaneText.size > PANE_TEXT_MAX) {
    const oldest = lastPaneText.keys().next().value;
    if (oldest !== undefined) lastPaneText.delete(oldest);
  }
}

// The detail view pulls a deeper window than the home snapshot's status reads, so you can scroll
// back through a long exchange. The live tail still follows; scrolling up freezes it (see
// AgentChat). Larger = more scrollback but more bytes per poll — 600 holds several exchanges.
const DETAIL_HISTORY_LINES = 600;
/** Shell/TUI panes only mirror the viewport — match bridge paneReadSpec. */
const SHELL_DETAIL_HISTORY_LINES = 120;
let shellPaneIds = new Set<string>();

function rememberShellPanes(snap: SnapshotResponse): void {
  shellPaneIds = new Set((snap.shellPanes ?? []).map((p) => p.paneId));
}
// "Load older" raises the requested window by a step per tap, up to a cap.
//
// The cap is 1000 because HERDR clamps `pane.read` there — silently, and without setting `truncated`.
// Live-probed against a pane holding 6895 lines of scrollback: 999→1000, 1000→1001, 2000→1001,
// 6000→1001. Asking for more than 1000 returns the same 1000 lines, so a higher cap only bought taps
// that fetched nothing new. (The bridge's own MAX_READ_LINES=10000 is the outer guard; this is the
// real ceiling.) If Herdr ever lifts its clamp, raise this to match.
const DETAIL_HISTORY_STEP = 600;
const DETAIL_HISTORY_MAX = 1000;

// Per-pane requested scrollback, raised by "Load older". Module-scoped so it survives revalidations
// (the loader re-runs on every poll) but resets on a full app reload — mirrors lastPaneText. Bounded
// the same way so a long session of opening many panes can't grow it without bound.
const requestedLines = new Map<string, number>();

/** The scrollback window currently requested for a pane (defaults to the base window). */
function getRequestedLines(paneId: string): number {
  const base = shellPaneIds.has(paneId) ? SHELL_DETAIL_HISTORY_LINES : DETAIL_HISTORY_LINES;
  return requestedLines.get(paneId) ?? base;
}

/** True while more scrollback can still be requested (below the cap). */
export function canGrowRequestedLines(paneId: string): boolean {
  return getRequestedLines(paneId) < DETAIL_HISTORY_MAX;
}

/** Raise the requested scrollback by one step (capped) and return the new value. */
export function growRequestedLines(paneId: string): number {
  const next = Math.min(getRequestedLines(paneId) + DETAIL_HISTORY_STEP, DETAIL_HISTORY_MAX);
  requestedLines.set(paneId, next);
  if (requestedLines.size > PANE_TEXT_MAX) {
    const oldest = requestedLines.keys().next().value;
    if (oldest !== undefined) requestedLines.delete(oldest);
  }
  return next;
}

/** Reset a pane's requested scrollback back to the base window (used by tests). */

// Last-known pane payload, flagged degraded — stale text (empty if this pane was never fetched),
// truncated cleared, revision 0 (the prompt-select guard rejects a 0-revision mismatch anyway). Shared
// by the failed-refresh catch and the offline navigation fast path, so both return the same shape.
//
// Same two tiers as staleHome: the module cache, then the write-through sessionStorage mirror that
// survives the page being discarded. A restored mirror is promoted into the module cache.
function stalePane(paneId: string, lines: number): PaneData {
  const key = paneId;
  const restored = loadLastPaneText(paneId);
  const text = lastPaneText.get(key) ?? restored?.value ?? "";
  if (text) rememberPaneText(key, text);
  const at = lastPaneAt.get(key) ?? (text ? restored?.at : undefined);
  if (at !== undefined && !lastPaneAt.has(key)) lastPaneAt.set(key, at);
  return {
    paneId,
    text,
    truncated: false,
    requestedLines: lines,
    revision: 0,
    error: true,
    authError: hasAuthError(),
    lastSeenAt: at,
  };
}

// How much of the mirror the check below parses. `detectNoEchoPrompt` reads the last two NON-BLANK
// lines, so 40 gives the same answer as 600 for a fraction of the work on every poll: a prompt with
// 38 blank lines under it is not a terminal blocked waiting for a password.
const NO_ECHO_TAIL_LINES = 40;

/**
 * Whether this mirror is a pane sitting at a password prompt — the ADR 0017 exclusion.
 *
 * Recognition already exists and already changes what Sighter SAYS (lib/no-echo.ts); this is the one
 * other thing it changes, and it is a subtraction: a screen the operator is being asked to type a
 * secret into is not written to the browser's store, and whatever was written for that pane earlier is
 * dropped. Note what it is NOT about — the prompt echoes nothing, so there is no secret on the screen
 * to leak. It is about the pane the operator is answering `sudo` in not being kept, and about the next
 * read of that pane never being the one that restores it.
 */
function holdsNoEchoPrompt(text: string): boolean {
  const tail = text.split("\n").slice(-NO_ECHO_TAIL_LINES).join("\n");
  return detectNoEchoPrompt(parseLines(tail)) !== null;
}

export async function paneLoader({
  params,
  request,
}: {
  params: { paneId?: string };
  request?: Request;
}): Promise<PaneData> {
  const { paneId } = params;
  // The route is `/pane/:paneId`, so a missing param means a misconfigured route, not a user state
  // — fail loudly to the error boundary rather than fetching `/api/pane/` and rendering an empty pane.
  if (!paneId) throw new Error("paneLoader: missing :paneId route param");
  const key = paneId;
  const lines = getRequestedLines(paneId);
  // Nav-vs-revalidate, as in rootLoader. `lastPaneUrl` also flips to undefined whenever rootLoader sees
  // a non-pane URL, so opening a pane (even one just left) reads as a navigation, and polling within it
  // (same URL) reads as a revalidation.
  const url = request?.url;
  const isNavigation = lastPaneUrl !== url;
  lastPaneUrl = url;

  // Fast path: navigating to a pane during a known, escalated outage shows its last-known mirror (or an
  // empty degraded pane if never visited) INSTANTLY — never a 10s hang on a fetch that can't land.
  if (isNavigation && isLostLatched()) return stalePane(paneId, lines);

  try {
    // On a 304 fetchPane returns the cached body, so `read.text` is populated either way; the
    // `?? lastPaneText` is just belt-and-suspenders. Both paths are a success (not the error
    // branch) so the connection bar doesn't flicker on an unchanged poll.
    const read: PaneReadResponse = await fetchPane(paneId, lines, request?.signal);
    const text = read.text || lastPaneText.get(key) || "";
    const at = Date.now();
    rememberPaneText(key, text);
    lastPaneAt.set(key, at);
    // Write-through, EXCEPT while the pane is asking for a secret — see holdsNoEchoPrompt (ADR 0017).
    if (holdsNoEchoPrompt(text)) dropLastPaneText(paneId);
    else saveLastPaneText(paneId, text, at);
    rememberAuthError(false);
    return {
      paneId,
      text,
      truncated: read.truncated,
      requestedLines: lines,
      revision: read.revision,
      error: false,
      authError: false,
      lastSeenAt: at,
    };
  } catch (e) {
    if (isAbortError(e)) throw e; // superseded revalidation — let React Router drop it
    rememberAuthError(isAuthError(e));
    // Genuine network / server failure: show stale text flagged as degraded.
    return stalePane(paneId, lines);
  }
}
