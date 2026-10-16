/**
 * The shell stream: `GET /api/v2/shell` (SSE) into `useShell`.
 *
 * `snapshot` replaces the store and sets the cursor; each `event` applies only when its sequence is
 * above the last one (duplicates and stale replays drop). Gaps are fine here: the bridge sends a fresh
 * snapshot rather than a gappy replay. On reconnect the cursor goes as `?after=` and a reply that is a
 * snapshot replaces the store, it is not merged. This stream also drives `useStreamHealth` and the
 * `sse.open` / `sse.drop` telemetry, keyed by the page's SESSION_ID (`?client=`).
 */
import { SESSION_ID } from "@v1/lib/conn-telemetry";

import { applyShellEvent, shellFromSnapshot } from "./apply";
import { browserDeps, createConnection, type Connection, type ConnectionDeps } from "./connection";
import { CONNECTION_LOST_MS } from "./health";
import { emitShellEvent } from "./shell-events";
import { clearBlocked, noteDevice, noteDropped, noteHerdr, setBlocked, useShell, useStreamHealth } from "./stores";
import { isBlockingCode, V2_SHELL_PATH, type ShellSnapshot } from "./wire";

export interface ShellStream extends Connection {
  /** The sequence a reconnect resumes from. */
  readonly cursor: number;
}

export function shellStreamUrl(cursor: number): string {
  const q = new URLSearchParams({ client: SESSION_ID });
  if (cursor > 0) q.set("after", String(cursor));
  return `${V2_SHELL_PATH}?${q}`;
}

const seqOf = (data: unknown): number => {
  const n = (data as { sequence?: unknown } | null)?.sequence;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};

export function createShellStream(deps: ConnectionDeps = browserDeps()): ShellStream {
  let cursor = 0;
  let lostTimer: unknown = null;

  const markDown = () => {
    const health = useStreamHealth.getState();
    if (health.status === "live") useStreamHealth.setState({ status: "connecting", downSince: deps.now() });
    if (lostTimer === null) {
      lostTimer = deps.setTimeout(() => {
        lostTimer = null;
        if (useStreamHealth.getState().status !== "live") useStreamHealth.setState({ status: "lost" });
      }, Math.max(0, CONNECTION_LOST_MS - (deps.now() - useStreamHealth.getState().downSince)));
    }
  };

  const conn = createConnection(
    {
      url: () => shellStreamUrl(cursor),
      telemetry: true,
      frames: {
        snapshot: (data) => {
          const snapshot = data as ShellSnapshot;
          if (!Array.isArray(snapshot?.projects) || !Array.isArray(snapshot.threads) || !Array.isArray(snapshot.requests)) {
            noteDropped();
            return;
          }
          useShell.setState(shellFromSnapshot(snapshot), true);
          cursor = snapshot.sequence;
          noteHerdr(snapshot.herdr);
          noteDevice(snapshot.device);
        },
        event: (data) => {
          useShell.setState((s) => applyShellEvent(s, data, (reason) => reason === "malformed" && noteDropped()), true);
          const fresh = seqOf(data) > cursor;
          cursor = Math.max(cursor, seqOf(data));
          if (fresh) emitShellEvent(data);
        },
        synchronized: (data) => {
          cursor = Math.max(cursor, seqOf(data));
          noteHerdr((data as { herdr?: unknown } | null)?.herdr);
        },
        ping: (data) => noteHerdr((data as { herdr?: unknown } | null)?.herdr),
      },
      onLive: () => {
        if (lostTimer !== null) deps.clearTimeout(lostTimer);
        lostTimer = null;
        useStreamHealth.setState({ status: "live" });
        clearBlocked();
      },
      onFrame: () => useStreamHealth.setState({ lastFrameAt: deps.now() }),
      onDown: markDown,
      onMalformed: () => noteDropped(),
      onBlocked: (body) => {
        if (isBlockingCode(body.code)) {
          setBlocked({ code: body.code, error: body.error ?? "", have: body.have, need: body.need });
        }
      },
    },
    deps,
  );

  return {
    start: () => {
      useStreamHealth.setState({ status: "connecting", downSince: deps.now() });
      markDown();
      conn.start();
    },
    stop: () => {
      if (lostTimer !== null) deps.clearTimeout(lostTimer);
      lostTimer = null;
      conn.stop();
    },
    reconnectNow: () => conn.reconnectNow(),
    get running() {
      return conn.running;
    },
    get cursor() {
      return cursor;
    },
  };
}

/** The page's one shell stream; RootLayout starts it once the lock gate is open. */
let shared: ShellStream | null = null;
export function shellStream(): ShellStream {
  shared ??= createShellStream();
  return shared;
}

/** Test helper. */
export function __resetShellStream(): void {
  shared?.stop();
  shared = null;
}
