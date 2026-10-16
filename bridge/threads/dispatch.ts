import type {
  ChatAttachment,
  CommandOf,
  QueuedMessage,
  UserMessageInputIntent,
} from "../../shared/v2/contracts.ts";
import { SILENT_AUDIT, type AuditLog } from "../audit.ts";
import type { GuardedSender } from "../guarded-send-route.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { paneKey, PaneBusyError, type PaneQueue } from "../pane-queue.ts";
import { sendKeysPaced, type SleepFn } from "../pane-write-routes.ts";
import { failureText } from "../responses.ts";
import type { StateEngine } from "../state-engine.ts";
import type { EventDraft, ServerThread } from "./events.ts";
import type { JournalIngestor } from "./journal-ingest.ts";
import {
  createQueueDrainer,
  heldRow,
  isSettled,
  queueEvent,
  REAL_TIMERS,
  type DeliverResult,
  type DrainTimers,
  type QueueDrainer,
} from "./queue-drain.ts";
import type { ThreadStore } from "./store.ts";
import type { EffectContext, EffectHandler, EffectOutcome, EffectRegistry } from "./v2-routes.ts";

// Dispatch, queue and steer (T06): `message.dispatch` and the small commands around it, as T05 effect
// handlers.
//
// - start: the guarded send core from spec 24 (`createGuardedSender`, the same function the v1
//   `/api/pane/:id/send` route runs), inside the pane write queue.
// - queue: a row in `queued_messages`; the drainer (queue-drain.ts) sends it when the thread rests.
// - steer: the interrupt key, a wait for the thread to rest (not holding the pane queue), then start.
//
// A blocked thread never receives a dispatch, and no decision here reads a harness id: only the
// thread's capability flags.

/** How long a steer waits for the interrupted run to come to rest before it gives up and holds. */
export const STEER_WAIT_MS = 15_000;
/**
 * After an interrupt key goes out, the thread reads `working` for the engine's hold (and for as long
 * as the harness takes to stop). A second press in that window is refused: Claude's second Escape
 * opens its rewind menu (seen live). Past this long, a press that did nothing may be repeated.
 */
export const INTERRUPT_REPEAT_MS = STEER_WAIT_MS;
/** A dispatched message's longest text (the database keeps it until it is sent). */
export const MAX_DISPATCH_CHARS = 64 * 1024;
export const MAX_ATTACHMENTS = 10;

export interface DispatchDeps {
  store: Pick<
    ThreadStore,
    "append" | "onCommitted" | "getThread" | "listQueued" | "getQueued" | "pendingRequests" | "openRun" | "now" | "newId"
  >;
  sender: GuardedSender;
  herdr: Pick<HerdrClient, "sendPaneKeys" | "sendPaneText">;
  engine: Pick<StateEngine, "current">;
  queue: PaneQueue;
  journal?: Pick<JournalIngestor, "markInterrupted"> | null;
  audit?: AuditLog;
  timers?: DrainTimers;
  sleep?: SleepFn;
  log?: (msg: string) => void;
  steerWaitMs?: number;
  retryMs?: number;
  runWaitMs?: number;
}

export interface Dispatcher {
  /** The T05 effect handlers this slice adds. */
  effects: EffectRegistry;
  drainer: QueueDrainer;
  start(): void;
  stop(): void;
  /** Resolves when background steers and drain passes have finished (tests). */
  settled(): Promise<void>;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────

/** The text that is typed: the message, then each attachment's path, as v1's composer appends them. */
export function messageText(text: string, attachments: readonly ChatAttachment[] = []): string {
  const paths = attachments.map((a) => a.path.trim()).filter((p) => p !== "");
  const body = text.trimEnd();
  return [body, ...paths].filter((part) => part.trim() !== "").join(" ");
}

/** Why `value` is not a list of `{path, name}` attachments, or null. */
export function invalidAttachments(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return "bad-attachments";
  for (const a of value) {
    if (typeof a !== "object" || a === null) return "bad-attachments";
    const { path, name } = a as { path?: unknown; name?: unknown };
    if (typeof path !== "string" || path.trim() === "" || path.length > 4096 || /[\r\n]/.test(path)) return "bad-attachments";
    if (typeof name !== "string" || name.length > 512) return "bad-attachments";
  }
  return null;
}

/** Only what a row keeps of an attachment: never a client's extra fields. */
function cleanAttachments(value: readonly ChatAttachment[] | undefined): ChatAttachment[] {
  return (value ?? []).map((a) => ({ path: a.path, name: a.name }));
}

function invalidText(text: unknown, allowEmpty: boolean): string | null {
  if (typeof text !== "string") return "bad-text";
  if (!allowEmpty && text.trim() === "") return "empty-text";
  if (text.length > MAX_DISPATCH_CHARS) return "text-too-long";
  return null;
}

const refuse = (status: number, code: Extract<EffectOutcome, { ok: false }>["code"], error: string): EffectOutcome => ({
  ok: false,
  status,
  code,
  error,
});
const notFound = (what: string) => refuse(404, "not_found", what);
const conflict = (why: string) => refuse(409, "conflict", why);
const invalid = (why: string) => refuse(400, "invalid", why);

// ── The dispatcher ───────────────────────────────────────────────────────────────────────────────

export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const { store, sender, herdr, engine, queue } = deps;
  const audit = deps.audit ?? SILENT_AUDIT;
  const timers = deps.timers ?? REAL_TIMERS;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const steerWaitMs = deps.steerWaitMs ?? STEER_WAIT_MS;
  const background = new Set<Promise<void>>();
  /** Threads whose interrupt key went out while `working`, and when; cleared when the status moves on. */
  const interrupting = new Map<string, number>();
  let unsubscribe: (() => void) | null = null;
  const pressedRecently = (threadId: string) => {
    const at = interrupting.get(threadId);
    return at !== undefined && store.now() - at < INTERRUPT_REPEAT_MS;
  };

  const hasOpenRequest = (threadId: string) => store.pendingRequests().some((r) => r.threadId === threadId);

  /** The `user_message` item a harness with no journal gets for what Sightr sent (T03 has none to read). */
  const userItem = (thread: ServerThread, text: string, attachments: ChatAttachment[], intent: UserMessageInputIntent): EventDraft[] => {
    if (thread.capabilities.hasJournal) return [];
    const at = store.now();
    const id = `dispatch:${store.newId()}`;
    return [
      {
        type: "turn-item.updated",
        threadId: thread.id,
        payload: {
          item: {
            id,
            threadId: thread.id,
            // T03 adopts it into the run the send opens (an unclaimed user message from the lead window).
            runId: null,
            status: "completed",
            title: null,
            startedAt: null,
            completedAt: null,
            createdAt: at,
            updatedAt: at,
            type: "user_message",
            messageId: id,
            text,
            attachments,
            inputIntent: intent,
          },
        },
      },
    ];
  };

  /** One guarded send of a message to the thread's pane. */
  const deliver = async (
    thread: ServerThread,
    text: string,
    attachments: ChatAttachment[],
    intent: UserMessageInputIntent,
  ): Promise<DeliverResult> => {
    const result = await sender.send(
      { paneId: thread.paneId, ...(thread.terminalId ? { terminalId: thread.terminalId } : {}) },
      messageText(text, attachments),
      { audit },
    );
    if (result.kind === "no-pane") return { kind: "skipped", reason: "pane-gone" };
    if (result.kind === "busy") return { kind: "skipped", reason: "busy" };
    const outcome = result.outcome;
    switch (outcome.status) {
      case "sent":
        return { kind: "sent", events: userItem(thread, text, attachments, intent) };
      case "error":
        return outcome.textDelivered
          ? { kind: "delivered", message: outcome.error }
          : { kind: "failed", reason: "error", message: outcome.error };
      default:
        return { kind: "failed", reason: outcome.status, message: outcome.error };
    }
  };

  const drainer = createQueueDrainer({
    store,
    deliver: (thread, text, attachments, intent) => deliver(thread, text, attachments, intent),
    composerReady: (thread) =>
      sender.composerReady({ paneId: thread.paneId, ...(thread.terminalId ? { terminalId: thread.terminalId } : {}) }),
    timers,
    log,
    ...(deps.retryMs !== undefined ? { retryMs: deps.retryMs } : {}),
    ...(deps.runWaitMs !== undefined ? { runWaitMs: deps.runWaitMs } : {}),
  });

  const commit = (events: EventDraft[], ctx: EffectContext, threadId: string): EffectOutcome => {
    const { last } = store.append(events, { commandId: ctx.commandId, receipt: ctx.receipt });
    return { ok: true, sequence: last, threadId };
  };

  const track = (work: Promise<void>) => {
    const p = work.catch((err) => log(`[threads] dispatch: ${(err as Error).message}`));
    background.add(p);
    void p.then(() => background.delete(p));
  };

  // ── start ──

  const startPath = async (
    thread: ServerThread,
    text: string,
    attachments: ChatAttachment[],
    ctx: EffectContext,
  ): Promise<EffectOutcome> => {
    const finish = drainer.beginSend(thread.id);
    let result: DeliverResult;
    try {
      result = await deliver(thread, text, attachments, "turn_start");
    } catch (err) {
      finish(false);
      throw err;
    }
    finish(result.kind === "sent");
    switch (result.kind) {
      case "skipped":
        // Nothing typed: no receipt, so a retry of the same id may try again.
        return result.reason === "busy" ? refuse(503, "busy", "pane busy") : conflict("pane-gone");
      case "sent":
        // A `sent` emits nothing of its own: T03 starts the run when the status turns `working`.
        return commit(result.events, ctx, thread.id);
      case "delivered":
        return commit(
          [{ type: "dispatch.failed", threadId: thread.id, payload: { reason: "error", message: result.message, textDelivered: true } }],
          ctx,
          thread.id,
        );
      case "failed":
        // The text stays out of the queue: the operator sees the failure and decides.
        return commit(
          [{ type: "dispatch.failed", threadId: thread.id, payload: { reason: result.reason, message: result.message } }],
          ctx,
          thread.id,
        );
    }
  };

  // ── interrupt ──

  type InterruptResult = { ok: true } | { ok: false; outcome: EffectOutcome };

  /** One press of the thread's interrupt keys, in the pane's queue turn; marks the open run. */
  const sendInterrupt = async (thread: ServerThread): Promise<InterruptResult> => {
    const keys = thread.capabilities.interruptKeys ?? [];
    try {
      return await queue.run(paneKey(thread.paneId), async (): Promise<InterruptResult> => {
        const { agents, shellPanes } = engine.current();
        const pane = [...agents, ...shellPanes].find((p) => p.paneId === thread.paneId);
        if (!pane || (thread.terminalId && pane.terminalId && pane.terminalId !== thread.terminalId)) {
          return { ok: false, outcome: conflict("pane-gone") };
        }
        try {
          await sendKeysPaced(herdr, thread.paneId, keys, deps.sleep);
        } catch (err) {
          audit.record({ action: "keys", paneId: thread.paneId, detail: { keys, sent: false, interrupt: true } });
          return { ok: false, outcome: refuse(502, "failed", failureText("interrupt key", err)) };
        }
        audit.record({ action: "keys", paneId: thread.paneId, detail: { keys, interrupt: true } });
        interrupting.set(thread.id, store.now());
        // T03 ends this run `interrupted` once the status leaves `working`.
        const run = store.openRun(thread.id);
        if (run) deps.journal?.markInterrupted(run.id);
        return { ok: true };
      });
    } catch (err) {
      if (err instanceof PaneBusyError) return { ok: false, outcome: refuse(503, "busy", "pane busy") };
      throw err;
    }
  };

  const interruptRefusal = (thread: ServerThread): EffectOutcome | null => {
    if (thread.shelf === "archived") return conflict("thread-archived");
    if (hasOpenRequest(thread.id) || thread.status === "approval" || thread.status === "input") return conflict("needs-response");
    if (!thread.capabilities.canInterrupt || (thread.capabilities.interruptKeys ?? []).length === 0) {
      return refuse(409, "unsupported", "interrupt-unsupported");
    }
    if (thread.status !== "working") return conflict("not-working");
    if (pressedRecently(thread.id)) return conflict("already-interrupting");
    return null;
  };

  // ── steer ──

  /** Take the steer row off the send path, at the head of the queue, and say why. */
  const holdSteer = (threadId: string, rowId: string, reason: string, message?: string) => {
    const rows = store.listQueued(threadId);
    const row = rows.find((r) => r.id === rowId);
    if (!row || store.getThread(threadId) === null) return;
    const next = [heldRow({ ...row, position: -1 }, reason), ...rows.filter((r) => r.id !== rowId)];
    store.append([
      queueEvent(threadId, next, "held", reason),
      {
        type: "dispatch.failed",
        threadId,
        payload: { reason, ...(message !== undefined ? { message } : {}), queuedId: rowId },
      },
    ]);
  };

  const runSteer = async (threadId: string, rowId: string, press: boolean): Promise<void> => {
    const thread = store.getThread(threadId);
    if (!thread) return;
    // A Stop was just pressed: the run is already stopping, and a second key would do something else.
    const pressed: InterruptResult = press ? await sendInterrupt(thread) : { ok: true };
    if (!pressed.ok) {
      const o = pressed.outcome;
      holdSteer(threadId, rowId, "interrupt-failed", o.ok ? undefined : o.error);
      return;
    }
    // The wait holds no pane-queue turn: keys taps and other panes' writes go on meanwhile.
    const waited = await drainer.waitSettled(threadId, steerWaitMs);
    if (waited === "gone") return; // archived: the drainer holds every row with `pane-closed`
    if (waited === "timeout") {
      holdSteer(threadId, rowId, "interrupt-timeout");
      return;
    }
    const fresh = store.getThread(threadId);
    const row = store.getQueued(rowId);
    if (!fresh || fresh.shelf === "archived" || !row || row.state !== "sending") return;

    const finish = drainer.beginSend(threadId);
    let result: DeliverResult;
    try {
      result = await deliver(fresh, row.text, row.attachments, "steer");
    } catch (err) {
      result = { kind: "failed", reason: "error", message: (err as Error).message };
    }
    finish(result.kind === "sent");
    switch (result.kind) {
      case "sent": {
        const rest = store.listQueued(threadId).filter((r) => r.id !== rowId);
        store.append([...result.events, queueEvent(threadId, rest, "sent")]);
        // The rows behind it drain after the steered run ends.
        return;
      }
      case "delivered": {
        const rest = store.listQueued(threadId).filter((r) => r.id !== rowId);
        store.append([
          queueEvent(threadId, rest),
          {
            type: "dispatch.failed",
            threadId,
            payload: { reason: "error", message: result.message, textDelivered: true, queuedId: rowId },
          },
        ]);
        return;
      }
      case "skipped":
        holdSteer(threadId, rowId, result.reason);
        return;
      case "failed":
        holdSteer(threadId, rowId, result.reason, result.message);
        return;
    }
  };

  // ── Handlers ──

  const dispatch: EffectHandler = async (command, ctx) => {
    if (command.type !== "message.dispatch") return invalid("wrong-type");
    const c = command as CommandOf<"message.dispatch">;
    if (typeof c.threadId !== "string" || c.threadId === "") return invalid("bad-threadId");
    if (c.mode !== "start" && c.mode !== "queue" && c.mode !== "steer") return invalid("bad-mode");
    const badAttachments = invalidAttachments(c.attachments);
    if (badAttachments) return invalid(badAttachments);
    const attachments = cleanAttachments(c.attachments);
    const badText = invalidText(c.text, attachments.length > 0);
    if (badText) return invalid(badText);
    if (messageText(c.text, attachments) === "") return invalid("empty-text");

    const thread = store.getThread(c.threadId);
    if (!thread) return notFound("no-such-thread");
    if (thread.shelf === "archived") return conflict("thread-archived");
    const caps = thread.capabilities;
    const status = thread.status;
    const blocked = status === "approval" || status === "input" || hasOpenRequest(thread.id);
    const resting = isSettled(status) || status === "failed";

    const startNow = async (): Promise<EffectOutcome> => {
      if (blocked) return conflict("needs-response");
      if (!resting) return conflict("thread-busy");
      return startPath(thread, c.text, attachments, ctx);
    };

    if (c.mode === "start") return startNow();

    if (c.mode === "queue") {
      if (!caps.canQueueDrain) return refuse(409, "unsupported", "queue-unsupported");
      const rows = store.listQueued(thread.id);
      // Nothing ahead of it and nothing in the way: there is no reason to wait.
      if (rows.length === 0 && resting && !blocked) return startPath(thread, c.text, attachments, ctx);
      const row: QueuedMessage = {
        id: store.newId(),
        threadId: thread.id,
        text: c.text,
        attachments,
        position: rows.length,
        mode: "queue",
        state: "queued",
        createdAt: store.now(),
      };
      const out = commit([queueEvent(thread.id, [...rows, row], "added")], ctx, thread.id);
      drainer.kick(thread.id);
      return out;
    }

    // steer
    if (resting && !blocked) return startPath(thread, c.text, attachments, ctx);
    if (blocked) return conflict("needs-response");
    if (status !== "working") return conflict("thread-busy");
    if (!caps.canQueueDrain) return refuse(409, "unsupported", "queue-unsupported");
    const stopping = pressedRecently(thread.id);
    const refusal = stopping ? null : interruptRefusal(thread);
    if (refusal) return refusal;
    const rows = store.listQueued(thread.id);
    // At the head and already `sending`, so neither the drainer nor a queued row can overtake it.
    const row: QueuedMessage = {
      id: store.newId(),
      threadId: thread.id,
      text: c.text,
      attachments,
      position: -1,
      mode: "steer",
      state: "sending",
      createdAt: store.now(),
    };
    const out = commit([queueEvent(thread.id, [row, ...rows], "added")], ctx, thread.id);
    track(runSteer(thread.id, row.id, !stopping));
    return out;
  };

  const interrupt: EffectHandler = async (command, ctx) => {
    if (command.type !== "run.interrupt") return invalid("wrong-type");
    if (typeof command.threadId !== "string" || command.threadId === "") return invalid("bad-threadId");
    const thread = store.getThread(command.threadId);
    if (!thread) return notFound("no-such-thread");
    const refusal = interruptRefusal(thread);
    if (refusal) return refusal;
    const pressed = await sendInterrupt(thread);
    if (!pressed.ok) return pressed.outcome;
    return commit([], ctx, thread.id);
  };

  const reorder: EffectHandler = async (command, ctx) => {
    if (command.type !== "queued.reorder") return invalid("wrong-type");
    if (typeof command.threadId !== "string" || command.threadId === "") return invalid("bad-threadId");
    if (!Array.isArray(command.ids) || !command.ids.every((id) => typeof id === "string")) return invalid("bad-ids");
    if (!store.getThread(command.threadId)) return notFound("no-such-thread");
    const rows = store.listQueued(command.threadId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The client's list must be the queue as it is now: a stale list is refused, never half-applied.
    if (command.ids.length !== rows.length || new Set(command.ids).size !== rows.length || !command.ids.every((id) => byId.has(id))) {
      return conflict("queue-changed");
    }
    if (command.ids.every((id, i) => rows[i]!.id === id)) return commit([], ctx, command.threadId);
    const next = command.ids.map((id, position) => ({ ...byId.get(id)!, position }));
    return commit([queueEvent(command.threadId, next, "reordered")], ctx, command.threadId);
  };

  const edit: EffectHandler = async (command, ctx) => {
    if (command.type !== "queued.edit") return invalid("wrong-type");
    if (typeof command.id !== "string" || command.id === "") return invalid("bad-id");
    const row = store.getQueued(command.id);
    if (!row) return notFound("no-such-message");
    const badText = invalidText(command.text, row.attachments.length > 0);
    if (badText) return invalid(badText);
    if (row.state === "sending") return conflict("already-sending");
    if (row.text === command.text) return commit([], ctx, row.threadId);
    const rows = store.listQueued(row.threadId).map((r) => (r.id === row.id ? { ...r, text: command.text } : r));
    return commit([queueEvent(row.threadId, rows, "edited")], ctx, row.threadId);
  };

  const cancel: EffectHandler = async (command, ctx) => {
    if (command.type !== "queued.cancel") return invalid("wrong-type");
    if (typeof command.id !== "string" || command.id === "") return invalid("bad-id");
    const row = store.getQueued(command.id);
    if (!row) return notFound("no-such-message");
    if (row.state === "sending") return conflict("already-sending");
    const rows = store.listQueued(row.threadId).filter((r) => r.id !== row.id);
    return commit([queueEvent(row.threadId, rows, "cancelled")], ctx, row.threadId);
  };

  const resume: EffectHandler = async (command, ctx) => {
    if (command.type !== "queue.resume") return invalid("wrong-type");
    if (typeof command.threadId !== "string" || command.threadId === "") return invalid("bad-threadId");
    const thread = store.getThread(command.threadId);
    if (!thread) return notFound("no-such-thread");
    if (thread.shelf === "archived") return conflict("thread-archived");
    const rows = store.listQueued(thread.id);
    if (!rows.some((r) => r.state === "held")) return commit([], ctx, thread.id);
    const next = rows.map((r): QueuedMessage => {
      if (r.state !== "held") return r;
      const { heldReason: _reason, ...rest } = r;
      return { ...rest, state: "queued" };
    });
    const out = commit([queueEvent(thread.id, next, "resumed")], ctx, thread.id);
    drainer.kick(thread.id);
    return out;
  };

  const effects: EffectRegistry = {
    "message.dispatch": dispatch,
    "run.interrupt": interrupt,
    "queued.reorder": reorder,
    "queued.edit": edit,
    "queued.cancel": cancel,
    "queue.resume": resume,
  };

  return {
    effects,
    drainer,
    start() {
      drainer.start();
      unsubscribe ??= store.onCommitted((events) => {
        for (const e of events) {
          if (!e.threadId || !interrupting.has(e.threadId)) continue;
          const status = e.type === "thread.updated" ? e.payload.patch.status : undefined;
          if (e.type === "thread.archived" || (status !== undefined && status !== "working")) interrupting.delete(e.threadId);
        }
      });
    },
    stop() {
      drainer.stop();
      unsubscribe?.();
      unsubscribe = null;
      interrupting.clear();
    },
    async settled() {
      for (;;) {
        await drainer.settled();
        if (background.size === 0) break;
        await Promise.all([...background]);
      }
      await drainer.settled();
    },
  };
}
