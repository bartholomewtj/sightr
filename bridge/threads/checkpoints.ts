// Pattern of T3 Code apps/server/src/orchestration-v2/CheckpointCaptureService.ts (MIT, see web2/THIRD_PARTY.md):
// a checkpoint at each run's start and end, recorded as `checkpoint.captured` (spec T30). T3 hooks its own
// turn lifecycle; Sightr listens to the run boundaries T03 already derives (`run.started`, `run.ended` on
// `store.onCommitted`), so a run begun in the terminal gets its checkpoints like a dispatched one. A throw in
// here never rolls anything back: the listener only queues work.
//
// Also here: the retention sweep (refs deleted, `checkpoint.expired` emitted, `gc` in the private store only)
// and the run-scope review answers (`/api/files/git/review/patch|contents?scope=run`, T26's shapes).
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { CheckpointAbsentReason, Run, RunCheckpoint, ThreadEvent } from "../../shared/v2/contracts.ts";
import type { ReviewDiffFileContents, ReviewDiffFilePatch, ReviewUnavailable } from "../../shared/v2/review.ts";
import { hardenedInvoke, isHiddenPath, openRepo, spawnGit, type GitRunner } from "../workdir-git.ts";
import { parseRelPath } from "../workdir.ts";
import { SHELL_HARNESS } from "./capabilities.ts";
import { authoredMatcher, blobSide, capturePatches, commitsAlive, diffRun, filePatch, hashOf, MAX_PATCH_STORE_BYTES } from "./checkpoint-diff.ts";
import { BUSY, checkpointRef, createCheckpointGit, storeKey, type CheckpointGit } from "./checkpoint-git.ts";
import type { ServerCheckpointCaptured } from "./events.ts";
import type { CheckpointPatchRow, CheckpointSweepRow, ThreadStore } from "./store.ts";

export const START_WINDOW_MS = 30_000;
export const END_WINDOW_MS = 30_000;
export const APPROX_LAG_MS = 5_000;
export const CHECKPOINT_KEEP_RUNS = 50;
export const CHECKPOINT_KEEP_DAYS = 14;
export const ARCHIVED_KEEP_MS = 24 * 60 * 60 * 1000;
export const MAX_STORE_BYTES = 256 * 1024 * 1024;
/** A start snapshot whose run has not ended after this long is given up (its ref goes at the next sweep). */
export const PENDING_MAX_MS = 24 * 60 * 60 * 1000;
export const SWEEP_FIRST_MS = 30_000;
export const SWEEP_EVERY_MS = 60 * 60 * 1000;
/** A run-scope review read waits at most this long for its store (a snapshot or gc may hold it). */
export const RUN_REVIEW_DEADLINE_MS = 25_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CheckpointServiceDeps {
  store: ThreadStore;
  stateDir: string;
  workRoot: string;
  /** The pane's cwd (`engine.current()`), as `bridge/server.ts` gives the Files routes. */
  paneCwd: (paneId: string) => string | null;
  /** `SIGHTR_CHECKPOINTS` is not `0`. Off: every run is `absent: disabled`, no git runs and no sweep. */
  enabled: boolean;
  git?: CheckpointGit;
  /** The runner for repo discovery (`openRepo`); default workdir-git's `spawnGit`. */
  run?: GitRunner;
  now?: () => number;
  log?: (msg: string) => void;
  /** Per-store byte cap for the sweep (default {@link MAX_STORE_BYTES}). */
  maxStoreBytes?: number;
  /** Stored-patch cap for the sweep (default `MAX_PATCH_STORE_BYTES`). */
  maxPatchStoreBytes?: number;
  /** How long a run-scope read waits for its store (default {@link RUN_REVIEW_DEADLINE_MS}); past it, `busy`. */
  reviewDeadlineMs?: number;
}

export type RunPatchQuery = { threadId: string; runId: string; file: string; w: boolean };
export type RunContentsQuery = { threadId: string; runId: string; file: string };
/** What the Files routes need from the checkpoint service (`scope=run`). */
export interface RunReview {
  patch(q: RunPatchQuery): Promise<ReviewDiffFilePatch>;
  contents(q: RunContentsQuery): Promise<ReviewDiffFileContents>;
}

export interface SweepResult {
  expired: string[];
  refsDeleted: number;
  storesRemoved: number;
  patchRunsPruned: number;
}

type CapturedExtra = Omit<ServerCheckpointCaptured, "checkpoint" | "phase">;
type Unavailable = { available: false; reason: ReviewUnavailable };
const unavailable = (reason: ReviewUnavailable): Unavailable => ({ available: false, reason });
const samePath = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

export type CheckpointService = ReturnType<typeof createCheckpointService>;

export function createCheckpointService(deps: CheckpointServiceDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const git = deps.git ?? createCheckpointGit({ stateDir: deps.stateDir, workRoot: deps.workRoot, now });
  const invoke = hardenedInvoke(deps.run ?? spawnGit);
  const maxStoreBytes = deps.maxStoreBytes ?? MAX_STORE_BYTES;
  /** Start work per run, so an end waits for its start. */
  const starts = new Map<string, Promise<void>>();
  const work = new Set<Promise<unknown>>();
  let unsubscribe: (() => void) | null = null;
  let timers: Array<ReturnType<typeof setTimeout>> = [];

  const track = <T>(p: Promise<T>): Promise<T | undefined> => {
    const guarded = p.catch((err): undefined => { log(`[checkpoints] ${(err as Error).message}`); return undefined; });
    work.add(guarded);
    void guarded.finally(() => work.delete(guarded));
    return guarded;
  };

  function append(phase: "start" | "end", checkpoint: RunCheckpoint, extra: CapturedExtra = {}, patches?: { runId: string; rows: CheckpointPatchRow[] }): void {
    store.append([{ type: "checkpoint.captured", threadId: checkpoint.threadId, payload: { checkpoint, phase, ...extra } }], patches ? { checkpointPatches: patches } : {});
  }
  const absent = (run: Pick<Run, "id" | "threadId" | "ordinal">, reason: CheckpointAbsentReason, extra: Partial<RunCheckpoint> = {}): RunCheckpoint => ({
    runId: run.id, threadId: run.threadId, appRunOrdinal: run.ordinal, status: "absent", reason, files: [], additions: 0, deletions: 0, capturedAt: now(), ...extra,
  });
  const projectOn = (threadId: string): boolean => {
    const thread = store.getThread(threadId); if (!thread) return false;
    return store.getProject(thread.projectId)?.checkpoints !== false;
  };

  // ── Start ──────────────────────────────────────────────────────────────────────────────────────

  /** Whatever throws on the way (a store that cannot be made, a read, an append) is recorded, never lost. */
  async function onStarted(run: Run): Promise<void> {
    try { await startNow(run); } catch (err) {
      log(`[checkpoints] start of run ${run.id} failed: ${(err as Error).message}`);
      if (!store.getCheckpoint(run.id) && store.getRun(run.id)) append("start", absent(run, "git-failed"));
    }
  }

  async function startNow(run: Run): Promise<void> {
    const thread = store.getThread(run.threadId);
    if (!thread || thread.harness === SHELL_HARNESS) return;
    if (store.getCheckpoint(run.id)) return; // a replayed start
    if (!deps.enabled || !projectOn(run.threadId)) return append("start", absent(run, "disabled"));
    // A run the bridge learns of late (a restart's catch-up) costs no git call at all.
    if (now() - run.startedAt > START_WINDOW_MS) return append("start", absent(run, "start-missed"));
    const cwd = deps.paneCwd(thread.paneId);
    const repo = cwd === null ? null : await openRepo(deps.workRoot, invoke, cwd);
    if (!repo?.ok) return append("start", absent(run, "no-repo"));
    const info = await git.resolveRepo(repo.root);
    if (!info) return append("start", absent(run, "no-repo"));
    // Snapshot and record in one slot of the store's queue, so the sweep never sees a ref without its row.
    const done = await git.queue.run(info.repoKey, async () => {
      // The window is checked when the snapshot is about to run (after any queue wait): a restart never snapshots a tree that moved on.
      if (now() - run.startedAt > START_WINDOW_MS) return append("start", absent(run, "start-missed"), { repoRoot: info.root });
      const out = await git.snapshotLocked(info, { threadId: run.threadId, ordinal: run.ordinal, side: "start" });
      if (!out.ok) return append("start", absent(run, out.reason, out.truncated ? { truncated: true } : {}), { repoRoot: info.root });
      const approximate = out.capturedAt - run.startedAt > APPROX_LAG_MS;
      append(
        "start",
        { runId: run.id, threadId: run.threadId, appRunOrdinal: run.ordinal, status: "pending", live: true, files: [], additions: 0, deletions: 0, capturedAt: out.capturedAt, ...(out.skipped ? { skipped: out.skipped } : {}), ...(approximate ? { approximate: true } : {}) },
        { repoRoot: info.root, startCommit: out.commit, skippedPaths: out.skippedPaths, ...(Object.keys(out.hiddenStats).length ? { hiddenStats: out.hiddenStats } : {}) },
      );
    });
    if (done === BUSY) append("start", absent(run, "timeout"), { repoRoot: info.root });
  }

  // ── End ────────────────────────────────────────────────────────────────────────────────────────

  /** The start event's server payload (skipped paths, hidden stats), read back from the stored events. */
  function startPayload(threadId: string, runId: string): ServerCheckpointCaptured | null {
    for (const e of store.storedEventsAfter(0, { threadId, types: ["checkpoint.captured"] })) {
      if (e.type === "checkpoint.captured" && e.payload.phase === "start" && e.payload.checkpoint.runId === runId) return e.payload;
    }
    return null;
  }

  /** Another thread's run in the same repo overlapped this one (its edits are in this diff; git cannot tell them apart). */
  function overlapped(threadId: string, runId: string, root: string, from: number, to: number): boolean {
    return store.listCheckpoints().some((c) => c.checkpoint.runId !== runId && c.checkpoint.threadId !== threadId && c.repoRoot !== "" && c.startCommit !== null && samePath(c.repoRoot, root) && c.runStartedAt <= to && (c.runCompletedAt ?? Number.MAX_SAFE_INTEGER) >= from);
  }

  /** As {@link onStarted}: a throw records the end as failed, so no row stays `pending` because of it. */
  async function onEnded(runId: string, completedAt: number): Promise<void> {
    await starts.get(runId);
    try { await endNow(runId, completedAt); } catch (err) {
      log(`[checkpoints] end of run ${runId} failed: ${(err as Error).message}`);
      const run = store.getRun(runId), row = store.getCheckpoint(runId);
      if (run && row?.endAt === null) append("end", absent(run, "git-failed"), { repoRoot: row.repoRoot, ...(row.startCommit ? { startCommit: row.startCommit } : {}) });
    }
  }

  async function endNow(runId: string, completedAt: number): Promise<void> {
    const run = store.getRun(runId); if (!run) return;
    const thread = store.getThread(run.threadId);
    if (!thread || thread.harness === SHELL_HARNESS) return;
    const row = store.getCheckpoint(runId);
    if (row && row.endAt !== null) return; // a replayed end
    // An end alone proves nothing: with no start snapshot there is no end snapshot.
    if (!row) return append("end", absent(run, deps.enabled ? "start-missed" : "disabled"));
    if (row.checkpoint.status === "absent" || !row.startCommit) return append("end", absent(run, row.checkpoint.reason ?? "start-missed"), { repoRoot: row.repoRoot });
    const startCommit = row.startCommit;
    const base: CapturedExtra = { repoRoot: row.repoRoot, startCommit };
    const info = await git.resolveRepo(row.repoRoot); // the stored root, not the pane (it may be gone)
    if (!info) return append("end", absent(run, "no-repo"), base);
    const authored = authoredMatcher(info.root, store.itemsForRun(runId).flatMap((i) => (i.type === "file_change" ? [i.fileName] : [])));
    const storeRun = git.storeRunner(info);
    // Snapshot, diff, patches and the record in one slot of the store's queue.
    const done = await git.queue.run(info.repoKey, async () => {
      if (now() - completedAt > END_WINDOW_MS) return append("end", absent(run, "end-missed"), base);
      const out = await git.snapshotLocked(info, { threadId: run.threadId, ordinal: run.ordinal, side: "end" });
      if (!out.ok) return append("end", absent(run, out.reason, out.truncated ? { truncated: true } : {}), base);
      const begin = startPayload(run.threadId, runId);
      const skippedPaths = new Set([...(begin?.skippedPaths ?? []), ...out.skippedPaths]);
      const diff = await diffRun(storeRun, startCommit, out.commit, { skippedPaths, authored });
      if ("error" in diff) return append("end", absent(run, "git-failed"), { ...base, endCommit: out.commit });
      const patches = await capturePatches(storeRun, startCommit, out.commit, diff.files, { now });
      // Hidden: refused-name paths whose stat moved between the two snapshots (their content is never read or kept).
      const before = begin?.hiddenStats ?? {}, after = out.hiddenStats;
      let hidden = diff.hidden;
      for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[p] !== after[p]) hidden++;
      const shared = overlapped(run.threadId, runId, info.root, run.startedAt, completedAt);
      append(
        "end",
        {
          runId, threadId: run.threadId, appRunOrdinal: run.ordinal, status: "ready", live: true, files: diff.files, additions: diff.additions, deletions: diff.deletions, capturedAt: out.capturedAt,
          ...(diff.truncated ? { truncated: true } : {}), ...(hidden ? { hidden } : {}), ...(out.skipped ? { skipped: out.skipped } : {}),
          ...(row.checkpoint.approximate ? { approximate: true } : {}), ...(shared ? { shared: true } : {}), ...(out.unsettled ? { unsettled: true } : {}),
        },
        { ...base, repoRoot: info.root, endCommit: out.commit, skippedPaths: out.skippedPaths },
        { runId, rows: patches },
      );
    });
    if (done === BUSY) append("end", absent(run, "timeout"), base);
  }

  function onEvents(events: ThreadEvent[]): void {
    for (const e of events) {
      if (e.type === "run.started") {
        const run = e.payload.run;
        const p = track(onStarted(run)).then(() => {});
        starts.set(run.id, p);
        void p.then(() => { if (starts.get(run.id) === p) starts.delete(run.id); });
      } else if (e.type === "run.ended") {
        void track(onEnded(e.payload.runId, e.payload.completedAt));
      }
    }
  }

  // ── Retention ──────────────────────────────────────────────────────────────────────────────────

  function expire(rows: CheckpointSweepRow[]): string[] {
    const out: string[] = [];
    for (const r of rows) {
      const current = store.getCheckpoint(r.checkpoint.runId);
      if (!current || current.objectsExpiredAt !== null) continue;
      store.append([{ type: "checkpoint.expired", threadId: r.checkpoint.threadId, payload: { runId: r.checkpoint.runId } }]);
      out.push(r.checkpoint.runId);
    }
    return out;
  }
  const refsOf = (r: CheckpointSweepRow): string[] => [checkpointRef(r.checkpoint.threadId, r.checkpoint.appRunOrdinal, "start"), checkpointRef(r.checkpoint.threadId, r.checkpoint.appRunOrdinal, "end")];

  /**
   * Live rows retention removes now: past the newest 50 per thread, older than 14 days, or 24 h after their
   * thread was archived. A `pending` row (its run has not ended) is kept for {@link PENDING_MAX_MS}; past
   * that its end will never come (a lost `run.ended`, a bridge down at the time), so its start ref goes.
   */
  function dueRows(rows: CheckpointSweepRow[], at: number): Set<string> {
    const due = new Set<string>();
    const byThread = new Map<string, CheckpointSweepRow[]>();
    for (const r of rows) byThread.set(r.checkpoint.threadId, [...(byThread.get(r.checkpoint.threadId) ?? []), r]);
    for (const list of byThread.values()) {
      list.sort((a, b) => b.checkpoint.appRunOrdinal - a.checkpoint.appRunOrdinal);
      list.forEach((r, i) => {
        if (r.checkpoint.status === "pending") { if (at - (r.startAt ?? r.runStartedAt) > PENDING_MAX_MS) due.add(r.checkpoint.runId); return; }
        if (i >= CHECKPOINT_KEEP_RUNS || at - r.runStartedAt > CHECKPOINT_KEEP_DAYS * DAY_MS || (r.threadArchivedAt !== null && at - r.threadArchivedAt > ARCHIVED_KEEP_MS)) due.add(r.checkpoint.runId);
      });
    }
    return due;
  }

  async function sweep(at = now()): Promise<SweepResult> {
    const result: SweepResult = { expired: [], refsDeleted: 0, storesRemoved: 0, patchRunsPruned: 0 };
    if (!deps.enabled) return result;
    for (const s of await git.listStores()) {
      const rootGone = s.root === null || !(await stat(s.root).catch(() => null));
      // Rows are read inside the store's slot: a snapshot records its row in the same slot as its ref.
      await git.queue.run(storeKey(s.store), async () => {
        const rows = store.listCheckpoints();
        const due = dueRows(rows, at);
        const mine = s.root === null ? [] : rows.filter((r) => r.repoRoot !== "" && samePath(r.repoRoot, s.root!));
        if (rootGone || mine.length === 0) {
          // An orphan store: its repo is gone, or no run points at it any more.
          await git.removeStore(s.store);
          result.storesRemoved++;
          if (rootGone) result.expired.push(...expire(mine));
          return;
        }
        const refs = await git.listRefs(s.store); if (refs === null) return;
        const byRef = new Map<string, CheckpointSweepRow>();
        for (const r of mine) for (const ref of refsOf(r)) byRef.set(ref, r);
        const gone: string[] = []; const expiring = new Set<CheckpointSweepRow>();
        for (const ref of refs) {
          const r = byRef.get(ref);
          if (!r) { gone.push(ref); continue; } // its thread or run is no longer in the store (deleted, or T01's 90-day prune)
          if (r.objectsExpiredAt !== null || due.has(r.checkpoint.runId)) { gone.push(ref); expiring.add(r); }
        }
        let left = refs.filter((ref) => !gone.includes(ref));
        /**
         * `gc` in the store; when it fails, find the runs whose objects are gone (the user rewrote history
         * and pruned what only their repo held: the store reads unchanged trees and blobs through the
         * alternate), expire them, drop their refs and try once more.
         */
        const collect = async (): Promise<boolean> => {
          if (await git.gc({ store: s.store, objectsDir: s.objectsDir })) return true;
          const broken: CheckpointSweepRow[] = [];
          for (const r of mine) {
            const refsHere = refsOf(r).filter((ref) => left.includes(ref)); if (refsHere.length === 0) continue;
            const commits = [r.startCommit, r.endCommit].filter((c): c is string => c !== null);
            if ((await git.objectsMissing(s, commits)) === true) broken.push(r);
          }
          const brokenRefs = broken.flatMap(refsOf).filter((ref) => left.includes(ref));
          if (brokenRefs.length > 0 && (await git.deleteRefs(s.store, brokenRefs))) {
            left = left.filter((ref) => !brokenRefs.includes(ref));
            result.refsDeleted += brokenRefs.length;
            result.expired.push(...expire(broken));
            if (await git.gc({ store: s.store, objectsDir: s.objectsDir })) return true;
          }
          log(`[checkpoints] gc failed in a private store; retrying next sweep`);
          return false;
        };
        let collected = true;
        if (gone.length > 0 && (await git.deleteRefs(s.store, gone))) {
          result.refsDeleted += gone.length;
          result.expired.push(...expire([...expiring]));
          collected = await collect();
        }
        // Past the per-store cap (measured on the store's objects, not summed from rows): oldest runs first.
        // Only while gc frees what is dropped: a store that cannot collect would otherwise lose every run.
        for (let round = 0; collected && round < 8; round++) {
          const bytes = await git.storeBytes(s.store);
          if (bytes === null || bytes <= maxStoreBytes) break;
          const live = mine.filter((r) => r.objectsExpiredAt === null && !result.expired.includes(r.checkpoint.runId) && r.checkpoint.status !== "pending").sort((a, b) => a.runStartedAt - b.runStartedAt);
          if (live.length === 0) break;
          const batch = live.slice(0, Math.max(1, Math.ceil(live.length / 4)));
          const batchRefs = batch.flatMap(refsOf).filter((ref) => left.includes(ref));
          if (!(await git.deleteRefs(s.store, batchRefs))) break;
          left = left.filter((ref) => !batchRefs.includes(ref));
          result.refsDeleted += batchRefs.length;
          result.expired.push(...expire(batch));
          collected = await collect();
        }
      });
    }
    // A row whose repo is gone (and whose store was never made, or went above): its objects went with it.
    for (const r of store.listCheckpoints()) {
      if (r.objectsExpiredAt !== null || r.repoRoot === "" || r.startCommit === null || result.expired.includes(r.checkpoint.runId)) continue;
      if (!(await stat(r.repoRoot).catch(() => null))) result.expired.push(...expire([r]));
    }
    result.patchRunsPruned = store.pruneCheckpointPatches(deps.maxPatchStoreBytes ?? MAX_PATCH_STORE_BYTES);
    return result;
  }

  // ── Run-scope review (T26's patch and contents routes) ─────────────────────────────────────────

  /** The row a run-scope request may read: the run is the thread's, its checkpoint is `ready`, the file is a repo path it lists. */
  function readable(q: { threadId: string; runId: string; file: string }): { error: "no-checkpoint" | "bad-file" } | { row: NonNullable<ReturnType<ThreadStore["getCheckpoint"]>>; start: string; end: string } {
    const row = store.getCheckpoint(q.runId);
    if (!row || row.checkpoint.threadId !== q.threadId) return { error: "no-checkpoint" as const };
    if (row.checkpoint.status !== "ready" || !row.startCommit || !row.endCommit) return { error: "no-checkpoint" as const };
    const segs = parseRelPath(q.file);
    if (!segs?.length || segs.join("/") !== q.file || isHiddenPath(q.file)) return { error: "bad-file" as const };
    if (!row.checkpoint.files.some((f) => f.path === q.file) && !row.checkpoint.truncated) return { error: "bad-file" as const };
    return { row, start: row.startCommit, end: row.endCommit };
  }

  function markExpired(runId: string, threadId: string): void {
    const row = store.getCheckpoint(runId);
    if (row && row.objectsExpiredAt === null) store.append([{ type: "checkpoint.expired", threadId, payload: { runId } }]);
  }

  /** Live work on the run's store: liveness first (both commits), then `task`. A missing object expires the run. */
  async function live<T>(q: { threadId: string; runId: string }, root: string, start: string, end: string, task: (run: ReturnType<CheckpointGit["storeRunner"]>) => Promise<T | "missing">): Promise<T | Unavailable> {
    if (!deps.enabled) return unavailable("expired");
    const info = await git.resolveRepo(root);
    if (!info) { markExpired(q.runId, q.threadId); return unavailable("expired"); }
    const r = await git.queue.run(info.repoKey, async () => {
      const run = git.storeRunner(info);
      if (!(await commitsAlive(run, [start, end]))) return "missing" as const;
      return task(run);
    }, Date.now() + (deps.reviewDeadlineMs ?? RUN_REVIEW_DEADLINE_MS)); // wall clock; the queue answers busy while waiting
    if (r === BUSY) return unavailable("busy");
    if (r === "missing") { markExpired(q.runId, q.threadId); return unavailable("expired"); }
    return r;
  }

  async function patch(q: RunPatchQuery): Promise<ReviewDiffFilePatch> {
    const ok = readable(q); if ("error" in ok) return unavailable(ok.error);
    const { row, start, end } = ok;
    if (!q.w) {
      const stored = store.checkpointPatch(q.runId, q.file);
      // Served from SQLite with no git call, so archived and expired runs keep their patches.
      if (stored && stored.patch !== null) return { available: true, patch: stored.patch, truncated: stored.truncated, diffHash: hashOf("run", q.runId, q.file, stored.bytes, stored.truncated) };
    }
    if (row.objectsExpiredAt !== null) return unavailable("expired");
    return live(q, row.repoRoot, start, end, async (run): Promise<ReviewDiffFilePatch | "missing"> => {
      const p = await filePatch(run, start, end, q.file, q.w);
      if ("error" in p) return p.error === "missing" ? "missing" : unavailable(p.error === "timeout" ? "timeout" : "git-unavailable");
      return { available: true, patch: p.patch, truncated: p.truncated, diffHash: hashOf("run-live", start, end, q.file, q.w) };
    });
  }

  async function contents(q: RunContentsQuery): Promise<ReviewDiffFileContents> {
    const ok = readable(q); if ("error" in ok) return unavailable(ok.error);
    const { row, start, end } = ok;
    if (row.objectsExpiredAt !== null) return unavailable("expired");
    return live(q, row.repoRoot, start, end, async (run): Promise<ReviewDiffFileContents | "missing"> => {
      const old = await blobSide(run, start, q.file); if ("error" in old) return old.error === "missing" ? "missing" : unavailable("git-unavailable");
      const neu = await blobSide(run, end, q.file); if ("error" in neu) return neu.error === "missing" ? "missing" : unavailable("git-unavailable");
      return { available: true, old, new: neu, diffHash: hashOf("run-contents", start, end, q.file) };
    });
  }

  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = store.onCommitted(onEvents);
      if (!deps.enabled) return; // the kill switch: no git, no sweep; runs still read `absent: disabled`
      void git.cleanTmp();
      const first = setTimeout(() => { void track(sweep()); }, SWEEP_FIRST_MS);
      const every = setInterval(() => { void track(sweep()); }, SWEEP_EVERY_MS);
      (first as { unref?: () => void }).unref?.(); (every as { unref?: () => void }).unref?.();
      timers = [first, every];
    },
    stop() {
      unsubscribe?.(); unsubscribe = null;
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      timers = [];
    },
    /** Resolves once every queued snapshot, capture and sweep has finished (tests, shutdown). */
    async idle(): Promise<void> { while (work.size > 0) await Promise.allSettled([...work]); await git.queue.idle(); },
    sweep,
    patch,
    contents,
    /** Handle committed events as the store listener does (tests). */
    onEvents,
  };
}
