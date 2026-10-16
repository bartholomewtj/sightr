import { Database } from "bun:sqlite";
import { chmodSync, existsSync, renameSync, statSync } from "node:fs";

import type {
  HistoryPage,
  Project,
  QueuedMessage,
  Run,
  RuntimeRequest,
  RuntimeRequestSummary,
  ShellSnapshot,
  Thread,
  ThreadEvent,
  ThreadEventType,
  ThreadSnapshot,
  TurnItem,
} from "../../shared/v2/contracts.ts";
import type { AgentSessionRef } from "../journal/types.ts";
import {
  toWireEvent,
  toWireThread,
  type EventDraft,
  type ServerEventPayloads,
  type ServerThread,
  type StoredEvent,
} from "./events.ts";

// The v2 event store: one `bun:sqlite` file at `<stateDir>/threads.sqlite`.
//
// Every change is an event. `append` writes a batch of events and applies each one to the projection
// tables inside ONE `BEGIN IMMEDIATE` transaction, so an event and the state it implies commit together
// or not at all. `applyEvent` is the only code that writes a projection table from an event; `prune`
// is the one maintenance exception (it deletes old rows, it never changes one).

export const STORE_FILE = "threads.sqlite";

export const RETAIN_EVENTS_MS = 7 * 24 * 60 * 60 * 1000;
export const RETAIN_EVENTS_MIN = 50_000;
export const RETAIN_RECEIPTS_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ITEMS_PER_THREAD = 5_000;
export const RETAIN_ARCHIVED_MS = 90 * 24 * 60 * 60 * 1000;
export const SIZE_WARN_BYTES = 256 * 1024 * 1024;

/** The database was written by a newer bridge. The bridge leaves v2 off rather than guess. */
export class StoreTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`threads.sqlite is at schema version ${found}; this bridge knows up to ${supported}`);
    this.name = "StoreTooNewError";
  }
}

// ── Migrations ────────────────────────────────────────────────────────────────────────────────────

interface Migration {
  version: number;
  up(db: Database): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      db.run(`CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT,
        command_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        ts INTEGER NOT NULL
      )`);
      db.run(`CREATE INDEX events_thread ON events (thread_id, sequence)`);
      db.run(`CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        label_source TEXT NOT NULL,
        number INTEGER NOT NULL,
        worktree_of TEXT,
        ord INTEGER NOT NULL,
        status TEXT NOT NULL,
        closed_at INTEGER
      )`);
      db.run(`CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        pane_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects (id),
        title TEXT NOT NULL,
        title_source TEXT NOT NULL,
        harness TEXT NOT NULL,
        status TEXT NOT NULL,
        shelf TEXT NOT NULL,
        snoozed_until INTEGER,
        pinned_at INTEGER,
        pin_order INTEGER,
        settled_at INTEGER,
        unread_done INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER,
        archive_reason TEXT,
        session_ref_json TEXT,
        capabilities_json TEXT NOT NULL,
        permission_mode TEXT,
        model TEXT,
        UNIQUE (pane_id, terminal_id)
      )`);
      db.run(`CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        user_item_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      )`);
      db.run(`CREATE INDEX runs_thread ON runs (thread_id, ordinal)`);
      db.run(`CREATE TABLE turn_items (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
        run_id TEXT,
        position INTEGER NOT NULL,
        type TEXT NOT NULL,
        body_json TEXT NOT NULL,
        updated_sequence INTEGER NOT NULL
      )`);
      db.run(`CREATE INDEX turn_items_thread ON turn_items (thread_id, position)`);
      db.run(`CREATE TABLE runtime_requests (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        binding_hash TEXT NOT NULL,
        body_json TEXT NOT NULL,
        bound_text TEXT,
        updated_sequence INTEGER NOT NULL
      )`);
      db.run(`CREATE INDEX runtime_requests_thread ON runtime_requests (thread_id, status)`);
      db.run(`CREATE TABLE queued_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        position INTEGER NOT NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        held_reason TEXT,
        created_at INTEGER NOT NULL
      )`);
      db.run(`CREATE INDEX queued_messages_thread ON queued_messages (thread_id, position)`);
      db.run(`CREATE TABLE command_receipts (
        command_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        result_json TEXT,
        ts INTEGER NOT NULL
      )`);
      db.run(`CREATE TABLE journal_offsets (
        thread_id TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        offset INTEGER NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        session_key TEXT
      )`);
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

function schemaVersion(db: Database): number {
  const user = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  const row = db.query<{ v: number | null }, []>("SELECT max(version) AS v FROM migrations").get();
  return Math.max(user, row?.v ?? 0);
}

function migrate(db: Database, now: number): void {
  db.run(`CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const current = schemaVersion(db);
  if (current > SCHEMA_VERSION) throw new StoreTooNewError(current, SCHEMA_VERSION);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up(db);
      db.query("INSERT INTO migrations (version, applied_at) VALUES (?, ?)").run(m.version, now);
      db.run(`PRAGMA user_version = ${m.version}`);
    }).immediate();
  }
}

// ── Opening ───────────────────────────────────────────────────────────────────────────────────────

function openChecked(path: string, now: number, log: (msg: string) => void): Database {
  const open = () => new Database(path, { create: true, strict: true });
  if (path === ":memory:") return open();
  let db: Database | null = null;
  try {
    db = open();
    const check = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
    if (check?.quick_check !== "ok") throw new Error(`quick_check: ${check?.quick_check ?? "no answer"}`);
    return db;
  } catch (err) {
    db?.close();
    // The projection is rebuilt from the herd (T02); history and shelves are lost, which is the
    // accepted cost of a file SQLite cannot read.
    const aside = `${path}.corrupt-${now}`;
    renameSync(path, aside);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(path + suffix)) renameSync(path + suffix, aside + suffix);
    }
    log(`[threads] ${path} could not be opened (${(err as Error).message}); moved it to ${aside} and started empty`);
    return open();
  }
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  label: string;
  label_source: string;
  number: number;
  worktree_of: string | null;
  ord: number;
  status: string;
  closed_at: number | null;
}

interface ThreadRow {
  id: string;
  pane_id: string;
  terminal_id: string;
  project_id: string;
  title: string;
  title_source: string;
  harness: string;
  status: string;
  shelf: string;
  snoozed_until: number | null;
  pinned_at: number | null;
  pin_order: number | null;
  settled_at: number | null;
  unread_done: number;
  last_activity_at: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  archive_reason: string | null;
  session_ref_json: string | null;
  capabilities_json: string;
  permission_mode: string | null;
  model: string | null;
}

interface RunRow {
  id: string;
  thread_id: string;
  ordinal: number;
  user_item_id: string | null;
  status: string;
  started_at: number;
  completed_at: number | null;
}

interface QueuedRow {
  id: string;
  thread_id: string;
  text: string;
  attachments_json: string;
  position: number;
  mode: string;
  state: string;
  held_reason: string | null;
  created_at: number;
}

interface EventRow {
  sequence: number;
  thread_id: string | null;
  command_id: string | null;
  type: string;
  payload_json: string;
  ts: number;
}

function projectFromRow(r: ProjectRow): Project {
  return {
    id: r.id,
    label: r.label,
    labelSource: r.label_source as Project["labelSource"],
    number: r.number,
    ...(r.worktree_of !== null ? { worktreeOf: r.worktree_of } : {}),
    order: r.ord,
    status: r.status as Project["status"],
    ...(r.closed_at !== null ? { closedAt: r.closed_at } : {}),
  };
}

function projectParams(p: Project) {
  return {
    id: p.id,
    label: p.label,
    label_source: p.labelSource,
    number: p.number,
    worktree_of: p.worktreeOf ?? null,
    ord: p.order,
    status: p.status,
    closed_at: p.closedAt ?? null,
  };
}

function threadFromRow(r: ThreadRow): ServerThread {
  const t: ServerThread = {
    id: r.id,
    paneId: r.pane_id,
    terminalId: r.terminal_id,
    projectId: r.project_id,
    title: r.title,
    titleSource: r.title_source as Thread["titleSource"],
    harness: r.harness,
    status: r.status as Thread["status"],
    shelf: r.shelf as Thread["shelf"],
    unreadDone: r.unread_done !== 0,
    lastActivityAt: r.last_activity_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    capabilities: JSON.parse(r.capabilities_json),
  };
  if (r.snoozed_until !== null) t.snoozedUntil = r.snoozed_until;
  if (r.pinned_at !== null) t.pinnedAt = r.pinned_at;
  if (r.pin_order !== null) t.pinOrder = r.pin_order;
  if (r.settled_at !== null) t.settledAt = r.settled_at;
  if (r.archived_at !== null) t.archivedAt = r.archived_at;
  if (r.archive_reason !== null) t.archiveReason = r.archive_reason as Thread["archiveReason"] & string;
  if (r.session_ref_json !== null) t.sessionRef = JSON.parse(r.session_ref_json) as AgentSessionRef;
  if (r.permission_mode !== null) t.permissionMode = r.permission_mode;
  if (r.model !== null) t.model = r.model;
  return t;
}

function threadParams(t: ServerThread) {
  return {
    id: t.id,
    pane_id: t.paneId,
    terminal_id: t.terminalId,
    project_id: t.projectId,
    title: t.title,
    title_source: t.titleSource,
    harness: t.harness,
    status: t.status,
    shelf: t.shelf,
    snoozed_until: t.snoozedUntil ?? null,
    pinned_at: t.pinnedAt ?? null,
    pin_order: t.pinOrder ?? null,
    settled_at: t.settledAt ?? null,
    unread_done: t.unreadDone ? 1 : 0,
    last_activity_at: t.lastActivityAt,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    archived_at: t.archivedAt ?? null,
    archive_reason: t.archiveReason ?? null,
    session_ref_json: t.sessionRef ? JSON.stringify(t.sessionRef) : null,
    capabilities_json: JSON.stringify(t.capabilities),
    permission_mode: t.permissionMode ?? null,
    model: t.model ?? null,
  };
}

const THREAD_COLUMNS = Object.keys(threadParams({} as ServerThread));
const INSERT_THREAD = `INSERT INTO threads (${THREAD_COLUMNS.join(", ")}) VALUES (${THREAD_COLUMNS.map((c) => "$" + c).join(", ")})`;
const UPDATE_THREAD = `UPDATE threads SET ${THREAD_COLUMNS.filter((c) => c !== "id").map((c) => `${c} = $${c}`).join(", ")} WHERE id = $id`;
const PROJECT_COLUMNS = Object.keys(projectParams({} as Project));
const UPSERT_PROJECT =
  `INSERT INTO projects (${PROJECT_COLUMNS.join(", ")}) VALUES (${PROJECT_COLUMNS.map((c) => "$" + c).join(", ")}) ` +
  `ON CONFLICT (id) DO UPDATE SET ${PROJECT_COLUMNS.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}`;

function runFromRow(r: RunRow): Run {
  return {
    id: r.id,
    threadId: r.thread_id,
    ordinal: r.ordinal,
    ...(r.user_item_id !== null ? { userItemId: r.user_item_id } : {}),
    status: r.status as Run["status"],
    startedAt: r.started_at,
    ...(r.completed_at !== null ? { completedAt: r.completed_at } : {}),
  };
}

function queuedFromRow(r: QueuedRow): QueuedMessage {
  return {
    id: r.id,
    threadId: r.thread_id,
    text: r.text,
    attachments: JSON.parse(r.attachments_json),
    position: r.position,
    mode: r.mode as QueuedMessage["mode"],
    state: r.state as QueuedMessage["state"],
    ...(r.held_reason !== null ? { heldReason: r.held_reason } : {}),
    createdAt: r.created_at,
  };
}

function eventFromRow(r: EventRow): StoredEvent {
  return {
    sequence: r.sequence,
    ...(r.thread_id !== null ? { threadId: r.thread_id } : {}),
    ...(r.command_id !== null ? { commandId: r.command_id } : {}),
    type: r.type as ThreadEventType,
    payload: JSON.parse(r.payload_json),
    ts: r.ts,
  } as StoredEvent;
}

function summary(request: RuntimeRequest): RuntimeRequestSummary {
  const { options: _options, steps: _steps, ...rest } = request;
  return rest;
}

function requireThreadId(event: StoredEvent): string {
  if (!event.threadId) throw new Error(`${event.type} needs a threadId`);
  return event.threadId;
}

// ── Projection ────────────────────────────────────────────────────────────────────────────────────

/**
 * Before an event is written: give a new turn item the next ordinal in its thread, so the stored
 * event (and every client that sees it) carries the position the projection uses.
 */
function prepare(tx: Database, draft: EventDraft): EventDraft {
  if (draft.type !== "turn-item.updated" || draft.payload.item.ordinal !== undefined) return draft;
  const item = draft.payload.item;
  const existing = tx.query<{ position: number }, [string]>("SELECT position FROM turn_items WHERE id = ?").get(item.id);
  const ordinal =
    existing?.position ??
    (tx.query<{ p: number | null }, [string]>("SELECT max(position) AS p FROM turn_items WHERE thread_id = ?").get(item.threadId)
      ?.p ?? -1) + 1;
  return { ...draft, payload: { item: { ...item, ordinal } } } as EventDraft;
}

function loadThread(tx: Database, id: string): ServerThread {
  const row = tx.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(id);
  if (!row) throw new Error(`no thread ${id}`);
  return threadFromRow(row);
}

function saveThread(tx: Database, thread: ServerThread): void {
  tx.query(UPDATE_THREAD).run(threadParams(thread));
}

/** The only code that writes a projection table from an event. A throw rolls back the whole batch. */
export function applyEvent(tx: Database, event: StoredEvent): void {
  switch (event.type) {
    case "project.upserted":
      tx.query(UPSERT_PROJECT).run(projectParams(event.payload.project));
      return;
    case "project.closed": {
      const r = tx.query("UPDATE projects SET closed_at = ? WHERE id = ?").run(event.payload.closedAt, event.payload.projectId);
      if (r.changes === 0) throw new Error(`no project ${event.payload.projectId}`);
      return;
    }
    case "thread.created":
      tx.query(INSERT_THREAD).run(threadParams(event.payload.thread));
      return;
    case "thread.updated": {
      const thread = loadThread(tx, requireThreadId(event));
      const { sessionRef, ...patch } = event.payload.patch;
      const next: ServerThread = { ...thread, ...patch, updatedAt: event.payload.at };
      if (sessionRef === null) delete next.sessionRef;
      else if (sessionRef !== undefined) next.sessionRef = sessionRef;
      saveThread(tx, next);
      return;
    }
    case "thread.shelf-changed": {
      const thread = loadThread(tx, requireThreadId(event));
      const { shelf, at } = event.payload;
      const next: ServerThread = { ...thread, shelf, updatedAt: at };
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
      saveThread(tx, next);
      return;
    }
    case "thread.archived": {
      const thread = loadThread(tx, requireThreadId(event));
      const next: ServerThread = {
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
      saveThread(tx, next);
      return;
    }
    case "run.started": {
      const run = event.payload.run;
      tx.query(
        "INSERT INTO runs (id, thread_id, ordinal, user_item_id, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(run.id, run.threadId, run.ordinal, run.userItemId ?? null, run.status, run.startedAt, run.completedAt ?? null);
      return;
    }
    case "run.ended": {
      const r = tx
        .query("UPDATE runs SET status = ?, completed_at = ? WHERE id = ?")
        .run(event.payload.status, event.payload.completedAt, event.payload.runId);
      if (r.changes === 0) throw new Error(`no run ${event.payload.runId}`);
      return;
    }
    case "run.updated": {
      const run = event.payload.run;
      const r = tx
        .query("UPDATE runs SET user_item_id = ?, status = ?, completed_at = ? WHERE id = ?")
        .run(run.userItemId ?? null, run.status, run.completedAt ?? null, run.id);
      if (r.changes === 0) throw new Error(`no run ${run.id}`);
      return;
    }
    case "turn-item.updated": {
      const item = event.payload.item as TurnItem;
      tx.query(
        `INSERT INTO turn_items (id, thread_id, run_id, position, type, body_json, updated_sequence)
         VALUES ($id, $thread_id, $run_id, $position, $type, $body_json, $updated_sequence)
         ON CONFLICT (id) DO UPDATE SET thread_id = excluded.thread_id, run_id = excluded.run_id,
           position = excluded.position, type = excluded.type, body_json = excluded.body_json,
           updated_sequence = excluded.updated_sequence`,
      ).run({
        id: item.id,
        thread_id: item.threadId,
        run_id: item.runId,
        position: item.ordinal,
        type: item.type,
        body_json: JSON.stringify(item),
        updated_sequence: event.sequence,
      });
      return;
    }
    case "runtime-request.updated": {
      const { request, boundText } = event.payload;
      tx.query(
        `INSERT INTO runtime_requests (id, thread_id, kind, status, binding_hash, body_json, bound_text, updated_sequence)
         VALUES ($id, $thread_id, $kind, $status, $binding_hash, $body_json, $bound_text, $updated_sequence)
         ON CONFLICT (id) DO UPDATE SET thread_id = excluded.thread_id, kind = excluded.kind,
           status = excluded.status, binding_hash = excluded.binding_hash, body_json = excluded.body_json,
           bound_text = coalesce(excluded.bound_text, bound_text), updated_sequence = excluded.updated_sequence`,
      ).run({
        id: request.id,
        thread_id: request.threadId,
        kind: request.kind,
        status: request.status,
        binding_hash: request.bindingHash,
        body_json: JSON.stringify(request),
        bound_text: boundText ?? null,
        updated_sequence: event.sequence,
      });
      return;
    }
    case "queue.updated": {
      const threadId = requireThreadId(event);
      tx.query("DELETE FROM queued_messages WHERE thread_id = ?").run(threadId);
      const insert = tx.query(
        `INSERT INTO queued_messages (id, thread_id, text, attachments_json, position, mode, state, held_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of event.payload.messages) {
        insert.run(m.id, threadId, m.text, JSON.stringify(m.attachments), m.position, m.mode, m.state, m.heldReason ?? null, m.createdAt);
      }
      return;
    }
    case "command.rejected":
    case "dispatch.failed":
    case "thread.create.failed":
      // Notices for clients; no projection.
      return;
    default: {
      const never: never = event;
      throw new Error(`unknown event ${(never as StoredEvent).type}`);
    }
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────────────────────────

export interface JournalOffset {
  threadId: string;
  path: string;
  offset: number;
  size: number;
  mtimeMs: number;
  sessionKey: string | null;
}

export interface CommandReceipt {
  commandId: string;
  type: string;
  /** The last sequence the command's batch wrote (or the store's last sequence if it wrote none). */
  sequence: number;
  result: unknown;
  ts: number;
}

export interface AppendOptions {
  commandId?: string;
  /** Write a command receipt in the same transaction. A duplicate `commandId` fails the whole batch. */
  receipt?: { type: string; result?: unknown };
  /** Journal offsets saved with the events they produced (T03). */
  offsets?: JournalOffset[];
}

export interface EventsAfterOptions {
  threadId?: string;
  /** Only these event types. */
  types?: readonly ThreadEventType[];
  limit?: number;
}

/** How many loose items (no run) one history page holds when no run is older than the cursor. */
export const LOOSE_PAGE_ITEMS = 200;

/** The opaque history cursor: base64 of an item position. */
export function encodeHistoryCursor(position: number): string {
  return btoa(String(position));
}

/** The position a history cursor names, or null for anything this bridge did not make. */
export function decodeHistoryCursor(cursor: string): number | null {
  let raw: string;
  try {
    raw = atob(cursor);
  } catch {
    return null;
  }
  if (!/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

export interface PruneResult {
  events: number;
  receipts: number;
  items: number;
  threads: number;
}

export interface StoreOptions {
  now?: () => number;
  newId?: () => string;
  log?: (msg: string) => void;
}

export type CommittedListener = (events: ThreadEvent[]) => void;

export interface ThreadStore {
  readonly path: string;
  /** The clock and id source the store was opened with, for building `decide()` contexts. */
  readonly now: () => number;
  readonly newId: () => string;
  append(drafts: EventDraft[], opts?: AppendOptions): { first: number; last: number };
  onCommitted(listener: CommittedListener): () => void;
  snapshotShell(): ShellSnapshot;
  snapshotThread(id: string, opts?: { runs?: number }): ThreadSnapshot | null;
  /** Client-form events after `sequence`, oldest first. */
  eventsAfter(sequence: number, opts?: EventsAfterOptions): ThreadEvent[];
  /** Server-form events (bound text, path refs) for replay and tests. Never send these to a client. */
  storedEventsAfter(sequence: number, opts?: EventsAfterOptions): StoredEvent[];
  receipt(commandId: string): CommandReceipt | null;
  lastSequence(): number;
  /** The oldest sequence `prune` kept, or 0 when nothing has been pruned. */
  minSequence(): number;
  getThread(id: string): ServerThread | null;
  getProject(id: string): Project | null;
  listThreads(): ServerThread[];
  listProjects(): Project[];
  /** The highest `pinOrder` among pinned threads, or 0. */
  maxPinOrder(): number;
  /** Every run still `running`, oldest first (T02 ends them when a pane goes). */
  openRuns(): Run[];
  /** Every `pending` runtime request, with options (T02 reads the kind and expires them). */
  pendingRequests(): RuntimeRequest[];
  /** One runtime request by id, with options (T04 respond). */
  getRequest(id: string): RuntimeRequest | null;
  /** The screen text a request was bound to. Server-side only; never send it to a client. */
  requestBoundText(id: string): string | null;
  getRun(id: string): Run | null;
  /** A thread's newest `limit` runs (default all), oldest first. */
  listRuns(threadId: string, limit?: number): Run[];
  /** The thread's newest run still `running`, if any. */
  openRun(threadId: string): Run | null;
  getTurnItem(id: string): TurnItem | null;
  /** A thread's newest `limit` items, oldest first. */
  recentItems(threadId: string, limit: number): TurnItem[];
  /** The items attributed to `runId`, in position order. */
  itemsForRun(runId: string): TurnItem[];
  /**
   * One page of a thread's older history: the newest `limit` runs with items before position
   * `before` (all positions when null), every item from the first of those on, and the cursor for the
   * page before it. Once no older item belongs to a run, the page also takes the loose items below it
   * (`LOOSE_PAGE_ITEMS` at a time).
   */
  historyPage(threadId: string, before: number | null, limit: number): HistoryPage;
  /** A thread's queued messages by position, or every thread's (by thread, then position) with no id (T06). */
  listQueued(threadId?: string): QueuedMessage[];
  /** One queued message by id (T06). */
  getQueued(id: string): QueuedMessage | null;
  offsets: {
    get(threadId: string): JournalOffset | null;
    set(offset: JournalOffset): void;
  };
  prune(now: number): PruneResult;
  close(): void;
}

/**
 * Open (creating and migrating) the store at `path`. `":memory:"` is allowed for tests.
 * Throws `StoreTooNewError` for a database a newer bridge wrote. A file SQLite cannot read is moved
 * aside to `<path>.corrupt-<ts>` and replaced with an empty one.
 */
export function openThreadStore(path: string, opts: StoreOptions = {}): ThreadStore {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const log = opts.log ?? ((msg: string) => console.warn(msg));

  const db = openChecked(path, now(), log);
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 2000");
    migrate(db, now());
  } catch (err) {
    db.close();
    throw err;
  }
  if (path !== ":memory:" && process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort; the directory is already owner-only.
    }
  }

  const listeners = new Set<CommittedListener>();

  const lastSequence = (): number =>
    db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get()?.seq ?? 0;

  const writeOffset = db.query(
    `INSERT INTO journal_offsets (thread_id, path, offset, size, mtime_ms, session_key)
     VALUES ($thread_id, $path, $offset, $size, $mtime_ms, $session_key)
     ON CONFLICT (thread_id) DO UPDATE SET path = excluded.path, offset = excluded.offset, size = excluded.size,
       mtime_ms = excluded.mtime_ms, session_key = excluded.session_key`,
  );
  const setOffset = (o: JournalOffset) =>
    writeOffset.run({
      thread_id: o.threadId,
      path: o.path,
      offset: o.offset,
      size: o.size,
      mtime_ms: o.mtimeMs,
      session_key: o.sessionKey,
    });

  const appendTx = db.transaction((drafts: EventDraft[], options: AppendOptions, ts: number): StoredEvent[] => {
    const insert = db.query<{ sequence: number }, [string | null, string | null, string, string, number]>(
      "INSERT INTO events (thread_id, command_id, type, payload_json, ts) VALUES (?, ?, ?, ?, ?) RETURNING sequence",
    );
    const written: StoredEvent[] = [];
    for (const raw of drafts) {
      const draft = prepare(db, raw);
      const row = insert.get(draft.threadId ?? null, options.commandId ?? null, draft.type, JSON.stringify(draft.payload), ts);
      if (!row) throw new Error("event insert returned no sequence");
      const event = {
        sequence: row.sequence,
        ...(draft.threadId !== undefined ? { threadId: draft.threadId } : {}),
        ...(options.commandId !== undefined ? { commandId: options.commandId } : {}),
        type: draft.type,
        payload: draft.payload,
        ts,
      } as StoredEvent;
      applyEvent(db, event);
      written.push(event);
    }
    if (options.receipt) {
      if (!options.commandId) throw new Error("a receipt needs a commandId");
      const sequence = written.at(-1)?.sequence ?? lastSequence();
      db.query("INSERT INTO command_receipts (command_id, type, sequence, result_json, ts) VALUES (?, ?, ?, ?, ?)").run(
        options.commandId,
        options.receipt.type,
        sequence,
        options.receipt.result === undefined ? null : JSON.stringify(options.receipt.result),
        ts,
      );
    }
    for (const o of options.offsets ?? []) setOffset(o);
    return written;
  });

  const selectEvents = (sequence: number, o: EventsAfterOptions = {}): StoredEvent[] => {
    const where = ["sequence > ?"];
    const params: (string | number)[] = [sequence];
    if (o.threadId !== undefined) {
      where.push("thread_id = ?");
      params.push(o.threadId);
    }
    if (o.types !== undefined) {
      if (o.types.length === 0) return [];
      where.push(`type IN (${o.types.map(() => "?").join(", ")})`);
      params.push(...o.types);
    }
    params.push(o.limit ?? -1);
    return db
      .query<EventRow, (string | number)[]>(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY sequence LIMIT ?`)
      .all(...params)
      .map(eventFromRow);
  };

  const requestsFor = (threadId: string, pendingOnly: boolean): RuntimeRequest[] =>
    db
      .query<{ body_json: string }, [string]>(
        `SELECT body_json FROM runtime_requests WHERE thread_id = ? ${pendingOnly ? "AND status = 'pending'" : ""} ORDER BY updated_sequence`,
      )
      .all(threadId)
      .map((r) => JSON.parse(r.body_json) as RuntimeRequest);

  const store: ThreadStore = {
    path,
    now,
    newId,

    append(drafts, options = {}) {
      const written = appendTx.immediate(drafts, options, now());
      const last = written.at(-1)?.sequence ?? lastSequence();
      const first = written[0]?.sequence ?? last;
      if (written.length > 0 && listeners.size > 0) {
        const wire = written.map(toWireEvent);
        for (const listener of listeners) {
          try {
            listener(wire);
          } catch (err) {
            log(`[threads] onCommitted listener threw: ${(err as Error).message}`);
          }
        }
      }
      return { first, last };
    },

    onCommitted(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    snapshotShell() {
      return db.transaction((): ShellSnapshot => ({
        sequence: lastSequence(),
        projects: store.listProjects(),
        threads: store.listThreads().map(toWireThread),
        requests: db
          .query<{ body_json: string }, []>(
            "SELECT body_json FROM runtime_requests WHERE status = 'pending' ORDER BY updated_sequence",
          )
          .all()
          .map((r) => summary(JSON.parse(r.body_json) as RuntimeRequest)),
      }))();
    },

    snapshotThread(id, o = {}) {
      return db.transaction((): ThreadSnapshot | null => {
        const thread = store.getThread(id);
        if (!thread) return null;
        const runs = db
          .query<RunRow, [string, number]>("SELECT * FROM runs WHERE thread_id = ? ORDER BY ordinal DESC LIMIT ?")
          .all(id, o.runs ?? 10)
          .reverse()
          .map(runFromRow);
        // The window starts at the earliest item of the returned runs; loose items (no run) inside it
        // come too. With no runs, or runs with no items yet, every item is returned.
        let from = 0;
        if (runs.length > 0) {
          const ids = runs.map((r) => r.id);
          from =
            db
              .query<{ p: number | null }, string[]>(
                `SELECT min(position) AS p FROM turn_items WHERE run_id IN (${ids.map(() => "?").join(", ")})`,
              )
              .get(...ids)?.p ?? 0;
        }
        const items = db
          .query<{ body_json: string }, [string, number]>(
            "SELECT body_json FROM turn_items WHERE thread_id = ? AND position >= ? ORDER BY position",
          )
          .all(id, from)
          .map((r) => JSON.parse(r.body_json) as TurnItem);
        const older = db
          .query<{ n: number }, [string, number]>("SELECT count(*) AS n FROM turn_items WHERE thread_id = ? AND position < ?")
          .get(id, from);
        return {
          sequence: lastSequence(),
          thread: toWireThread(thread),
          runs,
          items,
          requests: requestsFor(id, true),
          queue: db
            .query<QueuedRow, [string]>("SELECT * FROM queued_messages WHERE thread_id = ? ORDER BY position")
            .all(id)
            .map(queuedFromRow),
          historyCursor: (older?.n ?? 0) > 0 ? encodeHistoryCursor(from) : null,
        };
      })();
    },

    eventsAfter(sequence, o) {
      return selectEvents(sequence, o).map(toWireEvent);
    },

    storedEventsAfter: selectEvents,

    receipt(commandId) {
      const row = db
        .query<{ command_id: string; type: string; sequence: number; result_json: string | null; ts: number }, [string]>(
          "SELECT * FROM command_receipts WHERE command_id = ?",
        )
        .get(commandId);
      if (!row) return null;
      return {
        commandId: row.command_id,
        type: row.type,
        sequence: row.sequence,
        result: row.result_json === null ? undefined : JSON.parse(row.result_json),
        ts: row.ts,
      };
    },

    lastSequence,

    minSequence() {
      const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'min_sequence'").get();
      return row ? Number(row.value) : 0;
    },

    getThread(id) {
      const row = db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(id);
      return row ? threadFromRow(row) : null;
    },

    getProject(id) {
      const row = db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
      return row ? projectFromRow(row) : null;
    },

    listThreads() {
      return db.query<ThreadRow, []>("SELECT * FROM threads ORDER BY created_at, id").all().map(threadFromRow);
    },

    listProjects() {
      return db.query<ProjectRow, []>("SELECT * FROM projects ORDER BY ord, id").all().map(projectFromRow);
    },

    maxPinOrder() {
      return db.query<{ m: number | null }, []>("SELECT max(pin_order) AS m FROM threads WHERE shelf = 'pinned'").get()?.m ?? 0;
    },

    openRuns() {
      return db
        .query<RunRow, []>("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at, id")
        .all()
        .map(runFromRow);
    },

    pendingRequests() {
      return db
        .query<{ body_json: string }, []>("SELECT body_json FROM runtime_requests WHERE status = 'pending' ORDER BY updated_sequence")
        .all()
        .map((r) => JSON.parse(r.body_json) as RuntimeRequest);
    },

    getRequest(id) {
      const row = db.query<{ body_json: string }, [string]>("SELECT body_json FROM runtime_requests WHERE id = ?").get(id);
      return row ? (JSON.parse(row.body_json) as RuntimeRequest) : null;
    },

    requestBoundText(id) {
      return (
        db.query<{ bound_text: string | null }, [string]>("SELECT bound_text FROM runtime_requests WHERE id = ?").get(id)
          ?.bound_text ?? null
      );
    },

    getRun(id) {
      const row = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
      return row ? runFromRow(row) : null;
    },

    listRuns(threadId, limit = -1) {
      return db
        .query<RunRow, [string, number]>("SELECT * FROM runs WHERE thread_id = ? ORDER BY ordinal DESC LIMIT ?")
        .all(threadId, limit)
        .reverse()
        .map(runFromRow);
    },

    openRun(threadId) {
      const row = db
        .query<RunRow, [string]>("SELECT * FROM runs WHERE thread_id = ? AND status = 'running' ORDER BY ordinal DESC LIMIT 1")
        .get(threadId);
      return row ? runFromRow(row) : null;
    },

    getTurnItem(id) {
      const row = db.query<{ body_json: string }, [string]>("SELECT body_json FROM turn_items WHERE id = ?").get(id);
      return row ? (JSON.parse(row.body_json) as TurnItem) : null;
    },

    recentItems(threadId, limit) {
      return db
        .query<{ body_json: string }, [string, number]>(
          "SELECT body_json FROM turn_items WHERE thread_id = ? ORDER BY position DESC LIMIT ?",
        )
        .all(threadId, limit)
        .reverse()
        .map((r) => JSON.parse(r.body_json) as TurnItem);
    },

    itemsForRun(runId) {
      return db
        .query<{ body_json: string }, [string]>("SELECT body_json FROM turn_items WHERE run_id = ? ORDER BY position")
        .all(runId)
        .map((r) => JSON.parse(r.body_json) as TurnItem);
    },

    historyPage(threadId, before, limit) {
      return db.transaction((): HistoryPage => {
        const below = before ?? Number.MAX_SAFE_INTEGER;
        const runIds = db
          .query<{ run_id: string }, [string, number, number]>(
            `SELECT run_id FROM turn_items WHERE thread_id = ? AND position < ? AND run_id IS NOT NULL
             GROUP BY run_id ORDER BY max(position) DESC LIMIT ?`,
          )
          .all(threadId, below, limit)
          .map((r) => r.run_id);
        let from =
          runIds.length > 0
            ? (db
                .query<{ p: number | null }, (string | number)[]>(
                  `SELECT min(position) AS p FROM turn_items WHERE position < ? AND run_id IN (${runIds.map(() => "?").join(", ")})`,
                )
                .get(below, ...runIds)?.p ?? below)
            : below;
        const olderRunItem = db
          .query<{ n: number }, [string, number]>(
            "SELECT count(*) AS n FROM turn_items WHERE thread_id = ? AND position < ? AND run_id IS NOT NULL",
          )
          .get(threadId, from);
        if ((olderRunItem?.n ?? 0) === 0) {
          // Nothing but loose items is older: take them into this page (the newest LOOSE_PAGE_ITEMS).
          from =
            db
              .query<{ p: number | null }, [string, number, number]>(
                `SELECT min(position) AS p FROM (SELECT position FROM turn_items WHERE thread_id = ? AND position < ?
                 ORDER BY position DESC LIMIT ?)`,
              )
              .get(threadId, from, LOOSE_PAGE_ITEMS)?.p ?? from;
        }
        const items = db
          .query<{ body_json: string; run_id: string | null }, [string, number, number]>(
            "SELECT body_json, run_id FROM turn_items WHERE thread_id = ? AND position >= ? AND position < ? ORDER BY position",
          )
          .all(threadId, from, below);
        const byRun = new Map<string, TurnItem[]>();
        const loose: TurnItem[] = [];
        for (const row of items) {
          const item = JSON.parse(row.body_json) as TurnItem;
          const run = row.run_id === null ? null : store.getRun(row.run_id);
          if (!run) {
            loose.push(item);
            continue;
          }
          const list = byRun.get(run.id);
          if (list) list.push(item);
          else byRun.set(run.id, [item]);
        }
        const runs = [...byRun.entries()]
          .map(([id, list]) => ({ run: store.getRun(id)!, items: list }))
          .sort((a, b) => a.run.ordinal - b.run.ordinal);
        const older = db
          .query<{ n: number }, [string, number]>("SELECT count(*) AS n FROM turn_items WHERE thread_id = ? AND position < ?")
          .get(threadId, from);
        return { runs, loose, nextCursor: (older?.n ?? 0) > 0 ? encodeHistoryCursor(from) : null };
      })();
    },

    listQueued(threadId) {
      const rows =
        threadId === undefined
          ? db.query<QueuedRow, []>("SELECT * FROM queued_messages ORDER BY thread_id, position, created_at").all()
          : db
              .query<QueuedRow, [string]>("SELECT * FROM queued_messages WHERE thread_id = ? ORDER BY position, created_at")
              .all(threadId);
      return rows.map(queuedFromRow);
    },

    getQueued(id) {
      const row = db.query<QueuedRow, [string]>("SELECT * FROM queued_messages WHERE id = ?").get(id);
      return row ? queuedFromRow(row) : null;
    },

    offsets: {
      get(threadId) {
        const row = db
          .query<
            { thread_id: string; path: string; offset: number; size: number; mtime_ms: number; session_key: string | null },
            [string]
          >("SELECT * FROM journal_offsets WHERE thread_id = ?")
          .get(threadId);
        return row
          ? {
              threadId: row.thread_id,
              path: row.path,
              offset: row.offset,
              size: row.size,
              mtimeMs: row.mtime_ms,
              sessionKey: row.session_key,
            }
          : null;
      },
      set(o) {
        setOffset(o);
      },
    },

    prune(at) {
      const result = db.transaction((): PruneResult => {
        const last = lastSequence();
        const events = db
          .query("DELETE FROM events WHERE ts < ? AND sequence <= ?")
          .run(at - RETAIN_EVENTS_MS, last - RETAIN_EVENTS_MIN).changes;
        const oldest = db.query<{ s: number | null }, []>("SELECT min(sequence) AS s FROM events").get()?.s ?? last + 1;
        if (events > 0 || store.minSequence() > 0) {
          db.query("INSERT INTO meta (key, value) VALUES ('min_sequence', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
            String(oldest),
          );
        }
        const receipts = db.query("DELETE FROM command_receipts WHERE ts < ?").run(at - RETAIN_RECEIPTS_MS).changes;
        let items = 0;
        const crowded = db
          .query<{ thread_id: string; n: number }, [number]>(
            "SELECT thread_id, count(*) AS n FROM turn_items GROUP BY thread_id HAVING n > ?",
          )
          .all(MAX_ITEMS_PER_THREAD);
        for (const { thread_id, n } of crowded) {
          items += db
            .query(
              `DELETE FROM turn_items WHERE id IN (
                 SELECT id FROM turn_items WHERE thread_id = ?
                   AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM runs WHERE status = 'running'))
                 ORDER BY position LIMIT ?)`,
            )
            .run(thread_id, n - MAX_ITEMS_PER_THREAD).changes;
        }
        const threads = db
          .query("DELETE FROM threads WHERE shelf = 'archived' AND archived_at < ?")
          .run(at - RETAIN_ARCHIVED_MS).changes;
        return { events, receipts, items, threads };
      }).immediate();
      if (path !== ":memory:") {
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        try {
          const size = statSync(path).size;
          if (size > SIZE_WARN_BYTES) {
            log(`[threads] ${path} is ${Math.round(size / 1024 / 1024)} MB after pruning (warning above 256 MB)`);
          }
        } catch {
          // A missing file here is not worth failing a prune over.
        }
      }
      return result;
    },

    close() {
      listeners.clear();
      db.close();
    },
  };
  return store;
}

export type { EventDraft, ServerEventPayloads, ShellSnapshot, StoredEvent, ThreadSnapshot };
