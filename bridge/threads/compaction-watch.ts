import type { ThreadStatus } from "../../shared/v2/contracts.ts";
import { detectsCompaction, isCompactingScreen } from "../../web/src/lib/harness/dialog-sniff.ts";
import type { HerdrClient } from "../herdr-client.ts";
import type { EngineSnapshot, StateEngine } from "../state-engine.ts";
import type { ServerThread } from "./events.ts";
import type { ThreadStore } from "./store.ts";

// Compaction awareness. Claude compacts its context on its own when it fills (no user message, so
// the `/compact` check in queue-drain.ts `openRunIsMaintenance` cannot see it), and Pi has an
// auto-compaction too. The interrupt key a steer presses cancels the compaction. So while a thread
// works, each poll reads its screen for the harness's own status row (web/src/lib/harness/
// dialog-sniff.ts `isCompactingScreen`) and keeps `Thread.compacting` in line: dispatch then queues a
// steer instead of pressing the key, and the composer's `canSteer` reads it. A thread that stops
// working stops compacting.
//
// Reads are plain `visible` text, at most one in flight per thread and one per READ_EVERY_MS, and
// never in the pane-write queue: they write nothing, and a dispatch waiting on the queue must not
// hold back the read that tells it to queue.

/** Rows of the viewport a compaction read takes. */
export const COMPACTION_READ_LINES = 40;
/** The least time between two reads of one thread. */
export const READ_EVERY_MS = 1_500;

const WORKING: ReadonlySet<ThreadStatus> = new Set(["working"]);

export interface CompactionWatcherDeps {
  store: Pick<ThreadStore, "append" | "getThread" | "listThreads">;
  engine: Pick<StateEngine, "current" | "onUpdate">;
  herdr: Pick<HerdrClient, "readPane">;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface CompactionWatcher {
  start(): void;
  stop(): void;
  /** One pass over every thread (tests call it directly). */
  poll(): Promise<void>;
}

export function createCompactionWatcher(deps: CompactionWatcherDeps): CompactionWatcher {
  const { store, engine, herdr } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const lastRead = new Map<string, number>();
  const inflight = new Set<string>();
  const warned = new Set<string>();
  let off: (() => void) | null = null;
  let stopped = false;

  const set = (threadId: string, compacting: boolean) => {
    const thread = store.getThread(threadId);
    if (!thread || (thread.compacting === true) === compacting) return;
    store.append([{ type: "thread.updated", threadId, payload: { patch: { compacting }, at: now() } }]);
  };

  const livePane = (thread: ServerThread): boolean =>
    engine.current().agents.some((p) => p.paneId === thread.paneId && (p.terminalId ?? "") === thread.terminalId);

  const read = async (thread: ServerThread): Promise<void> => {
    inflight.add(thread.id);
    lastRead.set(thread.id, now());
    try {
      const { text } = await herdr.readPane(thread.paneId, "visible", COMPACTION_READ_LINES, "text");
      // The thread may have stopped working while the read was out.
      const fresh = store.getThread(thread.id);
      if (!fresh || fresh.shelf === "archived" || !WORKING.has(fresh.status)) return;
      set(thread.id, isCompactingScreen(fresh.harness, text));
      warned.delete(thread.id);
    } catch (err) {
      // Keep the flag as it is; the next poll reads again.
      if (!warned.has(thread.id)) log(`[threads] compaction read for ${thread.id}: ${(err as Error).message}`);
      warned.add(thread.id);
    } finally {
      inflight.delete(thread.id);
    }
  };

  const poll = async (): Promise<void> => {
    const reads: Promise<void>[] = [];
    const seen = new Set<string>();
    for (const thread of store.listThreads()) {
      seen.add(thread.id);
      const watching = thread.shelf !== "archived" && WORKING.has(thread.status) && detectsCompaction(thread.harness);
      if (!watching || !livePane(thread)) {
        if (thread.compacting) set(thread.id, false);
        lastRead.delete(thread.id);
        continue;
      }
      if (inflight.has(thread.id)) continue;
      const last = lastRead.get(thread.id);
      if (last !== undefined && now() - last < READ_EVERY_MS) continue;
      reads.push(read(thread));
    }
    for (const id of [...lastRead.keys()]) if (!seen.has(id)) lastRead.delete(id);
    await Promise.all(reads);
  };

  return {
    start() {
      if (off) return;
      stopped = false;
      off = engine.onUpdate((snap: EngineSnapshot) => {
        if (!stopped && snap.bridge === "connected") void poll();
      });
    },
    stop() {
      stopped = true;
      off?.();
      off = null;
    },
    poll,
  };
}
