// Pattern from T3 Code apps/web/src/components/diffs/useReviewFilePatches.ts @ 3a4d118a518a (MIT, see
// THIRD_PARTY.md): the same job (a file list, then each file's patch only when asked for, a refresh that
// refetches only what changed, a retry per file). T3 does it with Effect atoms over RPC and asks for four files
// at a time as the list settles. Sightr does it with a small engine over plain fetches to T26's routes
// (`lib/diffApi.ts`): at most `PATCH_CONCURRENCY` patch requests in flight, a file fetched when it is unfolded
// or its header is near the viewport (revealed and unfolded files first), the summary refreshed with
// `If-None-Match` so an unchanged diff costs a 304, and a changed one keeps the old patches on screen while the
// visible files refetch (stale-while-revalidate, no flash). A scope change or an unmount aborts everything.
// T28: ignore-whitespace is a second variant of the same state (its own list, hash and patches, fetched with
// `ignoreWhitespace=1`); both stay cached for the session, so toggling back costs no request unless a
// refresh happened meanwhile (the other variant is then marked stale and asked again, with `If-None-Match`).
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
  /** `plainMissing`: under -w, the plain list (which supplies the whitespace-only files) failed or is unavailable, so those files are not listed. */
  | { status: "ready"; preview: Preview; files: DiffFileEntry[]; plainMissing?: true }
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

export function requestScope(scope: Exclude<DiffScope, { kind: "run" }>, ignoreWhitespace = false): DiffRequestScope {
  const ws = ignoreWhitespace ? { ignoreWhitespace: true } : {};
  return scope.kind === "workingTree" ? { kind: "working-tree", ...ws } : { kind: "branch", ...(scope.baseRef ? { base: scope.baseRef } : {}), ...ws };
}

/** One whitespace variant of the engine's state. */
interface Variant {
  snap: PatchSnapshot;
  /** The files exactly as this variant's list sent them (`snap.summary.files` may add whitespace-only files under -w). */
  raw: DiffFileEntry[] | null;
  hash: string | null;
  /** The other variant was refreshed since this one was last read: ask again (a 304 if nothing moved) when it is switched to. */
  stale: boolean;
  summaryAbort: AbortController | null;
}
const freshVariant = (): Variant => ({ snap: { summary: { status: "idle" }, entries: new Map() }, raw: null, hash: null, stale: false, summaryAbort: null });

/**
 * Under `-w` the host drops a file whose only changes are whitespace from its list (git lists nothing for it), so the tree
 * would lose a row when the toggle is turned on. The plain list still has it: keep it, marked `whitespaceOnly` with 0/0 and no
 * patch to ask for, in the plain list's order. This is the list only; no patch is ever edited on the client.
 */
export function withWhitespaceOnly(plain: readonly DiffFileEntry[], ws: readonly DiffFileEntry[]): DiffFileEntry[] {
  const mine = new Map(ws.map((f) => [f.path, f] as const));
  const out: DiffFileEntry[] = [];
  const used = new Set<string>();
  for (const f of plain) {
    const hit = mine.get(f.path);
    if (hit) {
      out.push(hit);
      used.add(f.path);
    } else if (f.kind === "modified" && !f.binary && !f.tooLarge) out.push({ ...f, added: 0, removed: 0, whitespaceOnly: true, rev: `${f.rev}:w` });
  }
  for (const f of ws) if (!used.has(f.path)) out.push(f);
  return out;
}
type Ws = 0 | 1;

const TRUNCATED_NOTE = "This file's diff is longer than the host will send, so only the first part is shown. Counts include everything.";
const NONE_SHOWN_NOTE = "This file's diff is longer than the host will send, so none of it is shown here. Counts include everything.";
const TOO_LARGE_NOTE = "This file is too large to show here.";

/** The engine behind {@link useDiffFilePatches}: plain TypeScript, so it is tested without React. */
export class PatchEngine {
  private variants: [Variant, Variant] = [freshVariant(), freshVariant()];
  private ws: Ws = 0;
  private listeners = new Set<() => void>();
  private folder: string | null = null;
  private scope: Exclude<DiffScope, { kind: "run" }> | null = null;
  private key = "";
  private wants: Wants = NO_WANTS;
  private inflight = new Map<string, { w: Ws; path: string; rev: string; controller: AbortController }>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): PatchSnapshot => (this.variants[this.ws] as Variant).snap;

  /** Requests in flight right now (the cap is {@link PATCH_CONCURRENCY}). */
  get inFlight(): number {
    return this.inflight.size;
  }

  private get cur(): Variant {
    return this.variants[this.ws] as Variant;
  }
  private notify(): void {
    for (const l of this.listeners) l();
  }
  private setIn(w: Ws, next: Partial<PatchSnapshot>): void {
    const v = this.variants[w] as Variant;
    v.snap = { ...v.snap, ...next };
    this.notify();
  }
  private setEntry(w: Ws, path: string, entry: Entry): void {
    const entries = new Map((this.variants[w] as Variant).snap.entries);
    entries.set(path, entry);
    this.setIn(w, { entries });
  }

  private abortAll(): void {
    for (const v of this.variants) {
      v.summaryAbort?.abort();
      v.summaryAbort = null;
    }
    for (const f of this.inflight.values()) f.controller.abort();
    this.inflight.clear();
  }

  /** Point the engine at a folder and scope. A different target drops everything and starts the file list. */
  target(folder: string | null, scope: Exclude<DiffScope, { kind: "run" }> | null, ignoreWhitespace = false): void {
    const key = folder && scope ? `${folder}\0${scopeKey(scope)}` : "";
    if (key === this.key) return;
    this.abortAll();
    this.key = key;
    this.folder = folder;
    this.scope = scope;
    this.ws = ignoreWhitespace ? 1 : 0;
    this.variants = [freshVariant(), freshVariant()];
    if (key) this.cur.snap = { summary: { status: "loading" }, entries: new Map() };
    this.notify();
    if (key) {
      void this.load(this.ws, false);
      // The whitespace variant lists whitespace-only files from the plain list, so a start in that mode reads both.
      if (this.ws === 1) void this.load(0, false);
    }
  }

  /**
   * Show the whitespace-ignoring variant (or not). The variant already read is shown at once and costs no request;
   * one never read is fetched, and one the other variant's refresh left behind is asked again (a 304 when unchanged).
   */
  setIgnoreWhitespace(on: boolean): void {
    const ws: Ws = on ? 1 : 0;
    if (ws === this.ws) return;
    this.ws = ws;
    this.notify();
    if (!this.key) return;
    const v = this.cur;
    if (v.snap.summary.status === "idle" || v.stale || v.snap.summary.status === "error") {
      if (v.snap.summary.status === "idle") v.snap = { ...v.snap, summary: { status: "loading" } };
      void this.load(ws, false);
      if (ws === 1 && this.variants[0].snap.summary.status === "idle") void this.load(0, false);
    } else this.pump();
  }

  /** Ask for the file list again (the Refresh button, a run ending, the page coming back). */
  refresh(): Promise<void> {
    const w = this.ws;
    // A refresh in the whitespace variant reads the plain list too (it supplies the whitespace-only files).
    if (w === 1) void this.load(0, false);
    return this.load(w, w === 0);
  }

  /** The plain list could not be had (failed, busy, not a repo): the whitespace variant cannot list whitespace-only files. */
  private plainFailed(): boolean {
    const status = this.variants[0].snap.summary.status;
    return status === "error" || status === "unavailable";
  }

  private mergedWs(raw: DiffFileEntry[]): DiffFileEntry[] {
    const plain = this.variants[0];
    return plain.raw && plain.snap.summary.status === "ready" ? withWhitespaceOnly(plain.raw, raw) : raw;
  }

  /** The plain list changed: the whitespace variant's whitespace-only files follow it. */
  private remergeWs(): void {
    const v = this.variants[1];
    if (!v.raw || v.snap.summary.status !== "ready") return;
    const files = this.mergedWs(v.raw);
    const key = (list: readonly DiffFileEntry[]) => list.map((f) => `${f.path}\0${f.rev}`).join("\n");
    const missing = this.plainFailed();
    if (key(files) === key(v.snap.summary.files) && missing === (v.snap.summary.plainMissing === true)) return;
    const present = new Set(files.map((f) => f.path));
    const { plainMissing: _was, ...rest } = v.snap.summary;
    void _was;
    this.setIn(1, { summary: { ...rest, files, ...(missing ? { plainMissing: true as const } : {}) }, entries: new Map([...v.snap.entries].filter(([path]) => present.has(path))) });
    if (this.ws === 1) this.pump();
  }

  private async load(w: Ws, markOther: boolean): Promise<void> {
    if (!this.folder || !this.scope) return;
    const v = this.variants[w] as Variant;
    v.summaryAbort?.abort();
    v.stale = false;
    const other = this.variants[w === 0 ? 1 : 0] as Variant;
    if (markOther && other.snap.summary.status === "ready") other.stale = true;
    const controller = new AbortController();
    v.summaryAbort = controller;
    const key = this.key;
    try {
      const res = await fetchDiffSummary(this.folder, requestScope(this.scope, w === 1), { ifNoneMatch: v.hash, signal: controller.signal });
      if (controller.signal.aborted || key !== this.key) return;
      v.summaryAbort = null;
      if (res.notModified) {
        if (v.snap.summary.status !== "ready") this.setIn(w, { summary: { status: "loading" } });
        return;
      }
      const preview = res.preview;
      if (!preview.available) {
        v.hash = null;
        this.setIn(w, { summary: { status: "unavailable", reason: preview.reason }, entries: new Map() });
        if (w === 0) this.remergeWs();
        return;
      }
      v.hash = preview.diffHash;
      v.raw = preview.files.map(entryFromStat);
      const files = w === 1 ? this.mergedWs(v.raw) : v.raw;
      const present = new Set(files.map((f) => f.path));
      const entries = new Map([...v.snap.entries].filter(([path]) => present.has(path)));
      this.setIn(w, { summary: { status: "ready", preview, files, ...(w === 1 && this.plainFailed() ? { plainMissing: true as const } : {}) }, entries });
      if (w === 0) this.remergeWs();
      if (w === this.ws) this.pump();
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted || key !== this.key) return;
      v.summaryAbort = null;
      // Keep what is on screen when the list was already there; otherwise say so.
      if (v.snap.summary.status !== "ready") this.setIn(w, { summary: { status: "error" } });
      if (w === 0) this.remergeWs();
    }
  }

  /** Which files should have a patch: unfolded ones, ones near the viewport, and the revealed one. */
  want(wants: Wants): void {
    this.wants = wants;
    this.pump();
  }

  /** Fetch a file again, after an error. */
  retry(path: string): void {
    if (this.cur.snap.entries.has(path)) this.setEntry(this.ws, path, { rev: "", state: IDLE });
    this.pump();
  }

  /** Unmount (or a StrictMode rehearsal of one): abort everything and forget the target, so `target()` starts afresh. */
  dispose(): void {
    this.abortAll();
    this.key = "";
    this.folder = null;
    this.scope = null;
    this.ws = 0;
    this.variants = [freshVariant(), freshVariant()];
  }

  private priority(path: string): number {
    const { reveal, unfolded, near } = this.wants;
    return path === reveal ? 0 : unfolded.has(path) ? 1 : near.has(path) ? 2 : 3;
  }

  private pump(): void {
    const w = this.ws;
    const summary = this.cur.snap.summary;
    if (summary.status !== "ready" || !this.folder || !this.scope) return;
    const byPath = new Map(summary.files.map((f) => [f.path, f] as const));
    // A request for a file that changed again, or that is gone, is no use any more. Its entry keeps the old
    // patch and the old rev, so the file is fetched again (rev differs) when it is wanted.
    for (const [id, f] of this.inflight) {
      if (f.w !== w) continue;
      const file = byPath.get(f.path);
      if (!file || file.rev !== f.rev) {
        f.controller.abort();
        this.inflight.delete(id);
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
    const w = this.ws;
    const existing = this.cur.snap.entries.get(file.path);
    if (file.binary) {
      if (existing?.rev !== file.rev || existing.state.state !== "binary") this.setEntry(w, file.path, { rev: file.rev, state: { state: "binary" } });
      return true;
    }
    if (file.tooLarge) {
      if (existing?.rev !== file.rev || existing.state.state !== "truncated") this.setEntry(w, file.path, { rev: file.rev, state: { state: "truncated", patch: null, message: TOO_LARGE_NOTE } });
      return true;
    }
    // Ignoring whitespace left nothing of this file to show: the host said so in the list, so no patch is asked for.
    if (file.whitespaceOnly) {
      if (existing?.rev !== file.rev || existing.state.state !== "ready") this.setEntry(w, file.path, { rev: file.rev, state: { state: "ready", patch: "" } });
      return true;
    }
    return false;
  }

  private needsFetch(file: DiffFileEntry): boolean {
    if (this.inflight.has(`${this.ws}\0${file.path}`)) return false;
    const e = this.cur.snap.entries.get(file.path);
    return !e || e.state.state === "idle" || e.rev !== file.rev;
  }

  private start(file: DiffFileEntry, preview: Preview): void {
    const w = this.ws;
    const id = `${w}\0${file.path}`;
    const folder = this.folder as string;
    const scope = requestScope(this.scope as Exclude<DiffScope, { kind: "run" }>, w === 1);
    const before = this.cur.snap.entries.get(file.path);
    const previousPatch = before ? patchOf(before.state) : null;
    const controller = new AbortController();
    this.inflight.set(id, { w, path: file.path, rev: file.rev, controller });
    this.setEntry(w, file.path, { rev: file.rev, state: { state: "loading", ...(previousPatch === null ? {} : { patch: previousPatch }) } });
    const keep = previousPatch === null ? {} : { patch: previousPatch };
    const done = (state: PatchState) => {
      if (this.inflight.get(id)?.controller !== controller) return; // superseded
      this.inflight.delete(id);
      this.setEntry(w, file.path, { rev: file.rev, state });
      this.pump();
    };
    fetchDiffFilePatch(folder, scope, file, { ...(preview.from === undefined ? {} : { from: preview.from }), ...(preview.to === undefined ? {} : { to: preview.to }) }, controller.signal).then(
      (res) => {
        if (controller.signal.aborted) return;
        if (!res.available) return done({ state: "error", message: reviewReason(res.reason), retryable: true, ...keep });
        // A diff cut inside its first hunk has nothing whole to show (the host keeps whole hunks).
        const shown = /^@@ /m.test(res.patch);
        done(res.truncated ? { state: "truncated", patch: shown ? res.patch : null, message: shown ? TRUNCATED_NOTE : NONE_SHOWN_NOTE } : { state: "ready", patch: res.patch });
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
  /** Ask the host for `git diff -w` (T28). Both variants stay cached, so flipping this back is instant. */
  ignoreWhitespace?: boolean;
}

export interface DiffFilePatches {
  summary: SummaryState;
  files: DiffFileEntry[];
  patchFor: (path: string) => PatchState;
  retry: (path: string) => void;
}

const NO_FILES: DiffFileEntry[] = [];

export function useDiffFilePatches(args: UseDiffFilePatchesArgs): DiffFilePatches {
  const { folderPath, scope, unfolded, near, revealPath, refreshToken, ignoreWhitespace = false } = args;
  const engineRef = useRef<PatchEngine | null>(null);
  engineRef.current ??= new PatchEngine();
  const engine = engineRef.current;
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);

  const folder = folderPath ?? null;
  const scopeId = scope ? scopeKey(scope) : "";
  // The scope's key is its identity: a new object with the same key must not restart the engine.
  const target = useMemo(() => scope, [scopeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    engine.target(folder, target, ignoreWhitespace);
  }, [engine, folder, target]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => engine.dispose(), [engine]);
  // A flip of the flag switches variants; the target above takes the flag it starts with.
  useEffect(() => {
    engine.setIgnoreWhitespace(ignoreWhitespace);
  }, [engine, ignoreWhitespace]);

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
