/**
 * One resilient SSE connection: the part the shell stream and the thread stream share.
 *
 * - Every frame (snapshot, event, synchronized, ping, build, ...) counts as a sign of life.
 * - On `error`, or when nothing arrives for {@link SILENCE_MS} (the watchdog of spec 77: a mobile
 *   network can drop a flow without either end hearing), the connection closes and reopens after a
 *   backoff of 1 s, 2 s, 4 s, 8 s, then 15 s, each ±20%. The backoff starts over after a frame arrives.
 * - A page returning to the foreground reconnects at once; so does the network coming back (`online`)
 *   and a page restored from the back/forward cache (`pageshow` with `persisted`). A phone waking
 *   from sleep fires several of these within a moment, so wake triggers within {@link WAKE_COALESCE_MS}
 *   of the last one are folded into it. `offline` closes the stream and arms the ordinary backoff,
 *   so the banner reflects a dead radio at once instead of after the silence watchdog.
 * - The post-error probe has a timeout ({@link PROBE_TIMEOUT_MS}): a black-holed network must not
 *   hold the reconnect behind a `fetch` that never answers.
 * - The reopened URL carries the caller's cursor (`url()` is asked again each time). A browser only
 *   sends `Last-Event-ID` on its own retry, and this closes the source instead, so the cursor goes as
 *   `?after=` (T05 reads either).
 * - `EventSource` never exposes a status or a body, so after an `error` one plain `fetch` of the same
 *   URL tells a refusal from a drop: a JSON 503 with a blocking `code` (`herdr-too-old`,
 *   `v2-disabled`) is reported through `onBlocked`, and retries slow to once a minute; a lock 401
 *   raises the unlock prompt; a 404 is reported through `onGone` and the connection stops.
 */
import { noteConn } from "@v1/lib/conn-telemetry";

import { noteIfLocked, XHR_HEADER, XHR_HEADER_VALUE } from "@/lib/api";

import { isBlockingCode, isV2ErrorBody, type V2ErrorBody } from "./wire";

export const SILENCE_MS = 45_000;
export const BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 8_000] as const;
export const BACKOFF_CAP_MS = 15_000;
export const JITTER = 0.2;
/** A wake trigger (foreground, `online`, `pageshow`) within this of the previous one is ignored. */
export const WAKE_COALESCE_MS = 1_000;
/** How long the post-error status probe may take before the drop counts as an unreachable bridge. */
export const PROBE_TIMEOUT_MS = 8_000;
/** Retry period while the bridge refuses v2 on this host. */
export const BLOCKED_RETRY_MS = 60_000;

/** The nth reconnect delay (0-based) before jitter. */
export function backoffBase(attempt: number): number {
  return BACKOFF_STEPS_MS[attempt] ?? BACKOFF_CAP_MS;
}

/** `base` moved by up to ±20%; `random` is in [0, 1). */
export function jittered(base: number, random: number): number {
  return Math.round(base * (1 - JITTER + 2 * JITTER * random));
}

export type FrameHandler = (data: unknown) => void;

export interface ConnectionDeps {
  EventSource: new (url: string) => EventSource;
  fetch: typeof fetch;
  now: () => number;
  random: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  /** Where `visibilitychange` is heard; omit to skip foreground reconnects. */
  document?: Document;
  /** Where `online`, `offline` and `pageshow` are heard; omit to skip them. */
  window?: Pick<Window, "addEventListener" | "removeEventListener">;
}

export const browserDeps = (): ConnectionDeps => ({
  EventSource: globalThis.EventSource,
  fetch: (...args) => globalThis.fetch(...args),
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  document: typeof document === "undefined" ? undefined : document,
  window: typeof window === "undefined" ? undefined : window,
});

export interface ConnectionOptions {
  /** The URL to open, asked on every (re)connect so it can carry the latest cursor. */
  url: () => string;
  /** Named SSE events and what to do with their parsed `data`. */
  frames: Record<string, FrameHandler>;
  /** Record `sse.open` / `sse.drop` for `sightr-ctl conn`. Only the shell stream does. */
  telemetry?: boolean;
  /** The stream delivered its first frame since (re)opening. */
  onLive?: () => void;
  /** Any frame arrived (heartbeats included). */
  onFrame?: () => void;
  /** The stream closed and a reconnect is scheduled. */
  onDown?: () => void;
  /** A frame's data was not JSON. */
  onMalformed?: (event: string) => void;
  onBlocked?: (body: V2ErrorBody) => void;
  onGone?: () => void;
}

export interface Connection {
  start(): void;
  stop(): void;
  /** Close whatever is open and reopen now (Retry, foreground, a `reset` frame). */
  reconnectNow(): void;
  readonly running: boolean;
}

/** Frames every v2 stream may send besides the caller's. */
const HEARTBEATS = ["ping", "build"] as const;

export function createConnection(opts: ConnectionOptions, deps: ConnectionDeps = browserDeps()): Connection {
  let running = false;
  let source: EventSource | null = null;
  let openedAt = 0;
  let firstFrameAt: number | null = null;
  let attempt = 0;
  let blocked = false;
  let watchdog: unknown = null;
  let retry: unknown = null;
  let probe: AbortController | null = null;
  let lastWakeAt = Number.NEGATIVE_INFINITY;

  const clear = (id: unknown) => {
    if (id !== null) deps.clearTimeout(id);
  };

  function armWatchdog(): void {
    clear(watchdog);
    watchdog = deps.setTimeout(() => {
      watchdog = null;
      drop(true);
    }, SILENCE_MS);
  }

  function beat(): void {
    if (firstFrameAt === null) {
      firstFrameAt = deps.now();
      if (opts.telemetry) noteConn({ kind: "sse.open", connectMs: Math.max(0, firstFrameAt - openedAt) });
      attempt = 0;
      blocked = false;
      opts.onLive?.();
    }
    opts.onFrame?.();
    armWatchdog();
  }

  function listen(es: EventSource, name: string, handler: FrameHandler | null): void {
    es.addEventListener(name, (event) => {
      if (es !== source) return; // a late frame from a source already replaced
      beat();
      if (!handler) return;
      let data: unknown;
      try {
        data = JSON.parse((event as MessageEvent).data as string);
      } catch {
        opts.onMalformed?.(name);
        return;
      }
      handler(data);
    });
  }

  function open(): void {
    clear(retry);
    retry = null;
    const es = new deps.EventSource(opts.url());
    source = es;
    openedAt = deps.now();
    firstFrameAt = null;
    for (const [name, handler] of Object.entries(opts.frames)) listen(es, name, handler);
    for (const name of HEARTBEATS) if (!(name in opts.frames)) listen(es, name, null);
    // The bridge closes a consumer that fell too far behind after `reset`; come straight back.
    if (!("reset" in opts.frames)) {
      es.addEventListener("reset", () => {
        if (es === source) reconnectNow();
      });
    }
    es.addEventListener("error", () => {
      if (es === source) drop(false);
    });
    armWatchdog();
  }

  /** Close the current source and, unless `note` is false (a deliberate reopen), record the drop. */
  function close(stale: boolean, note = true): void {
    clear(watchdog);
    watchdog = null;
    if (!source) return;
    source.close();
    source = null;
    if (opts.telemetry && note) {
      const opened = firstFrameAt !== null;
      const upMs = opened ? Math.max(0, deps.now() - (firstFrameAt ?? 0)) : 0;
      noteConn({ kind: "sse.drop", upMs, opened, ...(stale ? { stale: true as const } : {}) });
    }
  }

  function drop(stale: boolean): void {
    if (!running) return;
    const url = opts.url();
    close(stale);
    opts.onDown?.();
    if (stale) schedule();
    else void checkThenSchedule(url);
  }

  function schedule(): void {
    if (!running) return;
    clear(retry);
    const delay = blocked ? BLOCKED_RETRY_MS : jittered(backoffBase(attempt), deps.random());
    attempt += 1;
    retry = deps.setTimeout(() => {
      retry = null;
      if (running) open();
    }, delay);
  }

  async function checkThenSchedule(url: string): Promise<void> {
    probe?.abort();
    const controller = new AbortController();
    probe = controller;
    const probeTimer = deps.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let gone = false;
    try {
      const res = await deps.fetch(url, { headers: { [XHR_HEADER]: XHR_HEADER_VALUE }, signal: controller.signal });
      if (controller !== probe) return;
      noteIfLocked(res);
      // A 404 means "no such thread" only to a caller that asked (onGone); for the shell stream it is
      // a bridge without the v2 API yet, which an ordinary reconnect keeps checking.
      if (res.status === 404 && opts.onGone) gone = true;
      else if (res.status === 503 && (res.headers.get("content-type") ?? "").includes("json")) {
        const body: unknown = await res.json().catch(() => null);
        if (isV2ErrorBody(body) && isBlockingCode(body.code)) {
          blocked = true;
          opts.onBlocked?.(body);
        } else blocked = false;
      } else blocked = false;
      // A 200 here is a live stream; only its status was wanted.
      controller.abort();
    } catch {
      /* the bridge is unreachable: an ordinary reconnect */
    } finally {
      deps.clearTimeout(probeTimer);
      if (controller === probe) probe = null;
    }
    if (!running) return;
    if (gone) {
      stop();
      opts.onGone?.();
      return;
    }
    if (source === null && retry === null) schedule();
  }

  /** The page or the network came back: reopen now, once per burst of wake events. */
  function wake(): void {
    if (!running) return;
    const at = deps.now();
    if (at - lastWakeAt < WAKE_COALESCE_MS) return;
    lastWakeAt = at;
    reconnectNow();
  }

  function onVisibility(): void {
    if (deps.document?.visibilityState === "visible") wake();
  }

  function onOnline(): void {
    wake();
  }

  function onPageShow(event: Event): void {
    if ((event as PageTransitionEvent).persisted) wake();
  }

  /** The radio is gone: nothing more will arrive, so say so now and keep the backoff armed. */
  function onOffline(): void {
    if (running && source) drop(true);
  }

  function reconnectNow(): void {
    if (!running) return;
    clear(retry);
    retry = null;
    probe?.abort();
    probe = null;
    close(false, false);
    attempt = 0;
    open();
  }

  function stop(): void {
    if (!running) return;
    running = false;
    clear(retry);
    retry = null;
    probe?.abort();
    probe = null;
    close(false, false);
    deps.document?.removeEventListener("visibilitychange", onVisibility);
    deps.window?.removeEventListener("online", onOnline);
    deps.window?.removeEventListener("offline", onOffline);
    deps.window?.removeEventListener("pageshow", onPageShow);
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      blocked = false;
      deps.document?.addEventListener("visibilitychange", onVisibility);
      deps.window?.addEventListener("online", onOnline);
      deps.window?.addEventListener("offline", onOffline);
      deps.window?.addEventListener("pageshow", onPageShow);
      open();
    },
    stop,
    reconnectNow,
    get running() {
      return running;
    },
  };
}
