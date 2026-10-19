// Sightr code (T31). The patches of one run's exact diff. The file list is not fetched: it is `Run.checkpoint.files` on the
// thread stream (T30), so this is `useDiffFilePatches` without its list half: the same wants (the revealed file, the
// unfolded ones, the ones near the screen), at most `PATCH_CONCURRENCY` requests in flight, a retry per file, one cached
// state per file and whitespace mode (so flipping Ignore whitespace back costs no request). The route is T30's
// `scope=run` patch (`fetchRunDiff`): the stored patch for `w=0`, computed from live snapshots for `w=1`.
//
// A request that throws (the network, a 5xx) sets `failed`: the panel then falls back to the journal with a Retry
// (`retryFailed`). An answer of `{available:false}` is the host's word about one file (an expired snapshot, a refused
// name) and stays on that file.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { fetchRunDiff } from "@/lib/diffApi";

import { reviewReason } from "./diffReasons";
import { IDLE, patchOf, type DiffFileEntry, type PatchState } from "./diffTypes";
import { PATCH_CONCURRENCY, type Wants } from "./useDiffFilePatches";

const TRUNCATED_NOTE = "This file's diff is longer than the host will send, so only the first part is shown. Counts include everything.";
const NONE_SHOWN_NOTE = "This file's diff is longer than the host will send, so none of it is shown here. Counts include everything.";

interface Entry {
  rev: string;
  state: PatchState;
  /** The request threw (as opposed to an answer of `available: false`). */
  threw: boolean;
}

export interface RunPatchSnapshot {
  entries: ReadonlyMap<string, Entry>;
  /** Some request of the current mode threw and has not been retried. */
  failed: boolean;
}

const NO_WANTS: Wants = { unfolded: new Set(), near: new Set(), reveal: null };
const isAbort = (err: unknown) => (err as { name?: string } | null)?.name === "AbortError";

export class RunPatchEngine {
  private threadId = "";
  private runId = "";
  private files: DiffFileEntry[] = [];
  private ws = false;
  private wants: Wants = NO_WANTS;
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, { rev: string; controller: AbortController }>();
  private listeners = new Set<() => void>();
  private snap: RunPatchSnapshot = { entries: new Map(), failed: false };

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): RunPatchSnapshot => this.snap;

  /** Requests in flight right now. */
  get inFlight(): number {
    return this.inflight.size;
  }

  private key = (path: string, ws = this.ws) => `${ws ? 1 : 0}\0${path}`;

  private publish(): void {
    const entries = new Map<string, Entry>();
    let failed = false;
    const mine = this.ws ? "1\0" : "0\0";
    for (const [key, entry] of this.cache) {
      if (!key.startsWith(mine)) continue;
      entries.set(key.slice(2), entry);
      if (entry.threw && entry.state.state === "error") failed = true;
    }
    this.snap = { entries, failed };
    for (const l of this.listeners) l();
  }

  /** Point the engine at a run. A different run drops everything. */
  target(threadId: string, runId: string): void {
    if (threadId === this.threadId && runId === this.runId) return;
    this.abortAll();
    this.threadId = threadId;
    this.runId = runId;
    this.cache = new Map();
    this.publish();
  }

  setFiles(files: DiffFileEntry[]): void {
    this.files = files;
    this.pump();
  }

  setIgnoreWhitespace(on: boolean): void {
    if (on === this.ws) return;
    this.ws = on;
    this.publish();
    this.pump();
  }

  want(wants: Wants): void {
    this.wants = wants;
    this.pump();
  }

  /** One file again, after an error. */
  retry(path: string): void {
    this.cache.delete(this.key(path));
    this.publish();
    this.pump();
  }

  /** Every file of the current mode whose request threw, again. */
  retryFailed(): void {
    for (const [key, entry] of [...this.cache]) if (entry.threw && key.startsWith(this.ws ? "1\0" : "0\0")) this.cache.delete(key);
    this.publish();
    this.pump();
  }

  dispose(): void {
    this.abortAll();
    this.threadId = "";
    this.runId = "";
    this.files = [];
    this.ws = false;
    this.wants = NO_WANTS;
    this.cache = new Map();
    this.snap = { entries: new Map(), failed: false };
  }

  private abortAll(): void {
    for (const f of this.inflight.values()) f.controller.abort();
    this.inflight.clear();
  }

  private priority(path: string): number {
    const { reveal, unfolded, near } = this.wants;
    return path === reveal ? 0 : unfolded.has(path) ? 1 : near.has(path) ? 2 : 3;
  }

  private pump(): void {
    if (!this.runId) return;
    const byPath = new Map(this.files.map((f) => [f.path, f] as const));
    // A request for a file that changed or is gone is no use any more (the other whitespace mode's requests may finish).
    for (const [id, f] of this.inflight) {
      const file = byPath.get(id.slice(2));
      if (!file || file.rev !== f.rev) {
        f.controller.abort();
        this.inflight.delete(id);
      }
    }
    const order = new Map(this.files.map((f, i) => [f.path, i] as const));
    const candidates = this.files.filter((file) => {
      if (this.priority(file.path) === 3) return false;
      if (this.settle(file)) return false;
      if (this.inflight.has(this.key(file.path))) return false;
      const e = this.cache.get(this.key(file.path));
      return !e || e.rev !== file.rev || e.state.state === "idle";
    });
    candidates.sort((a, b) => this.priority(a.path) - this.priority(b.path) || (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
    for (const file of candidates) {
      if (this.inflight.size >= PATCH_CONCURRENCY) break;
      this.start(file);
    }
  }

  /** A binary file has no patch to ask for. */
  private settle(file: DiffFileEntry): boolean {
    if (!file.binary) return false;
    const e = this.cache.get(this.key(file.path));
    if (e?.rev !== file.rev || e.state.state !== "binary") {
      this.cache.set(this.key(file.path), { rev: file.rev, state: { state: "binary" }, threw: false });
      this.publish();
    }
    return true;
  }

  private start(file: DiffFileEntry): void {
    const ws = this.ws;
    const id = this.key(file.path, ws);
    const before = this.cache.get(id);
    const previous = before ? patchOf(before.state) : null;
    const keep = previous === null ? {} : { patch: previous };
    const controller = new AbortController();
    this.inflight.set(id, { rev: file.rev, controller });
    this.cache.set(id, { rev: file.rev, state: { state: "loading", ...keep }, threw: false });
    this.publish();
    const done = (state: PatchState, threw = false) => {
      if (this.inflight.get(id)?.controller !== controller) return; // superseded
      this.inflight.delete(id);
      this.cache.set(id, { rev: file.rev, state, threw });
      this.publish();
      this.pump();
    };
    fetchRunDiff(this.runId, { threadId: this.threadId, file: file.path, ...(ws ? { ignoreWhitespace: true } : {}) }, controller.signal).then(
      (res) => {
        if (controller.signal.aborted) return;
        if (!res.available) return done({ state: "error", message: reviewReason(res.reason), retryable: res.reason === "busy" || res.reason === "timeout", ...keep });
        const shown = /^@@ /m.test(res.patch);
        done(res.truncated ? { state: "truncated", patch: shown ? res.patch : null, message: shown ? TRUNCATED_NOTE : NONE_SHOWN_NOTE } : { state: "ready", patch: res.patch });
      },
      (err: unknown) => {
        if (isAbort(err) || controller.signal.aborted) return;
        done({ state: "error", message: "Couldn't load this diff.", retryable: true, ...keep }, true);
      },
    );
  }
}

export interface UseRunCheckpointPatchesArgs {
  threadId: string;
  runId: string;
  /** The checkpoint's files as entries; null when the run is not read from a checkpoint (nothing is fetched). */
  files: DiffFileEntry[] | null;
  unfolded: ReadonlySet<string>;
  near: ReadonlySet<string>;
  revealPath: string | null;
  /** Ask for `git diff -w` of the snapshots (`w=1`); the caller only sets it while they are live. */
  ignoreWhitespace: boolean;
  /**
   * A request that throws pauses the fetching (the panel shows the journal instead and offers Retry) when a journal list
   * exists to fall back to. With none, the files stay and each fails and retries on its own.
   */
  pauseOnFailure: boolean;
}

export interface RunCheckpointPatches {
  patchFor: (path: string) => PatchState;
  /** A request threw: the exact diff could not be loaded. */
  failed: boolean;
  retry: (path: string) => void;
  retryFailed: () => void;
}

export function useRunCheckpointPatches(args: UseRunCheckpointPatchesArgs): RunCheckpointPatches {
  const { threadId, runId, files, unfolded, near, revealPath, ignoreWhitespace, pauseOnFailure } = args;
  const engineRef = useRef<RunPatchEngine | null>(null);
  engineRef.current ??= new RunPatchEngine();
  const engine = engineRef.current;
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  useEffect(() => {
    engine.target(threadId, runId);
  }, [engine, threadId, runId]);
  useEffect(() => () => engine.dispose(), [engine]);
  useEffect(() => {
    engine.setIgnoreWhitespace(ignoreWhitespace);
  }, [engine, ignoreWhitespace]);
  useEffect(() => {
    engine.setFiles(files ?? []);
  }, [engine, files]);
  const paused = pauseOnFailure && snap.failed;
  useEffect(() => {
    engine.want(!paused && files !== null ? { unfolded, near, reveal: revealPath } : NO_WANTS);
  }, [engine, paused, files, unfolded, near, revealPath]);

  const revOf = useMemo(() => new Map((files ?? []).map((f) => [f.path, f.rev] as const)), [files]);
  const patchFor = useMemo(
    () =>
      (path: string): PatchState => {
        const e = snap.entries.get(path);
        if (!e) return IDLE;
        const rev = revOf.get(path);
        if (rev !== undefined && e.rev !== rev && (e.state.state === "ready" || e.state.state === "truncated") && e.state.patch !== null) return { state: "loading", patch: e.state.patch };
        return e.state;
      },
    [snap.entries, revOf],
  );
  const retry = useMemo(() => (path: string) => engine.retry(path), [engine]);
  const retryFailed = useMemo(() => () => engine.retryFailed(), [engine]);
  return { patchFor, failed: snap.failed, retry, retryFailed };
}
