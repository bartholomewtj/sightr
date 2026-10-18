/**
 * Pure reducers for the v2 streams. `applyShellEvent` keeps the sidebar's view (projects, threads,
 * runtime-request summaries); `applyThreadEvent` keeps one open thread (runs, items, requests, queue).
 *
 * Rules (T09):
 * - An event whose sequence is not above the state's is dropped: duplicates and stale replays never
 *   change state.
 * - The same state object comes back when nothing changed, so Zustand selectors stay quiet.
 * - Unknown event types are ignored (a newer bridge may send more).
 * - A malformed payload is dropped and reported through `onDrop`; these functions never throw.
 *
 * Projections mirror `bridge/threads/store.ts` `applyEvent`, so a client that applies the live events
 * after a snapshot ends where a fresh snapshot would.
 */
import type {
  Project,
  QueuedMessage,
  Run,
  RuntimeRequest,
  RuntimeRequestSummary,
  Thread,
  ThreadEvent,
  TurnItem,
} from "@shared/v2/contracts";

import type { HistoryPage, ShellSnapshot, ThreadSnapshot } from "./wire";

export type DropReason = "malformed" | "stale";
export type OnDrop = (reason: DropReason, event: unknown) => void;

// ── State ───────────────────────────────────────────────────────────────────────────────────────

export interface ShellState {
  /** The last applied sequence; 0 before the first snapshot. */
  sequence: number;
  /** A snapshot has arrived (the lists are real, not just empty). */
  loaded: boolean;
  projects: Record<string, Project>;
  threads: Record<string, Thread>;
  requests: Record<string, RuntimeRequestSummary>;
}

export const EMPTY_SHELL: ShellState = { sequence: 0, loaded: false, projects: {}, threads: {}, requests: {} };

export interface ThreadState {
  threadId: string;
  sequence: number;
  /** True from attach until the stream's `synchronized` frame. */
  syncing: boolean;
  thread: Thread | null;
  runs: Record<string, Run>;
  items: Record<string, TurnItem>;
  requests: Record<string, RuntimeRequest>;
  queue: QueuedMessage[];
  /** Where older history starts (T05 history route); null when there is none. */
  historyCursor: string | null;
  /** The newest `dispatch.failed` this stream applied (T12's error banner); a snapshot clears it. */
  dispatchFailure: DispatchFailure | null;
}

/** A `dispatch.failed` notice as the composer reads it. */
export interface DispatchFailure {
  sequence: number;
  /** The `message.dispatch` command it answers, when it came from one (a start or a steer). */
  commandId?: string;
  reason: string;
  message?: string;
  textDelivered?: boolean;
  queuedId?: string;
  ts: number;
}

export function emptyThread(threadId: string): ThreadState {
  return {
    threadId,
    sequence: 0,
    syncing: true,
    thread: null,
    runs: {},
    items: {},
    requests: {},
    queue: [],
    historyCursor: null,
    dispatchFailure: null,
  };
}

const byId = <T extends { id: string }>(list: readonly T[]): Record<string, T> =>
  Object.fromEntries(list.map((x) => [x.id, x]));

export function summarize(request: RuntimeRequest): RuntimeRequestSummary {
  const { options: _options, steps: _steps, ...summary } = request;
  return summary;
}

export function shellFromSnapshot(snapshot: ShellSnapshot): ShellState {
  return {
    sequence: snapshot.sequence,
    loaded: true,
    projects: byId(snapshot.projects),
    threads: byId(snapshot.threads),
    requests: byId(snapshot.requests),
  };
}

export function threadFromSnapshot(snapshot: ThreadSnapshot, syncing: boolean): ThreadState {
  return {
    threadId: snapshot.thread.id,
    sequence: snapshot.sequence,
    syncing,
    thread: snapshot.thread,
    runs: byId(snapshot.runs),
    items: byId(snapshot.items),
    requests: byId(snapshot.requests),
    queue: [...snapshot.queue].sort((a, b) => a.position - b.position),
    historyCursor: snapshot.historyCursor,
    dispatchFailure: null,
  };
}

// ── Payload checks ──────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const hasId = (v: unknown): boolean => isObj(v) && isStr(v.id);

/** Minimal shape checks per type: enough that a reducer below cannot throw on the payload. */
const VALID: Record<string, (p: Record<string, unknown>, e: Record<string, unknown>) => boolean> = {
  "project.upserted": (p) => hasId(p.project),
  "project.closed": (p) => isStr(p.projectId) && isNum(p.closedAt),
  "thread.created": (p) => hasId(p.thread),
  "thread.updated": (p, e) => isStr(e.threadId) && isObj(p.patch) && isNum(p.at),
  "thread.shelf-changed": (p, e) => isStr(e.threadId) && isStr(p.shelf) && isNum(p.at),
  "thread.archived": (p, e) => isStr(e.threadId) && isStr(p.reason) && isNum(p.at),
  "thread.deleted": (p, e) => isStr(e.threadId) && isNum(p.at),
  "run.started": (p) => hasId(p.run) && isStr((p.run as Record<string, unknown>).threadId),
  "run.ended": (p) => isStr(p.runId) && isStr(p.status) && isNum(p.completedAt),
  "turn-item.updated": (p) => hasId(p.item) && isStr((p.item as Record<string, unknown>).type),
  "runtime-request.updated": (p) => hasId(p.request) && isStr((p.request as Record<string, unknown>).threadId),
  "queue.updated": (p, e) => isStr(e.threadId) && Array.isArray(p.messages) && p.messages.every(hasId),
  "command.rejected": () => true,
  "dispatch.failed": () => true,
  "thread.create.failed": () => true,
};

type Checked = { kind: "ok"; event: ThreadEvent } | { kind: "unknown" } | { kind: "malformed" };

function check(raw: unknown): Checked {
  if (!isObj(raw) || !isNum(raw.sequence) || !isStr(raw.type)) return { kind: "malformed" };
  const valid = VALID[raw.type];
  if (!valid) return { kind: "unknown" };
  if (!isObj(raw.payload) || !valid(raw.payload, raw)) return { kind: "malformed" };
  return { kind: "ok", event: raw as unknown as ThreadEvent };
}

// ── Thread projections (shared by both reducers) ────────────────────────────────────────────────

function patchThread(thread: Thread, event: ThreadEvent): Thread | null {
  switch (event.type) {
    case "thread.updated": {
      const { sessionRef, ...patch } = event.payload.patch;
      const next: Thread = { ...thread, ...patch, updatedAt: event.payload.at };
      if (sessionRef === null) delete next.sessionRef;
      else if (sessionRef !== undefined) next.sessionRef = sessionRef;
      return next;
    }
    case "thread.shelf-changed": {
      const { shelf, at } = event.payload;
      const next: Thread = { ...thread, shelf, updatedAt: at };
      delete next.snoozedUntil;
      delete next.pinnedAt;
      delete next.pinOrder;
      delete next.settledAt;
      delete next.archivedAt;
      delete next.archiveReason;
      if (shelf === "snoozed" && event.payload.snoozedUntil !== undefined) next.snoozedUntil = event.payload.snoozedUntil;
      if (shelf === "pinned") {
        next.pinnedAt = at;
        if (event.payload.pinOrder !== undefined) next.pinOrder = event.payload.pinOrder;
      }
      if (shelf === "settled") next.settledAt = at;
      return next;
    }
    case "thread.archived": {
      const next: Thread = {
        ...thread,
        shelf: "archived",
        archivedAt: event.payload.at,
        archiveReason: event.payload.reason,
        updatedAt: event.payload.at,
      };
      delete next.snoozedUntil;
      delete next.pinnedAt;
      delete next.pinOrder;
      delete next.settledAt;
      return next;
    }
    default:
      return null;
  }
}

// ── Shell ───────────────────────────────────────────────────────────────────────────────────────

export function applyShellEvent(state: ShellState, raw: unknown, onDrop?: OnDrop): ShellState {
  const checked = check(raw);
  if (checked.kind === "unknown") return state;
  if (checked.kind === "malformed") {
    onDrop?.("malformed", raw);
    return state;
  }
  const event = checked.event;
  if (event.sequence <= state.sequence) {
    onDrop?.("stale", raw);
    return state;
  }
  const at = (next: Partial<ShellState>): ShellState => ({ ...state, ...next, sequence: event.sequence });

  switch (event.type) {
    case "project.upserted": {
      const project = event.payload.project;
      return at({ projects: { ...state.projects, [project.id]: project } });
    }
    case "project.closed": {
      const project = state.projects[event.payload.projectId];
      if (!project) return state;
      return at({ projects: { ...state.projects, [project.id]: { ...project, closedAt: event.payload.closedAt } } });
    }
    case "thread.created": {
      const thread = event.payload.thread;
      return at({ threads: { ...state.threads, [thread.id]: thread } });
    }
    case "thread.updated":
    case "thread.shelf-changed":
    case "thread.archived": {
      const thread = event.threadId ? state.threads[event.threadId] : undefined;
      if (!thread) return state;
      const next = patchThread(thread, event);
      return next ? at({ threads: { ...state.threads, [thread.id]: next } }) : state;
    }
    case "thread.deleted": {
      // `thread.delete`: the thread and its request summaries leave the shell.
      const id = event.threadId!;
      const { [id]: _gone, ...threads } = state.threads;
      const requests = Object.fromEntries(Object.entries(state.requests).filter(([, r]) => r.threadId !== id));
      return at({ threads, requests });
    }
    case "runtime-request.updated": {
      const summary = summarize(event.payload.request);
      return at({ requests: { ...state.requests, [summary.id]: summary } });
    }
    default:
      // Runs, items, queue and notices belong to the thread stream.
      return state;
  }
}

// ── Thread ──────────────────────────────────────────────────────────────────────────────────────

function nextOrdinal(items: Record<string, TurnItem>): number {
  let max = -1;
  for (const item of Object.values(items)) if (item.ordinal > max) max = item.ordinal;
  return max + 1;
}

export function applyThreadEvent(state: ThreadState, raw: unknown, onDrop?: OnDrop): ThreadState {
  const checked = check(raw);
  if (checked.kind === "unknown") return state;
  if (checked.kind === "malformed") {
    onDrop?.("malformed", raw);
    return state;
  }
  const event = checked.event;
  if (event.sequence <= state.sequence) {
    onDrop?.("stale", raw);
    return state;
  }
  // A thread stream only carries its own thread; anything else is not ours to apply.
  if (event.threadId !== undefined && event.threadId !== state.threadId) return state;
  const at = (next: Partial<ThreadState>): ThreadState => ({ ...state, ...next, sequence: event.sequence });

  switch (event.type) {
    case "thread.created":
      return event.payload.thread.id === state.threadId ? at({ thread: event.payload.thread }) : state;
    case "thread.updated":
    case "thread.shelf-changed":
    case "thread.archived": {
      if (!state.thread) return state;
      const next = patchThread(state.thread, event);
      return next ? at({ thread: next }) : state;
    }
    case "run.started": {
      const run = event.payload.run;
      if (run.threadId !== state.threadId) return state;
      return at({ runs: { ...state.runs, [run.id]: run } });
    }
    case "run.ended": {
      const run = state.runs[event.payload.runId];
      if (!run) return state;
      const ended: Run = { ...run, status: event.payload.status, completedAt: event.payload.completedAt };
      return at({ runs: { ...state.runs, [run.id]: ended } });
    }
    case "turn-item.updated": {
      const incoming = event.payload.item;
      if (incoming.threadId !== state.threadId) return state;
      const prior = state.items[incoming.id];
      const ordinal = isNum(incoming.ordinal) ? incoming.ordinal : (prior?.ordinal ?? nextOrdinal(state.items));
      const item = { ...incoming, ordinal } as TurnItem;
      return at({ items: { ...state.items, [item.id]: item } });
    }
    case "runtime-request.updated": {
      const request = event.payload.request;
      if (request.threadId !== state.threadId) return state;
      return at({ requests: { ...state.requests, [request.id]: request } });
    }
    case "queue.updated":
      return at({ queue: [...event.payload.messages].sort((a, b) => a.position - b.position) });
    case "dispatch.failed": {
      const p = event.payload;
      if (typeof p.reason !== "string") return state;
      const failure: DispatchFailure = { sequence: event.sequence, reason: p.reason, ts: event.ts };
      if (event.commandId !== undefined) failure.commandId = event.commandId;
      if (typeof p.message === "string") failure.message = p.message;
      if (p.textDelivered === true) failure.textDelivered = true;
      if (typeof p.queuedId === "string") failure.queuedId = p.queuedId;
      return at({ dispatchFailure: failure });
    }
    default:
      // Notices (command.rejected, thread.create.failed) are surfaced by T14.
      return state;
  }
}

// ── History (T11) ───────────────────────────────────────────────────────────────────────────────

/**
 * Prepend an older page (`GET /api/v2/thread/:id/history`) to the open thread. Items and runs the
 * state already has win (they are newer: a live event may have updated them), so a page never
 * duplicates or rolls back a row. The cursor moves to the page's `nextCursor`; null means the start of
 * the thread. The sequence is untouched: history is not part of the event stream.
 */
export function mergeHistoryPage(state: ThreadState, page: HistoryPage): ThreadState {
  const runs = { ...state.runs };
  const items = { ...state.items };
  for (const { run, items: runItems } of page.runs) {
    if (run.threadId !== state.threadId) continue;
    runs[run.id] ??= run;
    for (const item of runItems) if (item.threadId === state.threadId) items[item.id] ??= item;
  }
  for (const item of page.loose) if (item.threadId === state.threadId) items[item.id] ??= item;
  return { ...state, runs, items, historyCursor: page.nextCursor };
}
