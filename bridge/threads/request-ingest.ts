import { createHash } from "node:crypto";
import type { RuntimeRequest, RuntimeRequestKind, ThreadStatus } from "../../shared/v2/contracts.ts";
import { parseDialog } from "../../web/src/lib/harness/dialog-kit.ts";
import type { AuditLog } from "../audit.ts";
import type { Config } from "../config.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { paneKey, type PaneQueue } from "../pane-queue.ts";
import type { SleepFn } from "../pane-write-routes.ts";
import type { AgentView, EngineSnapshot, StateEngine } from "../state-engine.ts";
import type { EventDraft, ServerThread } from "./events.ts";
import { requestEvents } from "./request-items.ts";
import { createRespondHandler, DIALOG_READ_LINES, type RespondHandler } from "./respond.ts";
import type { ThreadStore } from "./store.ts";

// Request ingest (T04): a thread that waits on the operator (`input` / `approval`, herdr `blocked`)
// has its screen read and parsed (web/src/lib/harness/dialog-kit.ts). A dialog that parses becomes a
// pending runtime request, bound to the screen text it came from; one that does not parse makes no
// request (the client shows the Terminal tab). The request is answered by `respond` (respond.ts),
// which types the option's keys only after a fresh read still shows that text.

/** Rows of the viewport read per poll (respond.ts re-reads with the same count). */
export const REQUEST_READ_LINES = DIALOG_READ_LINES;
/**
 * After a respond resolves a request, the same screen does not open a new one for this long. The
 * read right after the keys can still catch the old dialog before the harness redraws; past this,
 * a dialog that is still there (the keys did not take) is published again so it can be answered.
 */
export const RESOLVED_GRACE_MS = 3_000;

const REQUESTING: ReadonlySet<ThreadStatus> = new Set(["input", "approval"]);
const WARN_EVERY_MS = 10 * 60_000;

/** The request's identity for clients: a hash of the bound text. The bridge checks the text itself. */
export function bindingHash(boundText: string): string {
  return createHash("sha256").update(boundText).digest("hex");
}

/** A waiting thread's status from its open requests: `approval` for a permission or trust decision. */
export function requestingStatus(kinds: readonly RuntimeRequestKind[]): ThreadStatus {
  return kinds.some((k) => k === "permission" || k === "trust") ? "approval" : "input";
}

export interface RequestIngestorDeps {
  store: Pick<
    ThreadStore,
    "append" | "getThread" | "listThreads" | "pendingRequests" | "openRun" | "getRequest" | "requestBoundText"
  >;
  engine: Pick<StateEngine, "current" | "onUpdate">;
  herdr: Pick<HerdrClient, "readPane" | "sendPaneKeys" | "sendPaneText">;
  /** The process's one pane write queue (server.ts takes the same one). */
  queue: PaneQueue;
  cfg: Config;
  audit?: AuditLog;
  now?: () => number;
  newId?: () => string;
  log?: (msg: string) => void;
  sleep?: SleepFn;
}

export interface RequestIngestor {
  start(): void;
  stop(): void;
  /** Re-read every waiting thread (and close the requests of threads that stopped waiting). */
  poll(): Promise<void>;
  /** `runtime-request.respond` (T05 calls it). */
  respond: RespondHandler;
  /** Resolves when every queued pass has finished (tests). */
  settled(): Promise<void>;
}

export function createRequestIngestor(deps: RequestIngestorDeps): RequestIngestor {
  const { store, engine, herdr, queue } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((msg: string) => console.warn(msg));

  const chains = new Map<string, Promise<void>>();
  const queued = new Set<string>();
  const resolvedAt = new Map<string, { hash: string; at: number }>();
  const warnedAt = new Map<string, number>();
  const unsubscribe: (() => void)[] = [];
  let stopped = false;

  const warn = (threadId: string, msg: string) => {
    const last = warnedAt.get(threadId);
    const at = now();
    if (last !== undefined && at - last < WARN_EVERY_MS) return;
    warnedAt.set(threadId, at);
    log(`[threads] request ingest for ${threadId}: ${msg}`);
  };

  const livePane = (thread: ServerThread): AgentView | undefined => {
    const { agents } = engine.current();
    const pane = agents.find((p) => p.paneId === thread.paneId);
    return pane && (pane.terminalId ?? "") === thread.terminalId ? pane : undefined;
  };

  const pendingFor = (threadId: string) => store.pendingRequests().filter((r) => r.threadId === threadId);

  /**
   * Expire `stale`, publish `fresh` when it is new, and bring a waiting thread's status in line with
   * the request that stays open (`fresh` or `kept`), as one batch. Nothing to change writes nothing.
   */
  const commit = (
    thread: ServerThread,
    stale: readonly RuntimeRequest[],
    open: { fresh: RuntimeRequest; boundText: string } | { kept: RuntimeRequest } | null,
  ) => {
    const at = now();
    const events: EventDraft[] = [];
    for (const r of stale) events.push(...requestEvents({ ...r, status: "expired", updatedAt: at }));
    if (open && "fresh" in open) events.push(...requestEvents(open.fresh, open.boundText));
    if (REQUESTING.has(thread.status)) {
      const kind = open ? ("fresh" in open ? open.fresh.kind : open.kept.kind) : null;
      const status = requestingStatus(kind ? [kind] : []);
      if (status !== thread.status) events.push({ type: "thread.updated", threadId: thread.id, payload: { patch: { status }, at } });
    }
    if (events.length > 0) store.append(events);
  };

  const pass = async (threadId: string): Promise<void> => {
    const before = store.getThread(threadId);
    if (!before || before.shelf === "archived") return;
    if (!REQUESTING.has(before.status)) {
      // Answered at the desk, or the run ended: whatever is still open is stale.
      const stale = pendingFor(threadId);
      if (stale.length > 0) commit(before, stale, null);
      resolvedAt.delete(threadId);
      return;
    }
    const pane = livePane(before);
    if (!pane) return; // gone: the herd ingest archives the thread and expires its requests

    let text: string;
    try {
      // In the pane's queue turn, so the read never lands between a reply's (or a respond's) steps.
      const read = await queue.run(paneKey(pane.paneId), () =>
        herdr.readPane(pane.paneId, "visible", REQUEST_READ_LINES, "ansi"),
      );
      text = read.text;
    } catch (err) {
      // Keep the request as it is; the next poll tries again.
      warn(threadId, `read failed: ${(err as Error).message}`);
      return;
    }

    // The store may have moved while the read waited (a respond, the herd ingest).
    const thread = store.getThread(threadId);
    if (!thread || thread.shelf === "archived") return;
    const pending = pendingFor(threadId);
    if (!REQUESTING.has(thread.status)) {
      if (pending.length > 0) commit(thread, pending, null);
      return;
    }

    const parsed = parseDialog(pane.agent, text);
    if (!parsed) {
      // Blocked but nothing parses: no request and no guessed keys. The client shows the Terminal.
      commit(thread, pending, null);
      return;
    }
    const hash = bindingHash(parsed.boundText);
    const open = pending.find((r) => r.bindingHash === hash);
    if (open) {
      // Same screen: nothing new. Expire any other leftovers and keep the status in line.
      commit(thread, pending.filter((r) => r !== open), { kept: open });
      return;
    }
    const recent = resolvedAt.get(threadId);
    if (pending.length === 0 && recent && recent.hash === hash && now() - recent.at < RESOLVED_GRACE_MS) return;

    const at = now();
    const run = store.openRun(threadId);
    const request: RuntimeRequest = {
      id: newId(),
      threadId,
      kind: parsed.kind,
      prompt: parsed.prompt,
      options: parsed.options,
      status: "pending",
      bindingHash: hash,
      createdAt: at,
      updatedAt: at,
      ...(run ? { runId: run.id } : {}),
      ...(parsed.via ? { via: parsed.via } : {}),
      ...(parsed.decision ? { decision: parsed.decision } : {}),
      ...(parsed.steps ? { steps: parsed.steps } : {}),
      ...(parsed.multiSelect ? { multiSelect: parsed.multiSelect } : {}),
      ...(parsed.preview ? { preview: parsed.preview } : {}),
      ...(parsed.answers ? { answers: parsed.answers } : {}),
      ...(parsed.freeText ? { freeText: true } : {}),
    };
    commit(thread, pending, { fresh: request, boundText: parsed.boundText });
  };

  const schedule = (threadId: string): Promise<void> => {
    if (queued.has(threadId)) return chains.get(threadId)!;
    queued.add(threadId);
    const prev = chains.get(threadId) ?? Promise.resolve();
    const next = prev.then(async () => {
      queued.delete(threadId);
      if (stopped) return;
      try {
        await pass(threadId);
      } catch (err) {
        warn(threadId, (err as Error).message);
      }
    });
    chains.set(threadId, next);
    void next.then(() => {
      if (chains.get(threadId) === next) chains.delete(threadId);
    });
    return next;
  };

  const poll = async (): Promise<void> => {
    const waiting = new Set(store.pendingRequests().map((r) => r.threadId));
    const passes: Promise<void>[] = [];
    for (const t of store.listThreads()) {
      if (t.shelf === "archived") continue;
      if (REQUESTING.has(t.status) || waiting.has(t.id)) passes.push(schedule(t.id));
    }
    await Promise.all(passes);
  };

  const respond = createRespondHandler({
    store,
    herdr,
    cfg: deps.cfg,
    queue,
    ...(deps.audit ? { audit: deps.audit } : {}),
    now,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    onResolved: (request) => resolvedAt.set(request.threadId, { hash: request.bindingHash, at: now() }),
  });

  return {
    start() {
      if (unsubscribe.length > 0) return;
      stopped = false;
      // Subscribed after the herd ingest (index.ts), so each poll's statuses are already in the store.
      unsubscribe.push(
        engine.onUpdate((snap: EngineSnapshot) => {
          if (snap.bridge === "connected") void poll();
        }),
      );
    },
    stop() {
      stopped = true;
      for (const off of unsubscribe.splice(0)) off();
    },
    poll,
    respond,
    async settled() {
      while (chains.size > 0) await Promise.all([...chains.values()]);
    },
  };
}
