/**
 * The thread stream: `GET /api/v2/thread/:id?after=<seq>` (SSE) into `useThreadStore`.
 *
 * At most one is open, for the route's thread. Opening another closes the old one first and clears
 * its store. The server answers with a `snapshot` (when replay would exceed 128 events) or replayed
 * `event`s, then `synchronized`; the thread is `syncing` until that frame, again after every
 * reconnect. A `snapshot` replaces the state, it is never merged.
 *
 * The snapshot arrives gzipped under `gz` (spec 26) and is decoded before parse, so it lags the
 * `synchronized` that follows it: the stream stays `syncing` until both the decoded snapshot has
 * landed and `synchronized` has been seen.
 *
 * A small LRU of recent thread states (spec 26 follow-up) lets a thread reopened after another one
 * paint at once and resume its stream at `after=<sequence>`, so the bridge replays a delta instead of
 * sending a fresh snapshot. Entries are capped and dropped when stale.
 */
import { SESSION_ID } from "@v1/lib/conn-telemetry";

import { applyThreadEvent, emptyThread, threadFromSnapshot, type ThreadState } from "./apply";
import { browserDeps, createConnection, type Connection, type ConnectionDeps } from "./connection";
import { noteDropped, setBlocked, useThreadStore } from "./stores";
import { isBlockingCode, v2ThreadPath, type ThreadSnapshot } from "./wire";

/** How many threads' state to keep for a resume; enough to cover a bounce between threads. */
export const CACHE_MAX = 3;
/** A cached state older than this is not worth resuming: a fresh snapshot is at least as current. */
export const CACHE_TTL_MS = 5 * 60_000;

export function threadStreamUrl(threadId: string, cursor: number): string {
  const q = new URLSearchParams({ client: SESSION_ID });
  if (cursor > 0) q.set("after", String(cursor));
  return `${v2ThreadPath(threadId)}?${q}`;
}

interface CachedThread {
  state: ThreadState;
  /** When it was cached; older entries are dropped rather than resumed. */
  at: number;
}

/** The `gz` marker of a gzipped snapshot frame, or null for a plain snapshot object. */
function gzPayload(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const gz = (data as { gz?: unknown }).gz;
  return typeof gz === "string" ? gz : null;
}

/** Base64 gzip bytes → text, through the platform's `DecompressionStream`. */
export async function gunzipBase64(b64: string): Promise<string> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const packed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  // The stream libs type `pipeThrough` more narrowly than the platform's transform accepts bytes.
  const gunzip = new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  return await new Response(packed.pipeThrough(gunzip)).text();
}

export interface ThreadStream {
  /** Open `threadId`'s stream; a no-op when it is already the open one. */
  open(threadId: string): void;
  /** Close the open stream, keeping its state for a resume, and clear its store. */
  close(): void;
  /** The thread whose stream is open, if any. */
  readonly threadId: string | null;
}

export function createThreadStream(deps: ConnectionDeps = browserDeps()): ThreadStream {
  let conn: Connection | null = null;
  let openId: string | null = null;
  const cache = new Map<string, CachedThread>();

  const mine = (threadId: string) => openId === threadId;

  /** Forget entries past the TTL, then the least recently used beyond the cap. */
  function prune(): void {
    const cutoff = deps.now() - CACHE_TTL_MS;
    for (const [id, entry] of cache) if (entry.at < cutoff) cache.delete(id);
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  /** Save the open thread's state so returning to it can replay instead of snapshot. */
  function remember(): void {
    prune();
    const current = useThreadStore.getState().current;
    if (!current || current.threadId !== openId) return;
    // A thread that never loaded has nothing to paint; its resume would be a snapshot anyway.
    if (current.thread === null || current.sequence === 0) return;
    const prev = cache.get(current.threadId);
    cache.delete(current.threadId);
    // Re-caching a recalled state it did not advance does not make it fresh again.
    const at = prev && prev.state.sequence === current.sequence ? prev.at : deps.now();
    cache.set(current.threadId, { state: current, at });
    prune();
  }

  /** The cached state for `threadId`, marked most recently used, or null. */
  function recall(threadId: string): ThreadState | null {
    prune();
    const entry = cache.get(threadId);
    if (!entry) return null;
    cache.delete(threadId);
    cache.set(threadId, entry);
    return entry.state;
  }

  function close(): void {
    remember();
    conn?.stop();
    conn = null;
    openId = null;
    useThreadStore.setState({ current: null, missing: null });
  }

  function open(threadId: string): void {
    if (openId === threadId && conn?.running) return;
    close();
    openId = threadId;
    const cached = recall(threadId);
    // A cached state paints the timeline at once; its cursor is what the stream resumes at.
    useThreadStore.setState({
      // A fresh snapshot would clear a dispatch failure, so a resume does too.
      current: cached ? { ...cached, syncing: true, dispatchFailure: null } : emptyThread(threadId),
      missing: null,
    });

    const update = (fn: (s: ThreadState) => ThreadState) => {
      if (!mine(threadId)) return;
      const current = useThreadStore.getState().current;
      if (!current || current.threadId !== threadId) return;
      const next = fn(current);
      if (next !== current) useThreadStore.setState({ current: next });
    };

    // The snapshot decode is async while `synchronized` follows at once, so the sync ends only when
    // both have happened. A connection drop starts a new generation, and a snapshot decoded for an
    // old one is discarded rather than allowed to overwrite newer state.
    let snapshotApplied = true;
    let sawSynchronized = false;
    let generation = 0;
    // Events that arrive while a gzipped snapshot is still decoding. The snapshot still replaces the
    // state; these are the deltas after it, applied once it has landed so none is lost.
    let awaitingSnapshot = false;
    let buffered: unknown[] = [];

    const settle = () => {
      if (!snapshotApplied || !sawSynchronized) return;
      update((s) => (s.syncing ? { ...s, syncing: false } : s));
    };

    const applyEvent = (data: unknown) =>
      update((s) => applyThreadEvent(s, data, (reason) => reason === "malformed" && noteDropped()));

    /** End the snapshot wait: apply what queued behind it (stale sequences drop themselves). */
    const afterSnapshot = () => {
      awaitingSnapshot = false;
      const queued = buffered;
      buffered = [];
      for (const data of queued) applyEvent(data);
    };

    const applySnapshot = (raw: unknown, gen: number) => {
      if (gen !== generation || !mine(threadId)) return;
      const snapshot = raw as ThreadSnapshot;
      if (!snapshot?.thread || snapshot.thread.id !== threadId || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.runs)) {
        // Nothing more is coming for this frame: let `synchronized` finish the sync rather than hang.
        noteDropped();
        snapshotApplied = true;
        afterSnapshot();
        settle();
        return;
      }
      useThreadStore.setState({ current: threadFromSnapshot(snapshot, true) });
      snapshotApplied = true;
      afterSnapshot();
      settle();
    };

    const c = createConnection(
      {
        url: () => threadStreamUrl(threadId, useThreadStore.getState().current?.sequence ?? 0),
        frames: {
          snapshot: (data) => {
            const gz = gzPayload(data);
            if (gz === null) {
              applySnapshot(data, generation);
              return;
            }
            const gen = generation;
            snapshotApplied = false;
            awaitingSnapshot = true;
            buffered = [];
            gunzipBase64(gz)
              .then((json) => applySnapshot(JSON.parse(json), gen))
              .catch(() => {
                if (gen !== generation) return;
                noteDropped();
                snapshotApplied = true;
                afterSnapshot();
                settle();
              });
          },
          event: (data) => {
            if (awaitingSnapshot) {
              buffered.push(data);
              return;
            }
            applyEvent(data);
          },
          synchronized: () => {
            sawSynchronized = true;
            settle();
          },
        },
        // Each reconnect catches up again before the thread counts as in sync.
        onDown: () => {
          generation += 1;
          snapshotApplied = true;
          sawSynchronized = false;
          awaitingSnapshot = false;
          buffered = [];
          update((s) => (s.syncing ? s : { ...s, syncing: true }));
        },
        onMalformed: () => noteDropped(),
        onBlocked: (body) => {
          if (isBlockingCode(body.code)) setBlocked({ code: body.code, error: body.error ?? "", have: body.have, need: body.need });
        },
        onGone: () => {
          cache.delete(threadId);
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
