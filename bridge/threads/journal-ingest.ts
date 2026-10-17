import type { Run, RunStatus, ThreadStatus, ThreadTokenUsageSnapshot, TurnItem } from "../../shared/v2/contracts.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { adapterFor } from "../journal/registry.ts";
import type { TranscriptStore } from "../journal/store.ts";
import type { AgentSessionRef, JournalAdapter, TranscriptEntry } from "../journal/types.ts";
import { paneReadMatches, resolveSessionRef } from "../pane-read-routes.ts";
import type { AgentView, StateEngine } from "../state-engine.ts";
import { SHELL_HARNESS } from "./capabilities.ts";
import type { EventDraft, ServerThread, TurnItemDraft } from "./events.ts";
import type { JournalOffset, ThreadStore } from "./store.ts";
import { entryItemIds, entryItems, isUserSpeech, parseEntryTime, sameItemBody } from "./turn-items.ts";

// Journal ingest (T03): each thread's harness log becomes turn items, and its herdr status becomes
// runs.
//
// Items. A thread is read while it is `working` or a client watches it (T05's `watchers`), every
// `ACTIVE_POLL_MS`; an idle, unwatched thread is not read at all. Each read is incremental
// (`TranscriptStore.readSince`) and its byte offset is saved in the same transaction as the events it
// produced, so a restart resumes where it was. Items are upserted by a stable id and only a changed
// body is written, so re-reading the same bytes appends nothing.
//
// Runs. Boundaries come from the status the herd ingest (T02) publishes, never from the log: the
// status turning `working` opens a run, `approval`/`input` keep it open, and `done`/`idle`/`failed`
// end it (after one last read, so the run's final message lands inside it). Archive ends a run
// `interrupted`, and so does a run T06 marked with `markInterrupted` when it sent the interrupt key.
//
// Harnesses with no journal adapter (Agy; Codex until T16) get one `screen` item per run instead: the
// visible screen, read once when the run ends.

/** How often an active thread's journal is read. */
export const ACTIVE_POLL_MS = 1_000;
/** The first ever read of a thread keeps only this many of the log's newest entries. */
export const BACKFILL_ENTRIES = 50;
/** A user message written up to this long before a run's start opens that run. */
export const USER_MESSAGE_LEAD_MS = 5_000;
/** An item written this long after its run ended still belongs to it (clock and poll skew). */
export const RUN_END_SLACK_MS = 2_000;
/** One logged warning per thread per this long. */
export const WARN_EVERY_MS = 10 * 60_000;
/** How long a resolved session ref is reused before the pane is asked again. */
export const REF_TTL_MS = 5_000;
export const SCREEN_LINES = 60;
export const SCREEN_MAX_BYTES = 8 * 1024;

/** Statuses that keep an open run open (waiting on the operator is still the same run). */
const KEEPS_RUN: ReadonlySet<ThreadStatus> = new Set(["working", "approval", "input", "starting"]);

// ── Watchers ─────────────────────────────────────────────────────────────────────────────────────

/** Who is looking at which thread. T05's thread stream adds on attach and removes on detach. */
export interface ThreadWatchers {
  add(threadId: string): void;
  remove(threadId: string): void;
  count(threadId: string): number;
  /** Called when a thread's count changes. */
  onChange(listener: (threadId: string) => void): () => void;
}

export function createThreadWatchers(): ThreadWatchers {
  const counts = new Map<string, number>();
  const listeners = new Set<(threadId: string) => void>();
  const emit = (threadId: string) => {
    for (const l of listeners) l(threadId);
  };
  return {
    add(threadId) {
      counts.set(threadId, (counts.get(threadId) ?? 0) + 1);
      emit(threadId);
    },
    remove(threadId) {
      const n = (counts.get(threadId) ?? 0) - 1;
      if (n > 0) counts.set(threadId, n);
      else counts.delete(threadId);
      emit(threadId);
    },
    count: (threadId) => counts.get(threadId) ?? 0,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────

/** The journal_offsets key for a ref. Server-side only: a path ref holds a path. */
export function sessionKey(ref: AgentSessionRef): string {
  return `${ref.kind}:${ref.value}`;
}

function refFromKey(key: string): AgentSessionRef | null {
  const i = key.indexOf(":");
  const kind = key.slice(0, i);
  return kind === "id" || kind === "path" ? { kind, value: key.slice(i + 1) } : null;
}

/** How a session is named on the wire: the id, or a path ref's file name (a path never leaves the bridge). */
export function sessionLabel(key: string): string {
  const ref = refFromKey(key);
  if (ref === null) return key;
  if (ref.kind === "id") return ref.value;
  return (ref.value.split(/[\\/]/).pop() ?? "").replace(/\.jsonl$/i, "");
}

/** The run an item written at `ts` belongs to (`runs` oldest first), or null. */
export function runForTime(ts: number, runs: readonly Run[]): Run | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    if (run.startedAt - USER_MESSAGE_LEAD_MS > ts) continue;
    return run.completedAt === undefined || ts <= run.completedAt + RUN_END_SLACK_MS ? run : null;
  }
  return null;
}

/**
 * The thread's context use from the newest entry in `entries` that reported usage (T3's
 * `contextUsage`), or null when none did.
 */
export function latestContextUsage(entries: readonly TranscriptEntry[]): ThreadTokenUsageSnapshot | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const usage = entries[i]!.usage;
    if (usage === undefined) continue;
    return {
      usedTokens: usage.usedTokens,
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.maxTokens !== undefined ? { maxTokens: usage.maxTokens } : {}),
      ...(usage.cost !== undefined ? { cost: { amount: usage.cost, currency: "USD" } } : {}),
    };
  }
  return null;
}

function sameUsage(a: ThreadTokenUsageSnapshot | undefined, b: ThreadTokenUsageSnapshot): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** A screen read for a `screen` item: trailing blank lines dropped, the last `SCREEN_MAX_BYTES` kept. */
export function screenText(raw: string): string {
  const text = raw.replace(/\r/g, "").replace(/(?:[ \t]*\n)+[ \t]*$/, "").trimEnd();
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= SCREEN_MAX_BYTES) return text;
  // Keep the tail (the newest rows), starting on a whole line where one fits.
  const tail = new TextDecoder().decode(bytes.subarray(bytes.length - SCREEN_MAX_BYTES)).replace(/^�+/, "");
  const nl = tail.indexOf("\n");
  return nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail;
}

// ── The ingestor ─────────────────────────────────────────────────────────────────────────────────

export interface JournalIngestorDeps {
  store: Pick<
    ThreadStore,
    | "append"
    | "onCommitted"
    | "getThread"
    | "listThreads"
    | "listRuns"
    | "openRun"
    | "openRuns"
    | "getTurnItem"
    | "recentItems"
    | "itemsForRun"
    | "offsets"
  >;
  engine: Pick<StateEngine, "current" | "onUpdate">;
  herdr: Pick<HerdrClient, "readPane">;
  journals: Record<string, JournalAdapter> | null;
  transcripts: Pick<TranscriptStore, "readSince"> | null;
  watchers: Pick<ThreadWatchers, "count" | "onChange">;
  now?: () => number;
  newId?: () => string;
  log?: (msg: string) => void;
  pollMs?: number;
}

export interface JournalIngestor {
  start(): void;
  stop(): void;
  /** Read the thread's journal now (whatever its status) and settle its run. */
  catchUp(threadId: string): Promise<void>;
  /** T06: the interrupt key was sent; the run ends `interrupted` when the status leaves `working`. */
  markInterrupted(runId: string): void;
  /** Resolves when every queued pass has finished (tests). */
  settled(): Promise<void>;
}

export function createJournalIngestor(deps: JournalIngestorDeps): JournalIngestor {
  const { store, engine, herdr, journals, transcripts, watchers } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const pollMs = deps.pollMs ?? ACTIVE_POLL_MS;

  const chains = new Map<string, Promise<void>>();
  const queued = new Map<string, boolean>();
  const refs = new Map<string, { ref: AgentSessionRef | null; at: number; paneId: string }>();
  const warnedAt = new Map<string, number>();
  const interrupted = new Set<string>();
  const unsubscribe: (() => void)[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const warn = (threadId: string, msg: string) => {
    const last = warnedAt.get(threadId);
    const at = now();
    if (last !== undefined && at - last < WARN_EVERY_MS) return;
    warnedAt.set(threadId, at);
    log(`[threads] journal ingest for ${threadId}: ${msg}`);
  };

  const adapterOf = (thread: ServerThread): JournalAdapter | undefined =>
    thread.harness === SHELL_HARNESS ? undefined : adapterFor(journals ?? {}, thread.harness);

  const livePane = (paneId: string): AgentView | undefined => {
    const { agents, shellPanes } = engine.current();
    return agents.find((p) => p.paneId === paneId) ?? shellPanes.find((p) => p.paneId === paneId);
  };

  const sessionFor = async (thread: ServerThread, pane: AgentView, adapter: JournalAdapter) => {
    const cached = refs.get(thread.id);
    if (cached && cached.paneId === pane.paneId && now() - cached.at < REF_TTL_MS) return cached.ref;
    const ref = await resolveSessionRef(engine, herdr, adapter, pane);
    refs.set(thread.id, { ref, at: now(), paneId: pane.paneId });
    return ref;
  };

  const sameLineage = async (adapter: JournalAdapter, fromKey: string, to: AgentSessionRef): Promise<boolean> => {
    const from = refFromKey(fromKey);
    if (!adapter.sessionLineage || from === null) return false;
    const [a, b] = await Promise.all([adapter.sessionLineage(from), adapter.sessionLineage(to)]);
    return a !== null && a === b;
  };

  /** Items for `entries`, upserted against the store: new ones, and existing ones whose body changed. */
  const itemDrafts = (
    thread: ServerThread,
    entries: readonly TranscriptEntry[],
    opts: { fresh: boolean; backfill: boolean },
  ): EventDraft[] => {
    const at = now();
    const exists = (id: string) => store.getTurnItem(id) !== null;
    let create = entries;
    let updateOnly: readonly TranscriptEntry[] = [];
    if (opts.fresh) {
      // A log read from its start (first read, a new file, a new session): the newest entry we
      // already hold anchors it. Before the anchor only known items are refreshed (creating older
      // ones would append them out of order); with no anchor only the newest entries are taken.
      let anchor = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entryItemIds(entries[i]!).some(exists)) {
          anchor = i;
          break;
        }
      }
      if (anchor >= 0) {
        updateOnly = entries.slice(0, anchor + 1);
        create = entries.slice(anchor + 1);
      } else {
        create = entries.slice(-BACKFILL_ENTRIES);
      }
    }

    const drafts: EventDraft[] = [];
    const push = (item: TurnItemDraft) => drafts.push({ type: "turn-item.updated", threadId: thread.id, payload: { item } });
    const open = store.openRun(thread.id);
    const runs = store.listRuns(thread.id, 50);
    const runById = new Map(runs.map((r) => [r.id, r]));
    const claimed = new Set(runs.map((r) => r.userItemId).filter((id): id is string => id !== undefined));

    /** Upsert one entry's items. `runId` is used for items not yet stored. */
    const upsert = (entry: TranscriptEntry, runId: string | null, runOpen: boolean, createNew: boolean) => {
      const fresh = entryItems(entry, { threadId: thread.id, runId, runOpen, createdAt: at, updatedAt: at, harness: thread.harness });
      for (const item of fresh) {
        const existing = store.getTurnItem(item.id);
        if (existing === null) {
          if (!createNew) continue;
          push(item);
          if (item.type === "user_message" && item.runId !== null && !claimed.has(item.id)) {
            const run = runById.get(item.runId);
            if (run && run.userItemId === undefined) {
              const next: Run = { ...run, userItemId: item.id };
              runById.set(run.id, next);
              claimed.add(item.id);
              drafts.push({ type: "run.updated", threadId: thread.id, payload: { run: next } });
            }
          }
          continue;
        }
        // Known item: its run and first-seen time stay; the body may have moved on (a result landed).
        const itemOpen = existing.runId !== null && existing.runId === open?.id;
        const again = entryItems(entry, {
          threadId: thread.id,
          runId: existing.runId,
          runOpen: itemOpen,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          harness: thread.harness,
        }).find((i) => i.id === item.id)!;
        // A call the run's interrupt cut short stays interrupted rather than reading as done.
        if (existing.status === "interrupted" && again.status === "completed") again.status = "interrupted";
        if (sameItemBody(existing, again)) continue;
        push({ ...again, updatedAt: at });
      }
    };

    for (const entry of updateOnly) upsert(entry, null, false, false);

    if (opts.backfill) {
      // One completed run per user message, in order. The last stays open while the pane works.
      const working = KEEPS_RUN.has(thread.status) && thread.status !== "starting";
      let ordinal = runs.at(-1)?.ordinal ?? 0;
      let current: Run | null = null;
      let lastAt: number | null = null;
      const close = (run: Run, end: number) =>
        drafts.push({ type: "run.ended", threadId: thread.id, payload: { runId: run.id, status: "completed", completedAt: end } });
      create.forEach((entry, i) => {
        const t = parseEntryTime(entry.ts) ?? at;
        if (isUserSpeech(entry)) {
          if (current) close(current, lastAt ?? t);
          const userItem = entryItems(entry, { threadId: thread.id, runId: null, runOpen: false, createdAt: at, updatedAt: at }).find(
            (it) => it.type === "user_message",
          );
          current = {
            id: newId(),
            threadId: thread.id,
            ordinal: ++ordinal,
            status: "running",
            startedAt: t,
            ...(userItem && !exists(userItem.id) ? { userItemId: userItem.id } : {}),
          };
          drafts.push({ type: "run.started", threadId: thread.id, payload: { run: current } });
        }
        const isLastRun = current !== null && !create.slice(i + 1).some(isUserSpeech);
        upsert(entry, current?.id ?? null, working && isLastRun, true);
        lastAt = t;
      });
      if (current && !working) close(current, lastAt ?? at);
      return drafts;
    }

    for (const entry of create) {
      const ts = parseEntryTime(entry.ts);
      const run = ts !== null ? runForTime(ts, [...runById.values()]) : open;
      upsert(entry, run?.id ?? null, run !== null && run.id === open?.id, true);
    }
    return drafts;
  };

  /** Read what is new in the thread's journal and commit it with the new offset. */
  const ingestJournal = async (thread: ServerThread, adapter: JournalAdapter): Promise<void> => {
    if (transcripts === null) return;
    const pane = livePane(thread.paneId);
    if (!pane) return;
    const ref = await sessionFor(thread, pane, adapter);
    if (ref === null) return;
    const key = sessionKey(ref);
    const saved = store.offsets.get(thread.id);
    const drafts: EventDraft[] = [];
    const sessionChanged = saved !== null && saved.sessionKey !== null && saved.sessionKey !== key;
    if (sessionChanged && !(await sameLineage(adapter, saved.sessionKey!, ref))) {
      const label = sessionLabel(key);
      let id = `session:${label}`;
      for (let n = 1; store.getTurnItem(id) !== null; n++) id = `session:${label}:${n}`;
      const at = now();
      drafts.push({
        type: "turn-item.updated",
        threadId: thread.id,
        payload: {
          item: {
            id,
            threadId: thread.id,
            runId: store.openRun(thread.id)?.id ?? null,
            status: "completed",
            title: null,
            startedAt: null,
            completedAt: null,
            createdAt: at,
            updatedAt: at,
            type: "session",
            from: sessionLabel(saved.sessionKey!),
            to: label,
          },
        },
      });
    }
    const read = await transcripts.readSince(adapter, ref, sessionChanged ? null : saved);
    if (read.kind === "missing") {
      warn(thread.id, "no session log to read");
      return;
    }
    if (read.kind === "unchanged") return;
    const fresh = saved === null || sessionChanged || read.reset;
    const backfill = saved === null && store.listRuns(thread.id, 1).length === 0;
    drafts.push(...itemDrafts(thread, read.entries, { fresh, backfill }));
    const contextUsage = latestContextUsage(read.entries);
    if (contextUsage !== null && !sameUsage(thread.contextUsage, contextUsage)) {
      drafts.push({ type: "thread.updated", threadId: thread.id, payload: { patch: { contextUsage }, at: now() } });
    }
    const offset: JournalOffset = {
      threadId: thread.id,
      path: read.path,
      offset: read.nextOffset,
      size: read.size,
      mtimeMs: read.mtimeMs,
      sessionKey: key,
    };
    // The thread may have gone (pruned) while we read; a batch for it would fail on the foreign key.
    if (store.getThread(thread.id) === null) return;
    store.append(drafts, { offsets: [offset] });
  };

  const startRun = (thread: ServerThread) => {
    const at = now();
    const ordinal = (store.listRuns(thread.id, 1).at(-1)?.ordinal ?? 0) + 1;
    const run: Run = { id: newId(), threadId: thread.id, ordinal, status: "running", startedAt: at };
    // The message that opened the run was usually read just before the status turned: claim the
    // first unclaimed one, and the loose items after it, from the lead window.
    const recent = store.recentItems(thread.id, 50);
    const first = recent.findIndex((i) => i.type === "user_message" && i.runId === null && i.createdAt >= at - USER_MESSAGE_LEAD_MS);
    const adopt = first === -1 ? [] : recent.slice(first).filter((i) => i.runId === null);
    if (first !== -1) run.userItemId = recent[first]!.id;
    const drafts: EventDraft[] = [{ type: "run.started", threadId: thread.id, payload: { run } }];
    for (const item of adopt) {
      drafts.push({ type: "turn-item.updated", threadId: thread.id, payload: { item: { ...item, runId: run.id, updatedAt: at } } });
    }
    store.append(drafts);
  };

  const endRun = async (thread: ServerThread, run: Run, adapter: JournalAdapter | undefined) => {
    const items = store.itemsForRun(run.id);
    let status: Exclude<RunStatus, "running">;
    if (interrupted.has(run.id) || thread.shelf === "archived") status = "interrupted";
    else if (items.some((i) => i.type === "error")) status = "failed";
    // The harness logged that the operator stopped it (Claude's interrupt marker, pressed in the terminal).
    else if (items.at(-1)?.type === "run_interrupt_result") status = "interrupted";
    else status = "completed";
    interrupted.delete(run.id);
    const at = now();
    const drafts: EventDraft[] = [];
    // Tool calls still marked running never got a result before the run ended.
    for (const item of items) {
      if (item.status !== "running") continue;
      const next = { ...item, status: status === "interrupted" ? "interrupted" : "completed", updatedAt: at } as TurnItem;
      drafts.push({ type: "turn-item.updated", threadId: thread.id, payload: { item: next } });
    }
    if (!adapter && thread.harness !== SHELL_HARNESS && thread.shelf !== "archived") {
      const screen = await readScreen(thread);
      if (screen !== null) {
        drafts.push({
          type: "turn-item.updated",
          threadId: thread.id,
          payload: {
            item: {
              id: `screen:${run.id}`,
              threadId: thread.id,
              runId: run.id,
              status: "completed",
              title: null,
              startedAt: null,
              completedAt: null,
              createdAt: at,
              updatedAt: at,
              type: "screen",
              text: screen,
              capturedAt: at,
            },
          },
        });
      }
    }
    // Another pass may have ended it while the screen was read.
    if (store.openRun(thread.id)?.id !== run.id) return;
    drafts.push({ type: "run.ended", threadId: thread.id, payload: { runId: run.id, status, completedAt: at } });
    if (status === "failed" && thread.shelf !== "archived") {
      drafts.push({ type: "thread.updated", threadId: thread.id, payload: { patch: { status: "failed" }, at } });
    }
    store.append(drafts);
  };

  /** The visible screen, never `recent`: a background `recent` read can scroll the operator's pane. */
  const readScreen = async (thread: ServerThread): Promise<string | null> => {
    try {
      const read = await herdr.readPane(thread.paneId, "visible", SCREEN_LINES, "text");
      if (!paneReadMatches(thread.paneId, read)) return null;
      const text = screenText(read.text);
      return text === "" ? null : text;
    } catch (err) {
      warn(thread.id, `screen read failed: ${(err as Error).message}`);
      return null;
    }
  };

  const processThread = async (threadId: string, force: boolean): Promise<void> => {
    let thread = store.getThread(threadId);
    if (!thread) return;
    const adapter = adapterOf(thread);
    // A run opens before the read, so what the read finds is attributed to it live (a tool call with
    // no result yet reads as running). The exception is a thread never read before: its backfill
    // builds the runs, and leaves the last one open if the pane is working.
    if (
      thread.shelf !== "archived" &&
      thread.status === "working" &&
      store.openRun(threadId) === null &&
      (!adapter || transcripts === null || store.offsets.get(threadId) !== null)
    ) {
      startRun(thread);
    }
    let didRead = false;
    if (thread.shelf !== "archived" && adapter && (force || thread.status === "working" || watchers.count(threadId) > 0)) {
      try {
        await ingestJournal(thread, adapter);
      } catch (err) {
        warn(threadId, (err as Error).message);
      }
      didRead = true;
      thread = store.getThread(threadId);
      if (!thread) return;
    }
    const open = store.openRun(threadId);
    if (thread.shelf === "archived") {
      if (open) await endRun(thread, open, adapter);
      return;
    }
    if (thread.status === "working") {
      if (!open) startRun(thread);
      return;
    }
    if (!open || KEEPS_RUN.has(thread.status)) return;
    // Leaving work: one last read, so the run's closing message lands inside it.
    if (adapter && !didRead) {
      try {
        await ingestJournal(thread, adapter);
      } catch (err) {
        warn(threadId, (err as Error).message);
      }
    }
    await endRun(thread, open, adapter);
  };

  /** Queue a pass for the thread. Passes for one thread never overlap; queued ones coalesce. */
  const schedule = (threadId: string, force = false): Promise<void> => {
    if (queued.has(threadId)) {
      if (force) queued.set(threadId, true);
      return chains.get(threadId)!;
    }
    queued.set(threadId, force);
    const prev = chains.get(threadId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const f = queued.get(threadId) ?? false;
      queued.delete(threadId);
      if (stopped) return;
      try {
        await processThread(threadId, f);
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

  const tick = () => {
    const ending = new Set(store.openRuns().map((r) => r.threadId));
    for (const t of store.listThreads()) {
      if (t.shelf === "archived") {
        if (ending.has(t.id)) void schedule(t.id);
        continue;
      }
      const active = t.status === "working" || watchers.count(t.id) > 0;
      if (active || (ending.has(t.id) && !KEEPS_RUN.has(t.status))) void schedule(t.id);
    }
  };

  let resumed = false;
  const resume = () => {
    // A restart resumes: one catch-up for every live thread that was read before.
    if (resumed) return;
    resumed = true;
    for (const t of store.listThreads()) {
      if (t.shelf === "archived") continue;
      void schedule(t.id, store.offsets.get(t.id) !== null);
    }
  };

  return {
    start() {
      if (timer !== null) return;
      stopped = false;
      unsubscribe.push(
        store.onCommitted((events) => {
          for (const e of events) {
            if (!e.threadId) continue;
            const statusChange = e.type === "thread.updated" && e.payload.patch.status !== undefined;
            if (statusChange || e.type === "thread.created" || e.type === "thread.archived" || e.type === "thread.shelf-changed") {
              void schedule(e.threadId);
            }
          }
        }),
      );
      unsubscribe.push(
        watchers.onChange((threadId) => {
          if (watchers.count(threadId) > 0) void schedule(threadId, true);
        }),
      );
      // Panes are needed to resolve a session, so the catch-up waits for the first connected poll.
      if (engine.current().bridge === "connected") resume();
      else {
        const off = engine.onUpdate((snap) => {
          if (snap.bridge !== "connected") return;
          off();
          resume();
        });
        unsubscribe.push(off);
      }
      timer = setInterval(tick, pollMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const off of unsubscribe.splice(0)) off();
    },
    catchUp: (threadId) => schedule(threadId, true),
    markInterrupted(runId) {
      interrupted.add(runId);
    },
    async settled() {
      while (chains.size > 0) await Promise.all([...chains.values()]);
    },
  };
}
