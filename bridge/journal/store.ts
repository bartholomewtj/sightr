// Reads + caches parsed journals, for whichever adapter the pane's agent selects.
//
// History is fetched on demand — it is not on the 1.5 s poll path. The snapshot poll never waits
// on a journal read: the running-command chip is served from a per-(adapter, ref) cache with a 5 s
// TTL, refreshed in the background. A parse is reused until the log's size or mtime moves. The
// parse cache is keyed by absolute path, so two sessions fronting panes whose agents write into the
// same root still hit the same entry.

import type { AgentSessionRef, JournalAdapter, TranscriptEntry, TranscriptPage } from "./types.ts";

/** How many parsed journals to keep hot. Each is re-parsed only when its file's size/mtime moves. */
export const CACHE_MAX = 16;

/** How long a snapshot may keep serving a running-command answer before a background refresh. */
export const RUNNING_TTL_MS = 5_000;

interface CacheEntry {
  size: number;
  mtimeMs: number;
  complete: boolean;
  entries: TranscriptEntry[];
}

/**
 * Last-known running-command answer for one (adapter, ref). `value` is what the snapshot paints
 * (null = no log, omit the chip). `checkedAt` is 0 until the first refresh settles.
 */
interface RunningEntry {
  value: boolean | null;
  checkedAt: number;
  path?: string;
  size?: number;
  mtimeMs?: number;
  inflight?: Promise<void>;
}

/**
 * Page a parsed journal, newest-anchored: with no cursor you get the LAST `limit` turns (the phone
 * opens at the recent end, like the mirror it replaces); `before` walks backwards from a turn you
 * already hold. Returned entries stay oldest-first so the view renders top-down either way.
 */
export function pageEntries(
  entries: TranscriptEntry[],
  opts: { limit: number; before?: string },
): { window: TranscriptEntry[]; hasMore: boolean } {
  // An unknown cursor (log rewritten under us, a stale client, or a synthesised cursor whose row
  // fell out of the window) degrades to "newest", never to an empty page — the user asked for older
  // history and must still see something.
  const end =
    opts.before === undefined
      ? entries.length
      : (() => {
          const i = entries.findIndex((e) => e.uuid === opts.before);
          return i === -1 ? entries.length : i;
        })();
  const start = Math.max(0, end - opts.limit);
  return { window: entries.slice(start, end), hasMore: start > 0 };
}

/** True when the NEWEST entry holds a pending tool call; false when it doesn't; null when
 *  there is nothing to read (no log / refused ref / containment miss) — the caller omits the
 *  flag for null, exactly like `page()` returning null. */
export function newestEntryPendingTool(entries: TranscriptEntry[]): boolean {
  if (entries.length === 0) return false;
  const last = entries[entries.length - 1]!;
  return last.parts.some((p) => p.kind === "tool" && p.result === undefined);
}

function runningKey(adapter: JournalAdapter, ref: AgentSessionRef): string {
  return `${adapter.agent}\0${ref.kind}\0${ref.value}`;
}

export class TranscriptStore {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly running = new Map<string, RunningEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  private async loadEntry(
    adapter: JournalAdapter,
    path: string,
    meta: { size: number; mtimeMs: number },
  ): Promise<CacheEntry> {
    const cached = this.cache.get(path);
    if (cached && cached.size === meta.size && cached.mtimeMs === meta.mtimeMs) {
      // Re-set to move it to the end: eviction below is insertion-ordered, so touching a hit keeps
      // the hot journal from being evicted underneath a colder one.
      this.cache.delete(path);
      this.cache.set(path, cached);
      return cached;
    }
    const { text, complete, size, mtimeMs } = await adapter.source.load(path);
    const entry: CacheEntry = { size, mtimeMs, complete, entries: adapter.parse(text) };
    this.cache.set(path, entry);
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return entry;
  }

  /**
   * Read one page of a pane's journal.
   *
   * Null means "nothing to serve" for every reason the client is allowed to distinguish: the ref
   * names no file, the adapter refused the ref's shape, or the path failed containment. Those stay
   * indistinguishable on purpose — a containment failure must not be probeable.
   */
  async page(
    adapter: JournalAdapter,
    ref: AgentSessionRef,
    opts: { limit: number; before?: string },
  ): Promise<Omit<TranscriptPage, "paneId"> | null> {
    const path = await adapter.source.resolve(ref);
    if (path === null) return null;

    // Cache check BEFORE the read: a journal can be 32 MB and paging walks the same file repeatedly,
    // so validity is decided by a stat. Only a moved size/mtime costs a read + parse.
    const meta = await adapter.source.stat(path);
    if (meta === null) return null; // vanished between resolve and read

    const entry = await this.loadEntry(adapter, path, meta);
    const { entries, complete } = entry;

    const { window, hasMore } = pageEntries(entries, opts);
    return {
      entries: window,
      // A clipped file always has more behind it, even at the window's start.
      hasMore: hasMore || (!complete && window.length > 0 && window[0] === entries[0]),
      total: entries.length,
      fileTruncated: !complete,
    };
  }

  /**
   * Last-known running-command answer, or `undefined` if this ref has never been refreshed.
   * Synchronous — the snapshot handler must not await a journal read. A stale value is still a
   * value: the chip may lag the log by up to one TTL.
   */
  peekRunningCommand(adapter: JournalAdapter, ref: AgentSessionRef): boolean | null | undefined {
    const entry = this.running.get(runningKey(adapter, ref));
    return entry === undefined || entry.checkedAt === 0 ? undefined : entry.value;
  }

  /**
   * Kick a background refresh when the cached answer is missing or older than {@link RUNNING_TTL_MS}.
   * One in-flight refresh per key; concurrent snapshot polls coalesce onto it. Does not await.
   */
  scheduleRunningCommandRefresh(adapter: JournalAdapter, ref: AgentSessionRef): void {
    const key = runningKey(adapter, ref);
    let entry = this.running.get(key);
    if (!entry) {
      entry = { value: null, checkedAt: 0 };
      this.running.set(key, entry);
    }
    if (entry.inflight) return;
    if (entry.checkedAt !== 0 && this.now() - entry.checkedAt < RUNNING_TTL_MS) return;
    entry.inflight = this.refreshRunningCommand(adapter, ref, entry).finally(() => {
      entry.inflight = undefined;
    });
  }

  /** Wait for any in-flight refresh for this key. Tests use this; the snapshot handler must not. */
  async flushRunningCommandRefresh(adapter: JournalAdapter, ref: AgentSessionRef): Promise<void> {
    const inflight = this.running.get(runningKey(adapter, ref))?.inflight;
    if (inflight) await inflight;
  }

  /**
   * True when the newest parsed turn holds a pending tool call; false when it doesn't; null when
   * there is nothing to read (no log / refused ref / containment miss) — the caller omits the
   * flag for null, exactly like `page()` returning null.
   *
   * Blocking: schedules a refresh if the TTL has expired and waits for it. The snapshot poll uses
   * {@link peekRunningCommand} + {@link scheduleRunningCommandRefresh} instead, so it never waits.
   */
  async runningCommand(adapter: JournalAdapter, ref: AgentSessionRef): Promise<boolean | null> {
    this.scheduleRunningCommandRefresh(adapter, ref);
    await this.flushRunningCommandRefresh(adapter, ref);
    const value = this.peekRunningCommand(adapter, ref);
    return value === undefined ? null : value;
  }

  /**
   * Reload the running-command answer. A cached path whose size/mtime has not moved is a no-op
   * besides bumping `checkedAt` — no resolve (so no followContinuation), no load. Resolve (and
   * therefore followContinuation) runs only when we have no path yet, or the cached path vanished.
   */
  private async refreshRunningCommand(
    adapter: JournalAdapter,
    ref: AgentSessionRef,
    entry: RunningEntry,
  ): Promise<void> {
    try {
      if (entry.path !== undefined && entry.size !== undefined && entry.mtimeMs !== undefined) {
        const meta = await adapter.source.stat(entry.path);
        if (meta !== null && meta.size === entry.size && meta.mtimeMs === entry.mtimeMs) {
          entry.checkedAt = this.now();
          return;
        }
        if (meta !== null) {
          const loaded = await this.loadEntry(adapter, entry.path, meta);
          entry.value = newestEntryPendingTool(loaded.entries);
          entry.size = loaded.size;
          entry.mtimeMs = loaded.mtimeMs;
          entry.checkedAt = this.now();
          return;
        }
        // Cached path vanished — fall through to a full resolve.
        entry.path = undefined;
        entry.size = undefined;
        entry.mtimeMs = undefined;
      }

      const path = await adapter.source.resolve(ref);
      if (path === null) {
        entry.value = null;
        entry.checkedAt = this.now();
        return;
      }
      const meta = await adapter.source.stat(path);
      if (meta === null) {
        entry.value = null;
        entry.checkedAt = this.now();
        return;
      }
      const loaded = await this.loadEntry(adapter, path, meta);
      entry.value = newestEntryPendingTool(loaded.entries);
      entry.path = path;
      entry.size = loaded.size;
      entry.mtimeMs = loaded.mtimeMs;
      entry.checkedAt = this.now();
    } catch {
      // Keep whatever we last knew. Stamp checkedAt so a throwing adapter cannot spin every poll.
      entry.checkedAt = this.now();
    }
  }
}
