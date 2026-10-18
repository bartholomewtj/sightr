import type { ThreadStatus } from "../../shared/v2/contracts.ts";
import type { EventDraft, ServerThread } from "./events.ts";
import type { ThreadStore } from "./store.ts";

// Auto-settle (T3's "auto-settle inactive threads", `days-before-auto-settle`): a bridge-wide runtime
// setting, `autoSettleDays` (0 = off). On a timer, an active thread whose last activity is older than
// that is settled, the same `thread.shelf-changed` a `thread.settle` makes. The herd ingest already
// brings a settled thread back to the active list when it works again.
//
// Never settled: a pinned, snoozed or archived thread (only `active` qualifies), one that is working,
// starting, failed or waiting on the operator (only `idle` and `done` do), and one with a pending
// runtime request or a queued message.

export const DAY_MS = 24 * 60 * 60 * 1000;
/** How often the timer looks. Settling is a day-scale setting; an hour late is fine. */
export const AUTO_SETTLE_EVERY_MS = 10 * 60 * 1000;

const AT_REST: ReadonlySet<ThreadStatus> = new Set(["idle", "done"]);

/** The settle events due at `now` for `days` of inactivity. Pure. */
export function autoSettleEvents(
  threads: readonly ServerThread[],
  opts: { now: number; days: number; waiting: ReadonlySet<string> },
): EventDraft[] {
  if (!Number.isFinite(opts.days) || opts.days <= 0) return [];
  const before = opts.now - opts.days * DAY_MS;
  return threads
    .filter((t) => t.shelf === "active" && AT_REST.has(t.status) && t.lastActivityAt < before && !opts.waiting.has(t.id))
    .map((t) => ({ type: "thread.shelf-changed", threadId: t.id, payload: { shelf: "settled", at: opts.now } }));
}

export interface AutoSettlerDeps {
  store: Pick<ThreadStore, "append" | "listThreads" | "pendingRequests" | "listQueued">;
  /** The current `autoSettleDays` (runtime settings, read on every tick). */
  days: () => number;
  now?: () => number;
  timers?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
  log?: (msg: string) => void;
}

export interface AutoSettler {
  start(): void;
  stop(): void;
  /** One look; returns how many threads it settled. */
  tick(): number;
}

export function createAutoSettler(deps: AutoSettlerDeps): AutoSettler {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const timers = deps.timers ?? {
    setInterval: (fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    },
    clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  let handle: unknown = null;

  const tick = (): number => {
    const days = deps.days();
    if (!(days > 0)) return 0;
    const waiting = new Set([
      ...deps.store.pendingRequests().map((r) => r.threadId),
      ...deps.store.listQueued().map((q) => q.threadId),
    ]);
    const events = autoSettleEvents(deps.store.listThreads(), { now: now(), days, waiting });
    if (events.length === 0) return 0;
    deps.store.append(events);
    log(`[threads] auto-settled ${events.length} thread(s) idle over ${days} day(s)`);
    return events.length;
  };

  return {
    start() {
      if (handle !== null) return;
      const safeTick = () => {
        try {
          tick();
        } catch (err) {
          log(`[threads] auto-settle failed: ${(err as Error).message}`);
        }
      };
      safeTick();
      handle = timers.setInterval(safeTick, AUTO_SETTLE_EVERY_MS);
    },
    stop() {
      if (handle !== null) timers.clearInterval(handle);
      handle = null;
    },
    tick,
  };
}
