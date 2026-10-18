// Pattern from T3 Code apps/web/src/components/diffs/useReviewFilePatches.ts @ 3a4d118a518a (MIT, see
// THIRD_PARTY.md): the same job (a file list, then each file's patch only when asked for, a refresh that
// refetches only what changed, a retry per file). T3 does it with Effect atoms over RPC and asks for four files
// at a time as the list settles. Sightr does it with a small engine over plain fetches to T26's routes
// (`lib/diffApi.ts`): at most `PATCH_CONCURRENCY` patch requests in flight, a file fetched when it is unfolded
// or its header is near the viewport (revealed and unfolded files first), the summary refreshed with
// `If-None-Match` so an unchanged diff costs a 304, and a changed one keeps the old patches on screen while the
// visible files refetch (stale-while-revalidate, no flash). A scope change or an unmount aborts everything.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import type { ReviewDiffPreview } from "@shared/v2/review";

import { fetchDiffFilePatch, fetchDiffSummary, type DiffRequestScope } from "@/lib/diffApi";
import { scopeKey, type DiffScope } from "@/diffPanelStore";

import { reviewReason } from "./diffReasons";
import { entryFromStat, IDLE, patchOf, type DiffFileEntry, type PatchState } from "./diffTypes";

/** At most this many patch requests are ever in flight. */
export const PATCH_CONCURRENCY = 4;

type Preview = Extract<ReviewDiffPreview, { available: true }>;

export type SummaryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: Preview; files: DiffFileEntry[] }
  /** `reason` is T26's code (`not-a-repo`, `bad-base`, ...); `reviewReason` words it. */
  | { status: "unavailable"; reason: string }
  | { status: "error" };

interface Entry {
  /** The file's `rev` this state was fetched for. */
  rev: string;
  state: PatchState;
}

export interface PatchSnapshot {
  summary: SummaryState;
  entries: ReadonlyMap<string, Entry>;
}

export interface Wants {
  unfolded: ReadonlySet<string>;
  near: ReadonlySet<string>;
  reveal: string | null;
}

const NO_WANTS: Wants = { unfolded: new Set(), near: new Set(), reveal: null };
const isAbort = (err: unknown) => (err as { name?: string } | null)?.name === "AbortError";

export function requestScope(scope: Exclude<DiffScope, { kind: "run" }>): DiffRequestScope {
  return scope.kind === "workingTree" ? { kind: "working-tree" } : { kind: "branch", ...(scope.baseRef ? { base: scope.baseRef } : {}) };
}

const TRUNCATED_NOTE = "This file's diff is longer than the host will send, so only the first part is shown. Counts include everything.";
const TOO_LARGE_NOTE = "This file is too large to show here.";

/** The engine behind {@link useDiffFilePatches}: plain TypeScript, so it is tested without React. */
export class PatchEngine {
  private snap: PatchSnapshot = { summary: { status: "idle" }, entries: new Map() };
  private listeners = new Set<() => void>();
  private folder: string | null = null;
  private scope: Exclude<DiffScope, { kind: "run" }> | null = null;
  private key = "";
  private hash: string | null = null;
  private wants: Wants = NO_WANTS;
  private summaryAbort: AbortController | null = null;
  private inflight = new Map<string, { rev: string; controller: AbortController }>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): PatchSnapshot => this.snap;

  /** Requests in flight right now (the cap is {@link PATCH_CONCURRENCY}). */
  get inFlight(): number {
    return this.inflight.size;
  }

  private set(next: Partial<PatchSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of this.listeners) l();
  }
  private setEntry(path: string, entry: Entry): void {
    const entries = new Map(this.snap.entries);
    entries.set(path, entry);
    this.set({ entries });
  }

  private abortAll(): void {
    this.summaryAbort?.abort();
    this.summaryAbort = null;
    for (const f of this.inflight.values()) f.controller.abort();
    this.inflight.clear();
  }

  /** Point the engine at a folder and scope. A different target drops everything and starts the file list. */
  target(folder: string | null, scope: Exclude<DiffScope, { kind: "run" }> | null): void {
    const key = folder && scope ? `${folder}\0${scopeKey(scope)}` : "";
    if (key === this.key) return;
    this.abortAll();
    this.key = key;
    this.folder = folder;
    this.scope = scope;
    this.hash = null;
    this.snap = { summary: key ? { status: "loading" } : { status: "idle" }, entries: new Map() };
    for (const l of this.listeners) l();
    if (key) void this.refresh();
  }

  /** Ask for the file list again (the Refresh button, a run ending, the page coming back). */
  async refresh(): Promise<void> {
    if (!this.folder || !this.scope) return;
    this.summaryAbort?.abort();
    const controller = new AbortController();
    this.summaryAbort = controller;
    const key = this.key;
    try {
      const res = await fetchDiffSummary(this.folder, requestScope(this.scope), { ifNoneMatch: this.hash, signal: controller.signal });
      if (controller.signal.aborted || key !== this.key) return;
      this.summaryAbort = null;
      if (res.notModified) {
        if (this.snap.summary.status !== "ready") this.set({ summary: { status: "loading" } });
        return;
      }
      const preview = res.preview;
      if (!preview.available) {
        this.hash = null;
        this.set({ summary: { status: "unavailable", reason: preview.reason }, entries: new Map() });
        return;
      }
      this.hash = preview.diffHash;
      const files = preview.files.map(entryFromStat);
      const present = new Set(files.map((f) => f.path));
      const entries = new Map([...this.snap.entries].filter(([path]) => present.has(path)));
      this.set({ summary: { status: "ready", preview, files }, entries });
      this.pump();
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted || key !== this.key) return;
      this.summaryAbort = null;
      // Keep what is on screen when the list was already there; otherwise say so.
      if (this.snap.summary.status !== "ready") this.set({ summary: { status: "error" } });
    }
  }

  /** Which files should have a patch: unfolded ones, ones near the viewport, and the revealed one. */
  want(wants: Wants): void {
    this.wants = wants;
    this.pump();
  }

  /** Fetch a file again, after an error. */
  retry(path: string): void {
    if (this.snap.entries.has(path)) this.setEntry(path, { rev: "", state: IDLE });
    this.pump();
  }

  /** Unmount (or a StrictMode rehearsal of one): abort everything and forget the target, so `target()` starts afresh. */
  dispose(): void {
    this.abortAll();
    this.key = "";
    this.folder = null;
    this.scope = null;
    this.hash = null;
    this.snap = { summary: { status: "idle" }, entries: new Map() };
  }

  private priority(path: string): number {
    const { reveal, unfolded, near } = this.wants;
    return path === reveal ? 0 : unfolded.has(path) ? 1 : near.has(path) ? 2 : 3;
  }

  private pump(): void {
    const summary = this.snap.summary;
    if (summary.status !== "ready" || !this.folder || !this.scope) return;
    const byPath = new Map(summary.files.map((f) => [f.path, f] as const));
    // A request for a file that changed again, or that is gone, is no use any more. Its entry keeps the old
    // patch and the old rev, so the file is fetched again (rev differs) when it is wanted.
    for (const [path, f] of this.inflight) {
      const file = byPath.get(path);
      if (!file || file.rev !== f.rev) {
        f.controller.abort();
        this.inflight.delete(path);
      }
    }
    const order = new Map(summary.files.map((f, i) => [f.path, i] as const));
    const candidates: DiffFileEntry[] = [];
    for (const file of summary.files) {
      if (this.priority(file.path) === 3) continue;
      if (this.settle(file)) continue;
      if (this.needsFetch(file)) candidates.push(file);
    }
    candidates.sort((a, b) => this.priority(a.path) - this.priority(b.path) || (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
    for (const file of candidates) {
      if (this.inflight.size >= PATCH_CONCURRENCY) break;
      this.start(file, summary.preview);
    }
  }

  /** A file the host will not send a patch for has its state set outright. True when it did. */
  private settle(file: DiffFileEntry): boolean {
    const existing = this.snap.entries.get(file.path);
    if (file.binary) {
      if (existing?.rev !== file.rev || existing.state.state !== "binary") this.setEntry(file.path, { rev: file.rev, state: { state: "binary" } });
      return true;
    }
    if (file.tooLarge) {
      if (existing?.rev !== file.rev || existing.state.state !== "truncated") this.setEntry(file.path, { rev: file.rev, state: { state: "truncated", patch: null, message: TOO_LARGE_NOTE } });
      return true;
    }
    return false;
  }

  private needsFetch(file: DiffFileEntry): boolean {
    if (this.inflight.has(file.path)) return false;
    const e = this.snap.entries.get(file.path);
    return !e || e.state.state === "idle" || e.rev !== file.rev;
  }

  private start(file: DiffFileEntry, preview: Preview): void {
    const folder = this.folder as string;
    const scope = requestScope(this.scope as Exclude<DiffScope, { kind: "run" }>);
    const before = this.snap.entries.get(file.path);
    const previousPatch = before ? patchOf(before.state) : null;
    const controller = new AbortController();
    this.inflight.set(file.path, { rev: file.rev, controller });
    this.setEntry(file.path, { rev: file.rev, state: { state: "loading", ...(previousPatch === null ? {} : { patch: previousPatch }) } });
    const keep = previousPatch === null ? {} : { patch: previousPatch };
    const done = (state: PatchState) => {
      if (this.inflight.get(file.path)?.controller !== controller) return; // superseded
      this.inflight.delete(file.path);
      this.setEntry(file.path, { rev: file.rev, state });
      this.pump();
    };
    fetchDiffFilePatch(folder, scope, file, { ...(preview.from === undefined ? {} : { from: preview.from }), ...(preview.to === undefined ? {} : { to: preview.to }) }, controller.signal).then(
      (res) => {
        if (controller.signal.aborted) return;
        if (!res.available) return done({ state: "error", message: reviewReason(res.reason), retryable: true, ...keep });
        done(res.truncated ? { state: "truncated", patch: res.patch, message: TRUNCATED_NOTE } : { state: "ready", patch: res.patch });
      },
      (err: unknown) => {
        if (isAbort(err) || controller.signal.aborted) return;
        done({ state: "error", message: "Couldn't load this diff.", retryable: true, ...keep });
      },
    );
  }
}

export interface UseDiffFilePatchesArgs {
  /** The thread's Files folder; undefined while it loads, null when there is none. */
  folderPath: string | null | undefined;
  /** The working tree or a branch. Null: nothing is fetched (a run reads the thread stream instead). */
  scope: Exclude<DiffScope, { kind: "run" }> | null;
  unfolded: ReadonlySet<string>;
  near: ReadonlySet<string>;
  revealPath: string | null;
  /** Bump to ask for the file list again. */
  refreshToken: number;
}

export interface DiffFilePatches {
  summary: SummaryState;
  files: DiffFileEntry[];
  patchFor: (path: string) => PatchState;
  retry: (path: string) => void;
}

const NO_FILES: DiffFileEntry[] = [];

export function useDiffFilePatches(args: UseDiffFilePatchesArgs): DiffFilePatches {
  const { folderPath, scope, unfolded, near, revealPath, refreshToken } = args;
  const engineRef = useRef<PatchEngine | null>(null);
  engineRef.current ??= new PatchEngine();
  const engine = engineRef.current;
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  const folder = folderPath ?? null;
  const scopeId = scope ? scopeKey(scope) : "";
  // The scope's key is its identity: a new object with the same key must not restart the engine.
  const target = useMemo(() => scope, [scopeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    engine.target(folder, target);
  }, [engine, folder, target]);
  useEffect(() => () => engine.dispose(), [engine]);

  // The refresh token changes after the first render; the first value is the initial fetch `target` made.
  const firstToken = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken === firstToken.current) return;
    firstToken.current = refreshToken;
    void engine.refresh();
  }, [engine, refreshToken]);

  useEffect(() => {
    engine.want({ unfolded, near, reveal: revealPath });
  }, [engine, unfolded, near, revealPath]);

  const files = snap.summary.status === "ready" ? snap.summary.files : NO_FILES;
  const patchFor = useMemo(() => {
    const revOf = new Map(files.map((f) => [f.path, f.rev] as const));
    return (path: string): PatchState => {
      const e = snap.entries.get(path);
      if (!e) return IDLE;
      // A newer list says the file changed: until its refetch lands, the old patch stays and is marked as loading.
      const rev = revOf.get(path);
      if (rev !== undefined && e.rev !== rev && (e.state.state === "ready" || e.state.state === "truncated") && e.state.patch !== null) return { state: "loading", patch: e.state.patch };
      return e.state;
    };
  }, [snap.entries, files]);
  const retry = useMemo(() => (path: string) => engine.retry(path), [engine]);
  return { summary: snap.summary, files, patchFor, retry };
}
