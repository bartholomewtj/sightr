import { createHash } from "node:crypto";

import {
  COMMAND_TYPES,
  SHELL_EVENT_TYPES,
  V2_COMMAND_PATH,
  SEARCH_MAX_QUERY_CHARS,
  V2_REPLAY_LIMIT,
  V2_SEARCH_PATH,
  V2_SHELL_PATH,
  type Command,
  type CommandReply,
  type CommandType,
  type HistoryPage,
  type HerdrLink,
  type SequenceFrame,
  type ShellSnapshot,
  type ThreadEvent,
  type V2ErrorBody,
  type V2ErrorCode,
  type V2StreamFrame,
} from "../../shared/v2/contracts.ts";
import { SSE_KEEPALIVE_MS } from "../../shared/limits.ts";
import { deviceAuth, guard, streamMarksSeen } from "../access.ts";
import { ACTIVITY_KEY, type ActivityLedger } from "../activity.ts";
import { SILENT_AUDIT, type AuditLog } from "../audit.ts";
import type { Config } from "../config.ts";
import { SILENT_CONN, type ConnLog } from "../conn-log.ts";
import { paneKey, PaneBusyError, type PaneQueue } from "../pane-queue.ts";
import { decodePathSegment, failureText, json, requireJsonBody, text } from "../responses.ts";
import type { StateEngine } from "../state-engine.ts";
import { buildId as defaultBuildId } from "../static-assets.ts";
import { decide, type DecideState } from "./decide.ts";
import type { ServerThread } from "./events.ts";
import type { HerdIngestor } from "./herd-ingest.ts";
import { HERDR_FLOOR, type V2Gate } from "./herdr-floor.ts";
import type { ThreadWatchers } from "./journal-ingest.ts";
import type { RespondHandler } from "./respond.ts";
import { clampSearchLimit } from "./search.ts";
import { decodeHistoryCursor, type ThreadStore } from "./store.ts";

// The v2 API (spec T05): one idempotent command endpoint, two resumable SSE streams and a paged
// history read, all under `/api/v2/`. Every route refuses with a JSON 503 while v2 is off (`SIGHTR_V2=0`
// or no store), while the herdr version check is pending, or below herdr 0.9.0. v1 routes never look
// at any of this.

export const COMMAND_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A stream client this many bytes behind is sent `reset` and closed; it reconnects with its cursor. */
export const MAX_BEHIND_BYTES = 1024 * 1024;
export const HISTORY_DEFAULT_RUNS = 5;
export const HISTORY_MAX_RUNS = 20;
/** How often open streams are checked for silence (a ping goes out after SSE_KEEPALIVE_MS of it). */
export const KEEPALIVE_TICK_MS = 5_000;

const THREAD_ROUTE = /^\/api\/v2\/thread\/([^/]+)(\/history)?$/;

/** Commands `decide()` answers alone: they change the projection and nothing else. */
const PURE_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>([
  "thread.rename",
  "thread.pin",
  "thread.unpin",
  "thread.snooze",
  "thread.settle",
  "thread.unsettle",
  "thread.archive",
  "thread.unarchive",
  "thread.delete",
  "thread.markRead",
  "thread.markUnread",
  "project.rename",
]);

// ── Effects (T06–T08 register more) ──────────────────────────────────────────────────────────────

/** What a command's receipt stores: the body hash, and for a refusal recorded after work started, the reply. */
export interface ReceiptBody {
  hash: string;
  reply?: { status: number; body: V2ErrorBody };
}

export interface EffectContext {
  commandId: string;
  /** Pass as `store.append(events, { commandId, receipt })` with the batch that commits the command. */
  receipt: { type: CommandType; result: ReceiptBody };
}

export type EffectOutcome =
  | { ok: true; sequence: number; threadId?: string }
  | {
      ok: false;
      status: number;
      code: V2ErrorCode;
      error: string;
      /** The refusal came after work started: the route records `command.rejected` with a receipt. */
      afterWork?: boolean;
      threadId?: string;
      /** What the screen showed when the work stopped (T08: the permission mode), for the operator. */
      shown?: string;
    };

/**
 * An effectful command. It takes its own pane-queue turn (a handler that types into a pane must hold
 * the turn across its reads and writes; the route does not wrap it, so the turn is never nested), and
 * on success commits its events together with `ctx.receipt`.
 */
export type EffectHandler = (command: Command, ctx: EffectContext) => Promise<EffectOutcome>;
export type EffectRegistry = Partial<Record<CommandType, EffectHandler>>;

/** `runtime-request.respond` → T04's respond handler. */
export function respondEffect(respond: RespondHandler): EffectHandler {
  return async (command, ctx) => {
    if (command.type !== "runtime-request.respond") return { ok: false, status: 400, code: "invalid", error: "wrong-type" };
    const result = await respond(
      {
        requestId: command.requestId,
        ...(command.optionIndex !== undefined ? { optionIndex: command.optionIndex } : {}),
        ...(command.optionIndices !== undefined ? { optionIndices: command.optionIndices } : {}),
        ...(command.text !== undefined ? { text: command.text } : {}),
      },
      { commandId: ctx.commandId, receiptResult: ctx.receipt.result },
    );
    if (result.ok) return { ok: true, sequence: result.sequence, threadId: result.request.threadId };
    switch (result.code) {
      case "not_found":
        return { ok: false, status: 404, code: "not_found", error: result.reason };
      case "invalid":
        return { ok: false, status: 400, code: "invalid", error: result.reason };
      case "conflict":
        return { ok: false, status: 409, code: "conflict", error: result.reason };
      case "prompt-changed":
        return { ok: false, status: 409, code: "prompt-changed", error: result.reason, afterWork: true };
      case "busy":
        return { ok: false, status: 503, code: "busy", error: "pane busy" };
      case "failed":
        return { ok: false, status: 502, code: "failed", error: result.reason };
    }
  };
}

// ── Deps ─────────────────────────────────────────────────────────────────────────────────────────

export interface V2Timers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
}

export interface V2RoutesDeps {
  cfg: Config;
  /** Null when v2 is off. */
  store: ThreadStore | null;
  /** Why the store is missing, for the `v2-disabled` body. */
  disabledReason?: string;
  gate: V2Gate;
  engine: Pick<StateEngine, "current">;
  activity: Pick<ActivityLedger, "noteSeen" | "noteUnseen">;
  /** The process pane-write queue (v1 writes and v2 commands serialise on one key per pane). */
  queue: PaneQueue;
  /** The audit log scoped to the request's device (server.ts `auditFor`). */
  auditFor?: (req: Request) => AuditLog;
  conn?: ConnLog;
  effects?: EffectRegistry;
  watchers?: Pick<ThreadWatchers, "add" | "remove">;
  herdIngestor?: Pick<HerdIngestor, "reconcile"> | null;
  /** A seen mark changed; v1's snapshot stream should push. */
  onSeen?: () => void;
  now?: () => number;
  timers?: V2Timers;
  buildId?: () => Promise<string>;
  keepAliveMs?: number;
  maxBehindBytes?: number;
}

export interface V2Routes {
  /** The response for a `/api/v2/*` request, or null when the path is not a v2 route. */
  handle(req: Request, url: URL): Promise<Response> | null;
  /** Open streams, by kind (tests and diagnostics). */
  streamCount(kind?: "shell" | "thread"): number;
  /** Close every stream and stop the heartbeat timer. */
  close(): void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

interface Reply {
  status: number;
  body: CommandReply | V2ErrorBody;
}

const refuse = (status: number, code: V2ErrorCode, error: string, extra: Partial<V2ErrorBody> = {}): Reply => ({
  status,
  body: { ok: false, code, error, ...extra },
});

const respondJson = (reply: Reply, req: Request): Response => json(reply.body, req.headers.get("accept-encoding"), reply.status);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** JSON with sorted keys, so two bodies that differ only in key order hash the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The hash a receipt keeps: the body without its `commandId`. */
export function commandHash(body: Record<string, unknown>): string {
  const { commandId: _id, ...rest } = body;
  return createHash("sha256").update(stable(rest)).digest("hex");
}

type FieldKind = "string" | "string?" | "number" | "number?" | "numbers?";

/** Field shapes for the commands this slice runs; effect handlers check their own. */
const COMMAND_FIELDS: Partial<Record<CommandType, Record<string, FieldKind>>> = {
  "thread.rename": { threadId: "string", title: "string" },
  "thread.pin": { threadId: "string" },
  "thread.unpin": { threadId: "string" },
  "thread.snooze": { threadId: "string", until: "number" },
  "thread.settle": { threadId: "string" },
  "thread.unsettle": { threadId: "string" },
  "thread.archive": { threadId: "string" },
  "thread.unarchive": { threadId: "string" },
  "thread.delete": { threadId: "string" },
  "thread.markRead": { threadId: "string" },
  "thread.markUnread": { threadId: "string" },
  "project.rename": { projectId: "string", label: "string" },
  "runtime-request.respond": { requestId: "string", optionIndex: "number?", optionIndices: "numbers?", text: "string?" },
};

/** Why `body` is not a well-formed `type` command, or null. */
export function invalidFields(type: CommandType, body: Record<string, unknown>): string | null {
  const fields = COMMAND_FIELDS[type];
  if (!fields) return null;
  for (const [name, kind] of Object.entries(fields)) {
    const v = body[name];
    const ok =
      kind === "string"
        ? typeof v === "string" && v.length > 0
        : kind === "string?"
          ? v === undefined || typeof v === "string"
          : kind === "number"
          ? typeof v === "number" && Number.isFinite(v)
          : kind === "number?"
            ? v === undefined || (typeof v === "number" && Number.isFinite(v))
            : v === undefined || (Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n)));
    if (!ok) return `bad-${name}`;
  }
  return null;
}

/** The resume cursor: the larger of `?after=` and `Last-Event-ID` (a browser's own retry sends the latter). */
export function resumeCursor(req: Request, url: URL): number {
  const parse = (raw: string | null): number => {
    if (raw === null || !/^\d{1,15}$/.test(raw.trim())) return 0;
    return Number(raw.trim());
  };
  return Math.max(parse(url.searchParams.get("after")), parse(req.headers.get("last-event-id")));
}

const decisionStatus = { not_found: 404, invalid: 400, conflict: 409 } as const;

function frame(event: V2StreamFrame, data: unknown, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const eventFrame = (e: ThreadEvent): string => frame("event", e, e.sequence);

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const SHELL_TYPES: ReadonlySet<string> = new Set(SHELL_EVENT_TYPES);

// ── Routes ───────────────────────────────────────────────────────────────────────────────────────

interface OpenStream {
  kind: "shell" | "thread";
  clientId: string;
  lastWrite: number;
  write(chunk: string): boolean;
  end(why: "cancel" | "replaced" | "reset"): void;
}

export function createV2Routes(deps: V2RoutesDeps): V2Routes {
  const { cfg, store, gate, engine, activity, queue } = deps;
  const auditFor = deps.auditFor ?? (() => SILENT_AUDIT);
  const conn = deps.conn ?? SILENT_CONN;
  const effects = deps.effects ?? {};
  const now = deps.now ?? Date.now;
  const timers: V2Timers = deps.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  };
  const getBuildId = deps.buildId ?? defaultBuildId;
  const keepAliveMs = deps.keepAliveMs ?? SSE_KEEPALIVE_MS;
  const maxBehind = deps.maxBehindBytes ?? MAX_BEHIND_BYTES;
  /** The herdr link as the state engine last saw it (T12's "herdr down" banner reads it off the streams). */
  const herdrLink = (): HerdrLink => (engine.current().bridge === "connected" ? "connected" : "disconnected");

  /** Commands in flight by id: a duplicate waits for the first and then reads its receipt. */
  const inflight = new Map<string, Promise<Reply>>();
  const streams = new Set<OpenStream>();
  let ticker: unknown = null;

  // ── Gate ──

  function refusal(): Reply | null {
    if (!store) return refuse(503, "v2-disabled", deps.disabledReason ?? "v2 is off on this bridge (SIGHTR_V2=0)");
    switch (gate.state()) {
      case "ok":
        return null;
      case "pending":
        return refuse(503, "v2-starting", gate.reason());
      case "too-old":
        return refuse(503, "herdr-too-old", gate.reason(), { have: gate.version() ?? "unknown", need: HERDR_FLOOR });
      default:
        return refuse(503, "v2-starting", gate.reason());
    }
  }

  // ── Commands ──

  function fromReceipt(s: ThreadStore, commandId: string, type: CommandType, hash: string): Reply | null {
    const r = s.receipt(commandId);
    if (!r) return null;
    const body = isRecord(r.result) ? (r.result as Partial<ReceiptBody>) : {};
    if (r.type !== type || (body.hash !== undefined && body.hash !== hash)) {
      return refuse(409, "conflict", "commandId was already used for a different command");
    }
    if (body.reply) return body.reply;
    return { status: 200, body: { ok: true, sequence: r.sequence } };
  }

  function paneAlive(thread: ServerThread): boolean {
    const snap = engine.current();
    if (snap.bridge !== "connected") return false;
    return [...snap.agents, ...snap.shellPanes].some(
      (p) => p.paneId === thread.paneId && (!thread.terminalId || !p.terminalId || p.terminalId === thread.terminalId),
    );
  }

  function audit(req: Request, type: CommandType, threadId: string | undefined, paneId?: string): void {
    auditFor(req).record({
      action: "v2-command",
      ...(paneId !== undefined ? { paneId } : {}),
      detail: { type, ...(threadId !== undefined ? { threadId } : {}) },
    });
  }

  async function runPure(s: ThreadStore, req: Request, command: Command, hash: string): Promise<Reply> {
    const threadId = "threadId" in command ? command.threadId : undefined;
    const projectId = command.type === "project.rename" ? command.projectId : undefined;
    let key: string;
    if (threadId !== undefined) {
      const thread = s.getThread(threadId);
      if (!thread) return refuse(404, "not_found", "no-such-thread");
      key = paneKey(thread.paneId);
    } else if (projectId !== undefined) {
      if (!s.getProject(projectId)) return refuse(404, "not_found", "no-such-project");
      key = `v2:project:${projectId}`;
    } else {
      key = "v2:global";
    }

    return queue.run(key, async (): Promise<Reply> => {
      const again = fromReceipt(s, command.commandId, command.type, hash);
      if (again) return again;
      const thread = threadId !== undefined ? s.getThread(threadId) : undefined;
      const state: DecideState = {
        ...(threadId !== undefined ? { thread } : {}),
        ...(projectId !== undefined ? { project: s.getProject(projectId) } : {}),
        paneAlive: thread ? paneAlive(thread) : false,
        maxPinOrder: s.maxPinOrder(),
      };
      const decision = decide(state, command, { now: s.now(), newId: s.newId });
      if (!decision.ok) return refuse(decisionStatus[decision.code], decision.code, decision.reason);

      // "Seen" lives in activity.json, shared with v1 (ADR 0003); the herd ingest derives
      // `unreadDone` from it, so the ledger moves first and the reconcile below agrees with the event.
      let seenChanged = false;
      if (thread && command.type === "thread.markRead") seenChanged = activity.noteSeen(ACTIVITY_KEY, thread.paneId);
      if (thread && command.type === "thread.markUnread") seenChanged = activity.noteUnseen(ACTIVITY_KEY, thread.paneId);

      const result: ReceiptBody = { hash };
      const { last } = s.append(decision.events, { commandId: command.commandId, receipt: { type: command.type, result } });
      if (command.type === "thread.markRead" || command.type === "thread.markUnread") {
        if (seenChanged) deps.onSeen?.();
        deps.herdIngestor?.reconcile(engine.current());
      }
      audit(req, command.type, threadId, thread?.paneId);
      return { status: 200, body: { ok: true, sequence: last } };
    });
  }

  async function runEffect(s: ThreadStore, req: Request, command: Command, hash: string): Promise<Reply> {
    const handler = effects[command.type];
    if (!handler) return refuse(501, "unsupported", `${command.type} is not supported by this bridge yet`);
    const result: ReceiptBody = { hash };
    const outcome = await handler(command, { commandId: command.commandId, receipt: { type: command.type, result } });
    if (outcome.ok) {
      audit(req, command.type, outcome.threadId ?? ("threadId" in command ? command.threadId : undefined));
      return { status: 200, body: { ok: true, sequence: outcome.sequence } };
    }
    const raced = fromReceipt(s, command.commandId, command.type, hash);
    if (raced) return raced;
    const reply = refuse(outcome.status, outcome.code, outcome.error);
    if (outcome.shown !== undefined) (reply.body as V2ErrorBody).shown = outcome.shown;
    if (outcome.afterWork) {
      // Work started before the refusal: record it, so a retry of this id gets the same answer.
      const threadId = outcome.threadId ?? ("threadId" in command ? command.threadId : undefined);
      s.append(
        [
          {
            type: "command.rejected",
            ...(threadId !== undefined ? { threadId } : {}),
            payload: { reason: outcome.error, code: outcome.code, ...(outcome.shown !== undefined ? { shown: outcome.shown } : {}) },
          },
        ],
        {
          commandId: command.commandId,
          receipt: { type: command.type, result: { hash, reply: { status: reply.status, body: reply.body as V2ErrorBody } } },
        },
      );
      audit(req, command.type, threadId);
    }
    return reply;
  }

  async function execute(s: ThreadStore, req: Request, command: Command, hash: string): Promise<Reply> {
    const replay = fromReceipt(s, command.commandId, command.type, hash);
    if (replay) return replay;
    try {
      return PURE_COMMANDS.has(command.type) ? await runPure(s, req, command, hash) : await runEffect(s, req, command, hash);
    } catch (err) {
      if (err instanceof PaneBusyError) return refuse(503, "busy", "pane busy");
      return refuse(500, "failed", failureText(`v2 ${command.type}`, err));
    }
  }

  async function commandRoute(req: Request): Promise<Response> {
    const denied = guard(req, cfg, "write");
    if (denied) return denied;
    const off = refusal();
    if (off) return respondJson(off, req);
    const notJson = requireJsonBody(req);
    if (notJson) return notJson;
    const s = store!;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return respondJson(refuse(400, "invalid", "bad-json"), req);
    }
    if (!isRecord(body)) return respondJson(refuse(400, "invalid", "bad-body"), req);
    const { commandId, type } = body;
    if (typeof commandId !== "string" || !COMMAND_ID.test(commandId)) {
      return respondJson(refuse(400, "invalid", "bad-commandId"), req);
    }
    if (typeof type !== "string" || !(COMMAND_TYPES as readonly string[]).includes(type)) {
      return respondJson(refuse(400, "invalid", "unknown-type"), req);
    }
    const bad = invalidFields(type as CommandType, body);
    if (bad) return respondJson(refuse(400, "invalid", bad), req);
    const command = body as unknown as Command;
    const hash = commandHash(body);

    const before = inflight.get(commandId);
    const run = (async () => {
      if (before) await before.catch(() => undefined);
      return execute(s, req, command, hash);
    })();
    inflight.set(commandId, run);
    try {
      return respondJson(await run, req);
    } finally {
      if (inflight.get(commandId) === run) inflight.delete(commandId);
    }
  }

  // ── Streams ──

  function ensureTicker(): void {
    if (ticker !== null || streams.size === 0) return;
    ticker = timers.setInterval(() => {
      const at = now();
      for (const stream of [...streams]) {
        if (at - stream.lastWrite < keepAliveMs) continue;
        // The comment keeps intermediaries from idling the socket; `ping` is the frame a client's
        // watchdog sees (EventSource hides comments), as on v1's /api/events.
        const ping: SequenceFrame = { sequence: store?.lastSequence() ?? 0, herdr: herdrLink() };
        if (stream.write(": keep-alive\n\n")) stream.write(frame("ping", ping));
      }
    }, Math.min(KEEPALIVE_TICK_MS, keepAliveMs));
  }

  function stopTickerIfIdle(): void {
    if (streams.size > 0 || ticker === null) return;
    timers.clearInterval(ticker);
    ticker = null;
  }

  interface StreamSpec {
    kind: "shell" | "thread";
    clientId: string;
    /** The catch-up frames (snapshot or replay), computed in the same tick the live listener attaches. */
    catchUp: string[];
    /** The sequence `synchronized` reports; live events at or below it are not sent. */
    synced: number;
    accepts: (e: ThreadEvent) => boolean;
    onEnd?: (why: "cancel" | "replaced" | "reset", upMs: number) => void;
  }

  function openStream(s: ThreadStore, spec: StreamSpec): Response {
    const encoder = new TextEncoder();
    const openedAt = now();
    const catchUpBytes = spec.catchUp.reduce((n, chunk) => n + encoder.encode(chunk).byteLength, 0);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let lastSent = spec.synced;
    let ended = false;
    let unsubscribe: (() => void) | null = null;

    const stream: OpenStream = {
      kind: spec.kind,
      clientId: spec.clientId,
      lastWrite: openedAt,
      write(chunk) {
        if (ended) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stream.end("cancel");
          return false;
        }
        stream.lastWrite = now();
        if ((controller.desiredSize ?? 0) < 0) {
          // More than maxBehind bytes queued: the client is not reading. Tell it, then close; it
          // reconnects with its last id and gets a replay or a snapshot.
          try {
            controller.enqueue(encoder.encode(frame("reset", { sequence: lastSent })));
          } catch {
            /* closed */
          }
          stream.end("reset");
          return false;
        }
        return true;
      },
      end(why) {
        if (ended) return;
        ended = true;
        unsubscribe?.();
        unsubscribe = null;
        streams.delete(stream);
        stopTickerIfIdle();
        if (why !== "cancel") {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
        spec.onEnd?.(why, now() - openedAt);
      },
    };

    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
          // A newer stream from the same client replaces this one (as v1's attach does).
          if (spec.clientId) {
            for (const old of [...streams]) {
              if (old.kind === spec.kind && old.clientId === spec.clientId) old.end("replaced");
            }
          }
          streams.add(stream);
          // Attach and catch up in one synchronous step: `append` notifies synchronously, so no event
          // can commit between the catch-up read and the live listener.
          unsubscribe = s.onCommitted((events) => {
            for (const e of events) {
              if (e.sequence <= lastSent || !spec.accepts(e)) continue;
              if (!stream.write(eventFrame(e))) return;
              lastSent = e.sequence;
            }
          });
          for (const chunk of spec.catchUp) if (!stream.write(chunk)) return;
          const synced: SequenceFrame = { sequence: spec.synced, herdr: herdrLink() };
          if (!stream.write(frame("synchronized", synced, spec.synced))) return;
          ensureTicker();
          void getBuildId()
            .then((id) => stream.write(frame("build", id)))
            .catch(() => undefined);
        },
        cancel() {
          stream.end("cancel");
        },
      },
      // The catch-up goes out in one go before the client reads a byte, so it does not count as
      // "behind"; only what queues up after it does.
      { highWaterMark: maxBehind + catchUpBytes, size: (chunk) => chunk?.byteLength ?? 0 },
    );
    return new Response(body, { headers: SSE_HEADERS });
  }

  function shellRoute(req: Request, url: URL): Response {
    const denied = guard(req, cfg, "read");
    if (denied) return denied;
    const off = refusal();
    if (off) return respondJson(off, req);
    const s = store!;

    const after = resumeCursor(req, url);
    const last = s.lastSequence();
    const catchUp: string[] = [];
    let replayed = false;
    if (after > 0 && after <= last && after >= s.minSequence()) {
      const events = s.eventsAfter(after, { types: SHELL_EVENT_TYPES, limit: V2_REPLAY_LIMIT + 1 });
      if (events.length <= V2_REPLAY_LIMIT) {
        for (const e of events) catchUp.push(eventFrame(e));
        replayed = true;
      }
    }
    let synced = last;
    if (!replayed) {
      const device = deviceAuth(req, cfg);
      const snapshot: ShellSnapshot = {
        ...s.snapshotShell(),
        herdr: herdrLink(),
        ...(device.enforced ? { device } : {}),
      };
      catchUp.push(frame("snapshot", snapshot, snapshot.sequence));
      synced = snapshot.sequence;
    }

    const sid = url.searchParams.get("client")?.trim() ?? "";
    conn.bridge({ kind: "sse.attach", sid });
    return openStream(s, {
      kind: "shell",
      clientId: sid,
      catchUp,
      synced,
      accepts: (e) => SHELL_TYPES.has(e.type),
      onEnd: (why, upMs) => conn.bridge({ kind: "sse.detach", sid, upMs, why: why === "replaced" ? "replaced" : "cancel" }),
    });
  }

  function threadRoute(req: Request, url: URL, threadId: string): Response {
    const denied = guard(req, cfg, "read");
    if (denied) return denied;
    const off = refusal();
    if (off) return respondJson(off, req);
    const s = store!;

    const thread = s.getThread(threadId);
    if (!thread) return respondJson(refuse(404, "not_found", "no-such-thread"), req);

    const after = resumeCursor(req, url);
    const last = s.lastSequence();
    const catchUp: string[] = [];
    let replayed = false;
    if (after > 0 && after <= last && after >= s.minSequence()) {
      const events = s.eventsAfter(after, { threadId, limit: V2_REPLAY_LIMIT + 1 });
      if (events.length <= V2_REPLAY_LIMIT) {
        for (const e of events) catchUp.push(eventFrame(e));
        replayed = true;
      }
    }
    let synced = last;
    if (!replayed) {
      const snapshot = s.snapshotThread(threadId);
      if (!snapshot) return respondJson(refuse(404, "not_found", "no-such-thread"), req);
      catchUp.push(frame("snapshot", snapshot, snapshot.sequence));
      synced = snapshot.sequence;
    }

    // Opening a thread is looking at it (ADR 0003), under v1's cross-site rule.
    if (streamMarksSeen(req) && activity.noteSeen(ACTIVITY_KEY, thread.paneId)) {
      deps.onSeen?.();
      deps.herdIngestor?.reconcile(engine.current());
    }

    // A watcher makes T03 read the thread's journal while the stream is open.
    deps.watchers?.add(threadId);
    return openStream(s, {
      kind: "thread",
      clientId: url.searchParams.get("client")?.trim() ?? "",
      catchUp,
      synced,
      accepts: (e) => e.threadId === threadId,
      onEnd: () => deps.watchers?.remove(threadId),
    });
  }

  function historyRoute(req: Request, url: URL, threadId: string): Response {
    const denied = guard(req, cfg, "read");
    if (denied) return denied;
    const off = refusal();
    if (off) return respondJson(off, req);
    const s = store!;
    if (!s.getThread(threadId)) return respondJson(refuse(404, "not_found", "no-such-thread"), req);

    const rawLimit = Number(url.searchParams.get("limit") ?? "");
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, HISTORY_MAX_RUNS) : HISTORY_DEFAULT_RUNS;
    const cursor = url.searchParams.get("before");
    let before: number | null = null;
    if (cursor !== null && cursor !== "") {
      before = decodeHistoryCursor(cursor);
      if (before === null) {
        const empty: HistoryPage = { runs: [], loose: [], nextCursor: null };
        return json(empty, req.headers.get("accept-encoding"));
      }
    }
    return json(s.historyPage(threadId, before, limit), req.headers.get("accept-encoding"));
  }

  /** `GET /api/v2/search?q=&limit=&archived=1`: matches in user and assistant messages and command inputs. */
  function searchRoute(req: Request, url: URL): Response {
    const denied = guard(req, cfg, "read");
    if (denied) return denied;
    const off = refusal();
    if (off) return respondJson(off, req);
    const q = url.searchParams.get("q");
    if (q === null) return respondJson(refuse(400, "invalid", "missing-q"), req);
    if (q.length > SEARCH_MAX_QUERY_CHARS) return respondJson(refuse(400, "invalid", "q-too-long"), req);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null || rawLimit === "" ? undefined : Number(rawLimit);
    if (limit !== undefined && !Number.isInteger(limit)) return respondJson(refuse(400, "invalid", "bad-limit"), req);
    const archived = url.searchParams.get("archived");
    const result = store!.search({ q, limit: clampSearchLimit(limit), includeArchived: archived === "1" || archived === "true" });
    return json(result, req.headers.get("accept-encoding"));
  }

  const methodNotAllowed = () => Promise.resolve(text("method not allowed", 405));

  return {
    handle(req, url) {
      const { pathname } = url;
      if (pathname === V2_COMMAND_PATH) return req.method === "POST" ? commandRoute(req) : methodNotAllowed();
      if (pathname === V2_SHELL_PATH) return req.method === "GET" ? Promise.resolve(shellRoute(req, url)) : methodNotAllowed();
      if (pathname === V2_SEARCH_PATH) return req.method === "GET" ? Promise.resolve(searchRoute(req, url)) : methodNotAllowed();
      const m = THREAD_ROUTE.exec(pathname);
      if (m) {
        if (req.method !== "GET") return methodNotAllowed();
        const threadId = decodePathSegment(m[1]!);
        if (threadId === null) return Promise.resolve(text("bad thread id", 400));
        return Promise.resolve(m[2] ? historyRoute(req, url, threadId) : threadRoute(req, url, threadId));
      }
      return null;
    },
    streamCount(kind) {
      return [...streams].filter((s) => kind === undefined || s.kind === kind).length;
    },
    close() {
      for (const stream of [...streams]) stream.end("replaced");
      if (ticker !== null) timers.clearInterval(ticker);
      ticker = null;
    },
  };
}
