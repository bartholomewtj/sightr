import type { HerdrClient } from "../herdr-client.ts";
import { paneKey, type PaneQueue } from "../pane-queue.ts";
import type { EngineSnapshot, StateEngine } from "../state-engine.ts";
import { parseLines } from "../../shared/harness/blocks.ts";
import { composerFor } from "../../shared/harness/composer-kit.ts";
import type { ServerThread } from "./events.ts";
import { modeOnScreen } from "./live-modes.ts";
import { isSettled } from "./queue-drain.ts";
import type { ThreadStore } from "./store.ts";

// Keep `Thread.permissionMode` in step with the pane. A thread started in the harness's default mode
// has no mode on record (the default comes from the user's own settings, e.g. Claude's
// `permissions.defaultMode`), and the operator can press shift+tab in the terminal at any time. So
// each poll reads a resting thread's footer with the same composer-kit reader `thread.permissionMode.set`
// uses (live-modes.ts) and records the mode it names.
//
// Only threads whose capabilities say the mode can be switched are read (the flag, not the harness
// id). A read happens in the pane's write-queue turn, so it can never see a mode mid-cycle while
// `thread.permissionMode.set` presses keys, and it writes nothing to the pane. A screen with no
// composer (a dialog, a menu) or no mode row keeps the recorded mode.

/** Rows of the viewport a mode read takes: the footer sits under the input box at the bottom. */
export const MODE_READ_LINES = 40;
/** The least time between two reads of one resting thread. */
export const MODE_READ_EVERY_MS = 5_000;

export interface ModeWatcherDeps {
  store: Pick<ThreadStore, "append" | "getThread" | "listThreads">;
  engine: Pick<StateEngine, "current" | "onUpdate">;
  herdr: Pick<HerdrClient, "readPane">;
  queue: PaneQueue;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface ModeWatcher {
  start(): void;
  stop(): void;
  /** One pass over every thread (tests call it directly). */
  poll(): Promise<void>;
}

const watched = (thread: ServerThread): boolean =>
  thread.shelf !== "archived" &&
  isSettled(thread.status) &&
  thread.capabilities.canSwitchPermissionMode === true &&
  composerFor(thread.harness)?.permissionModeOf !== undefined;

export function createModeWatcher(deps: ModeWatcherDeps): ModeWatcher {
  const { store, engine, herdr, queue } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const lastRead = new Map<string, number>();
  const inflight = new Set<string>();
  const warned = new Set<string>();
  let off: (() => void) | null = null;
  let stopped = false;

  const livePane = (thread: ServerThread): boolean =>
    engine.current().agents.some((p) => p.paneId === thread.paneId && (p.terminalId ?? "") === thread.terminalId);

  const read = async (thread: ServerThread): Promise<void> => {
    inflight.add(thread.id);
    lastRead.set(thread.id, now());
    try {
      const kit = composerFor(thread.harness);
      if (!kit) return;
      const mode = await queue.run(paneKey(thread.paneId), async () => {
        const { text } = await herdr.readPane(thread.paneId, "visible", MODE_READ_LINES, "ansi");
        return modeOnScreen(kit, parseLines(text));
      });
      warned.delete(thread.id);
      if (mode === null) return;
      // The thread may have started work, or been switched, while the read was out.
      const fresh = store.getThread(thread.id);
      if (!fresh || !watched(fresh) || fresh.permissionMode === mode) return;
      store.append([{ type: "thread.updated", threadId: thread.id, payload: { patch: { permissionMode: mode }, at: now() } }]);
    } catch (err) {
      // Keep the mode as it is; the next poll reads again.
      if (!warned.has(thread.id)) log(`[threads] mode read for ${thread.id}: ${(err as Error).message}`);
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
      if (!watched(thread) || !livePane(thread)) {
        // Read again as soon as it next comes to rest.
        lastRead.delete(thread.id);
        continue;
      }
      if (inflight.has(thread.id)) continue;
      const last = lastRead.get(thread.id);
      if (last !== undefined && now() - last < MODE_READ_EVERY_MS) continue;
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
