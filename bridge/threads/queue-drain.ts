import type { ChatAttachment, QueuedMessage, ThreadEvent, ThreadStatus } from "../../shared/v2/contracts.ts";
import type { EventDraft, ServerThread } from "./events.ts";
import type { ThreadStore } from "./store.ts";

// The queue drainer (T06). A thread's queued messages are bridge state (`queued_messages`); the
// drainer sends them one at a time when the thread comes to rest.
//
// Settled means projection status `idle` or `done`. The engine already holds `working` through
// STATUS_HOLD_MS, so a `done` between two tool calls never reaches the projection and the drainer
// adds no hold of its own. Before a send it reads the pane once more: no composer on screen means it
// backs off without counting a failure.
//
// One message per settle: after a send the drainer waits for the run that message started to end
// (the status goes `working` and comes back, or T03 ends a run) before it takes the next row. If no
// run shows within RUN_WAIT_MS (a turn too quick for a poll to see), the next row may go.
//
// It never reads harness ids: a thread with `capabilities.canQueueDrain` false has no queue.

/** A back-off (composer not on screen, pane busy, a failed send) tries again this long after. */
export const DRAIN_RETRY_MS = 5_000;
/** After a send, how long to wait for its run to show before the next row may go anyway. */
export const RUN_WAIT_MS = 20_000;
/** This many failed sends of one row in a row hold it. */
export const MAX_DRAIN_FAILURES = 3;

export const isSettled = (status: ThreadStatus): boolean => status === "idle" || status === "done";

export interface DrainTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const REAL_TIMERS: DrainTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** What one send of a row came to, as the dispatcher's start path reports it. */
export type DeliverResult =
  /** Sent. `events` (a `user_message` item for a harness with no journal) commit with the row's removal. */
  | { kind: "sent"; events: EventDraft[] }
  /** Nothing typed and nothing wrong with the row: the pane is busy or gone. Back off, no strike. */
  | { kind: "skipped"; reason: "busy" | "pane-gone" }
  /** The guard refused or stalled (`blocked`, `stalled`, or an `error` with nothing delivered). A strike. */
  | { kind: "failed"; reason: string; message: string }
  /** An error after the text reached the box, unsubmitted: the row is done with (never resent). */
  | { kind: "delivered"; message: string };

export type Deliver = (
  thread: ServerThread,
  text: string,
  attachments: ChatAttachment[],
  intent: "queued_turn" | "steer",
) => Promise<DeliverResult>;

export interface QueueDrainerDeps {
  store: Pick<ThreadStore, "append" | "onCommitted" | "getThread" | "listQueued">;
  deliver: Deliver;
  /** Is the thread's composer on screen right now? Null when the pane is gone. */
  composerReady: (thread: ServerThread) => Promise<boolean | null>;
  timers?: DrainTimers;
  log?: (msg: string) => void;
  retryMs?: number;
  runWaitMs?: number;
}

export type SettleWait = "settled" | "timeout" | "gone";

export interface QueueDrainer {
  /** Hold every queued or sending row (a restart), then follow status events. */
  start(): void;
  stop(): void;
  /** Try the thread's queue now (a row was added, resumed, reordered or edited). */
  kick(threadId: string): void;
  /**
   * A message is about to be sent outside the drain (a start or a steer). Call the result with
   * whether it was sent: if so, the next row waits for the run it starts. Watching starts before the
   * send, so a `working` seen while the send is still verifying counts.
   */
  beginSend(threadId: string): (sent: boolean) => void;
  /** Resolves when the thread is settled, after `ms`, or when it is archived or gone. */
  waitSettled(threadId: string, ms: number): Promise<SettleWait>;
  /** Resolves when every queued pass has finished (tests). */
  settled(): Promise<void>;
}

/** Positions 0..n-1 in the rows' current order (position, then age). */
export function normalizeQueue(rows: readonly QueuedMessage[]): QueuedMessage[] {
  return [...rows]
    .map((row, i) => ({ row, i }))
    .sort((a, b) => a.row.position - b.row.position || a.i - b.i)
    .map(({ row }, position) => ({ ...row, position }));
}

/** The `queue.updated` draft for a thread's whole queue after a change. */
export function queueEvent(
  threadId: string,
  messages: readonly QueuedMessage[],
  change?: "added" | "sent" | "held" | "resumed" | "reordered" | "edited" | "cancelled",
  reason?: string,
): EventDraft {
  return {
    type: "queue.updated",
    threadId,
    payload: { messages: normalizeQueue(messages), ...(change ? { change } : {}), ...(reason ? { reason } : {}) },
  };
}

/** A row taken off the send path and kept for the operator to resume or cancel. */
export function heldRow(row: QueuedMessage, reason: string): QueuedMessage {
  return { ...row, state: "held", heldReason: reason };
}

interface DrainState {
  failures: number;
  /** A message is being sent or was sent; waiting for its run. `timer` runs once it was sent. */
  awaiting: { sawWorking: boolean; timer: unknown } | null;
  retry: unknown;
}

export function createQueueDrainer(deps: QueueDrainerDeps): QueueDrainer {
  const { store, deliver, composerReady } = deps;
  const timers = deps.timers ?? REAL_TIMERS;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const retryMs = deps.retryMs ?? DRAIN_RETRY_MS;
  const runWaitMs = deps.runWaitMs ?? RUN_WAIT_MS;

  const states = new Map<string, DrainState>();
  const chains = new Map<string, Promise<void>>();
  const queuedPass = new Set<string>();
  const waiters = new Map<string, Set<(why: "settled" | "gone") => void>>();
  let unsubscribe: (() => void) | null = null;
  let stopped = true;

  const stateOf = (threadId: string): DrainState => {
    let s = states.get(threadId);
    if (!s) {
      s = { failures: 0, awaiting: null, retry: null };
      states.set(threadId, s);
    }
    return s;
  };

  const clearAwaiting = (threadId: string) => {
    const s = states.get(threadId);
    if (!s?.awaiting) return;
    if (s.awaiting.timer !== null) timers.clearTimeout(s.awaiting.timer);
    s.awaiting = null;
  };

  const clearRetry = (threadId: string) => {
    const s = states.get(threadId);
    if (!s || s.retry === null) return;
    timers.clearTimeout(s.retry);
    s.retry = null;
  };

  const forget = (threadId: string) => {
    clearAwaiting(threadId);
    clearRetry(threadId);
    states.delete(threadId);
  };

  const beginSend = (threadId: string): ((sent: boolean) => void) => {
    clearAwaiting(threadId);
    const s = stateOf(threadId);
    const mark: { sawWorking: boolean; timer: unknown } = { sawWorking: false, timer: null };
    s.awaiting = mark;
    return (sent) => {
      if (s.awaiting !== mark) return;
      if (!sent) {
        s.awaiting = null;
        return;
      }
      if (mark.sawWorking && isSettled(store.getThread(threadId)?.status ?? "idle")) {
        // The whole run went by while the send was still verifying.
        s.awaiting = null;
        return;
      }
      mark.timer = timers.setTimeout(() => {
        if (s.awaiting !== mark) return;
        s.awaiting = null;
        void schedule(threadId);
      }, runWaitMs);
    };
  };

  const backOff = (threadId: string) => {
    const s = stateOf(threadId);
    if (s.retry !== null) return;
    s.retry = timers.setTimeout(() => {
      s.retry = null;
      void schedule(threadId);
    }, retryMs);
  };

  const notifyWaiters = (threadId: string, why: "settled" | "gone") => {
    const set = waiters.get(threadId);
    if (!set) return;
    waiters.delete(threadId);
    for (const w of set) w(why);
  };

  /** Hold every row of an archived thread: the pane is gone, so nothing will drain them. */
  const holdClosed = (threadId: string) => {
    const rows = store.listQueued(threadId);
    if (rows.length === 0 || rows.every((r) => r.state === "held")) return;
    const thread = store.getThread(threadId);
    if (!thread) return;
    store.append([
      queueEvent(
        threadId,
        rows.map((r) => (r.state === "held" ? r : heldRow(r, "pane-closed"))),
        "held",
        "pane-closed",
      ),
    ]);
  };

  /** Swap one row for `next` (or drop it with null) in the thread's current queue. */
  const withRow = (threadId: string, id: string, next: QueuedMessage | null): QueuedMessage[] | null => {
    const rows = store.listQueued(threadId);
    if (!rows.some((r) => r.id === id)) return null;
    return rows.flatMap((r) => (r.id !== id ? [r] : next ? [next] : []));
  };

  const pass = async (threadId: string): Promise<void> => {
    const thread = store.getThread(threadId);
    if (!thread || thread.shelf === "archived") return;
    if (!thread.capabilities.canQueueDrain || !isSettled(thread.status)) return;
    const s = stateOf(threadId);
    if (s.awaiting) return;
    const rows = store.listQueued(threadId);
    // A row in flight (a steer, or a send this bridge is still making) goes first; nothing overtakes it.
    if (rows.some((r) => r.state === "sending")) return;
    const row = rows.find((r) => r.state === "queued");
    if (!row) {
      s.failures = 0;
      return;
    }

    const ready = await composerReady(thread);
    if (ready === null) return;
    if (!ready) {
      backOff(threadId);
      return;
    }

    // The world may have moved while the pane was read.
    const fresh = store.getThread(threadId);
    const current = store.listQueued(threadId);
    const still = current.find((r) => r.id === row.id);
    if (!fresh || fresh.shelf === "archived" || !isSettled(fresh.status) || states.get(threadId)?.awaiting) return;
    if (!still || still.state !== "queued" || current.some((r) => r.state === "sending")) return;
    if (current.find((r) => r.state === "queued")?.id !== row.id) {
      void schedule(threadId);
      return;
    }

    const sending = withRow(threadId, row.id, { ...still, state: "sending" })!;
    store.append([queueEvent(threadId, sending)]);

    const finish = beginSend(threadId);
    let result: DeliverResult;
    try {
      result = await deliver(fresh, still.text, still.attachments, "queued_turn");
    } catch (err) {
      result = { kind: "failed", reason: "error", message: (err as Error).message };
    }
    finish(result.kind === "sent");

    const back = (state: QueuedMessage | null) => withRow(threadId, row.id, state);
    switch (result.kind) {
      case "sent": {
        s.failures = 0;
        const rest = back(null) ?? store.listQueued(threadId);
        store.append([...result.events, queueEvent(threadId, rest, "sent")]);
        return;
      }
      case "delivered": {
        // The text sits in the box, unsubmitted; never resend it. The next row waits for a status
        // change (the operator submits or clears it), so no retry is scheduled.
        s.failures = 0;
        const rest = back(null) ?? store.listQueued(threadId);
        store.append([
          queueEvent(threadId, rest),
          {
            type: "dispatch.failed",
            threadId,
            payload: { reason: "error", message: result.message, textDelivered: true, queuedId: row.id },
          },
        ]);
        return;
      }
      case "skipped": {
        const rows2 = back({ ...still, state: "queued" });
        if (rows2) store.append([queueEvent(threadId, rows2)]);
        if (result.reason === "busy") backOff(threadId);
        return;
      }
      case "failed": {
        s.failures += 1;
        if (s.failures >= MAX_DRAIN_FAILURES) {
          s.failures = 0;
          const rows2 = back(heldRow(still, result.reason));
          if (!rows2) return;
          store.append([
            queueEvent(threadId, rows2, "held", result.reason),
            { type: "dispatch.failed", threadId, payload: { reason: result.reason, message: result.message, queuedId: row.id } },
          ]);
          return;
        }
        const rows2 = back({ ...still, state: "queued" });
        if (rows2) store.append([queueEvent(threadId, rows2)]);
        backOff(threadId);
        return;
      }
    }
  };

  /** Queue a pass for the thread. Passes for one thread never overlap; queued ones coalesce. */
  const schedule = (threadId: string): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (queuedPass.has(threadId)) return chains.get(threadId)!;
    queuedPass.add(threadId);
    const prev = chains.get(threadId) ?? Promise.resolve();
    const next = prev.then(async () => {
      queuedPass.delete(threadId);
      if (stopped) return;
      clearRetry(threadId);
      try {
        await pass(threadId);
      } catch (err) {
        log(`[threads] queue drain for ${threadId} failed: ${(err as Error).message}`);
      }
    });
    chains.set(threadId, next);
    void next.then(() => {
      if (chains.get(threadId) === next) chains.delete(threadId);
    });
    return next;
  };

  const onEvents = (events: ThreadEvent[]) => {
    for (const e of events) {
      const threadId = e.threadId;
      if (!threadId) continue;
      switch (e.type) {
        case "thread.updated": {
          const status = e.payload.patch.status;
          if (status === undefined) break;
          const s = states.get(threadId);
          if (status === "working") {
            if (s?.awaiting) s.awaiting.sawWorking = true;
            break;
          }
          if (!isSettled(status)) break;
          if (s?.awaiting?.sawWorking) clearAwaiting(threadId);
          notifyWaiters(threadId, "settled");
          // Deferred: never append from inside a commit notification (streams would see batches out of order).
          void Promise.resolve().then(() => schedule(threadId));
          break;
        }
        case "run.ended":
          // Only a run that began after the send counts: an older run's late end must not release it.
          if (states.get(threadId)?.awaiting?.sawWorking) {
            clearAwaiting(threadId);
            void Promise.resolve().then(() => schedule(threadId));
          }
          break;
        case "thread.archived":
          forget(threadId);
          notifyWaiters(threadId, "gone");
          void Promise.resolve().then(() => {
            if (!stopped) holdClosed(threadId);
          });
          break;
        case "queue.updated": {
          const change = e.payload.change;
          if (change === "added" || change === "resumed" || change === "reordered" || change === "edited") {
            void Promise.resolve().then(() => schedule(threadId));
          }
          break;
        }
        default:
          break;
      }
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      // After a restart nothing is sent until the operator resumes. A row that was `sending` at the
      // crash is ambiguous (the text may be in the box), and so are queued rows the operator may have
      // stopped caring about; both wait.
      const byThread = new Map<string, QueuedMessage[]>();
      for (const row of store.listQueued()) byThread.set(row.threadId, [...(byThread.get(row.threadId) ?? []), row]);
      for (const [threadId, rows] of byThread) {
        if (!rows.some((r) => r.state !== "held")) continue;
        try {
          store.append([queueEvent(threadId, rows.map((r) => (r.state === "held" ? r : heldRow(r, "restart"))), "held", "restart")]);
        } catch (err) {
          log(`[threads] could not hold the queue of ${threadId}: ${(err as Error).message}`);
        }
      }
      unsubscribe = store.onCommitted(onEvents);
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      for (const threadId of [...states.keys()]) forget(threadId);
      for (const threadId of [...waiters.keys()]) notifyWaiters(threadId, "gone");
    },
    kick(threadId) {
      void schedule(threadId);
    },
    beginSend,
    waitSettled(threadId, ms) {
      const thread = store.getThread(threadId);
      if (!thread || thread.shelf === "archived" || stopped) return Promise.resolve("gone");
      if (isSettled(thread.status)) return Promise.resolve("settled");
      return new Promise<SettleWait>((resolve) => {
        let done = false;
        const finish = (why: SettleWait) => {
          if (done) return;
          done = true;
          timers.clearTimeout(timer);
          waiters.get(threadId)?.delete(onSettle);
          resolve(why);
        };
        const onSettle = (why: "settled" | "gone") => finish(why);
        const timer = timers.setTimeout(() => finish("timeout"), ms);
        const set = waiters.get(threadId) ?? new Set();
        set.add(onSettle);
        waiters.set(threadId, set);
      });
    },
    async settled() {
      while (chains.size > 0) await Promise.all([...chains.values()]);
    },
  };
}
