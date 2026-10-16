/**
 * The thread stream: `GET /api/v2/thread/:id?after=<seq>` (SSE) into `useThreadStore`.
 *
 * At most one is open, for the route's thread. Opening another closes the old one first and clears
 * its store. The server answers with a `snapshot` (when replay would exceed 128 events) or replayed
 * `event`s, then `synchronized`; the thread is `syncing` until that frame, again after every
 * reconnect. A `snapshot` replaces the state, it is never merged.
 */
import { SESSION_ID } from "@v1/lib/conn-telemetry";

import { applyThreadEvent, emptyThread, threadFromSnapshot, type ThreadState } from "./apply";
import { browserDeps, createConnection, type Connection, type ConnectionDeps } from "./connection";
import { noteDropped, setBlocked, useThreadStore } from "./stores";
import { isBlockingCode, v2ThreadPath, type ThreadSnapshot } from "./wire";

export function threadStreamUrl(threadId: string, cursor: number): string {
  const q = new URLSearchParams({ client: SESSION_ID });
  if (cursor > 0) q.set("after", String(cursor));
  return `${v2ThreadPath(threadId)}?${q}`;
}

export interface ThreadStream {
  /** Open `threadId`'s stream; a no-op when it is already the open one. */
  open(threadId: string): void;
  /** Close the open stream and clear its store. */
  close(): void;
  /** The thread whose stream is open, if any. */
  readonly threadId: string | null;
}

export function createThreadStream(deps: ConnectionDeps = browserDeps()): ThreadStream {
  let conn: Connection | null = null;
  let openId: string | null = null;

  const mine = (threadId: string) => openId === threadId;

  function close(): void {
    conn?.stop();
    conn = null;
    openId = null;
    useThreadStore.setState({ current: null, missing: null });
  }

  function open(threadId: string): void {
    if (openId === threadId && conn?.running) return;
    close();
    openId = threadId;
    useThreadStore.setState({ current: emptyThread(threadId), missing: null });

    const update = (fn: (s: ThreadState) => ThreadState) => {
      if (!mine(threadId)) return;
      const current = useThreadStore.getState().current;
      if (!current || current.threadId !== threadId) return;
      const next = fn(current);
      if (next !== current) useThreadStore.setState({ current: next });
    };

    const c = createConnection(
      {
        url: () => threadStreamUrl(threadId, useThreadStore.getState().current?.sequence ?? 0),
        frames: {
          snapshot: (data) => {
            const snapshot = data as ThreadSnapshot;
            if (!snapshot?.thread || snapshot.thread.id !== threadId || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.runs)) {
              noteDropped();
              return;
            }
            if (mine(threadId)) useThreadStore.setState({ current: threadFromSnapshot(snapshot, true) });
          },
          event: (data) => update((s) => applyThreadEvent(s, data, (reason) => reason === "malformed" && noteDropped())),
          synchronized: () => update((s) => (s.syncing ? { ...s, syncing: false } : s)),
        },
        // Each reconnect catches up again before the thread counts as in sync.
        onDown: () => update((s) => (s.syncing ? s : { ...s, syncing: true })),
        onMalformed: () => noteDropped(),
        onBlocked: (body) => {
          if (isBlockingCode(body.code)) setBlocked({ code: body.code, error: body.error ?? "", have: body.have, need: body.need });
        },
        onGone: () => {
          if (mine(threadId)) useThreadStore.setState({ current: null, missing: threadId });
        },
      },
      deps,
    );
    conn = c;
    c.start();
  }

  return {
    open,
    close,
    get threadId() {
      return openId;
    },
  };
}

let shared: ThreadStream | null = null;
/** The page's one thread stream (T09 invariant: never two open). */
export function threadStream(): ThreadStream {
  shared ??= createThreadStream();
  return shared;
}

/** Test helper. */
export function __resetThreadStream(): void {
  shared?.close();
  shared = null;
}
