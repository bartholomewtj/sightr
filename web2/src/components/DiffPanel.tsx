// Pattern from T3 Code apps/web/src/components/DiffPanel.tsx @ 3a4d118a518a (MIT, see THIRD_PARTY.md). T3 has
// one diff panel for the whole app: a branch or unstaged toggle, a run's own diff, a Pierre `CodeView` over
// every file, an Effect-atom read per file. Sightr's is a right-panel tab (`diff`, opened by `mod+d` or
// from the Git tab and a run's changed-files card) written against the `DiffCodeView` seam (T25) and plain
// fetches to the bridge (T26):
//   - scope: the working tree, the branch against a base, or one run: T31 reads the run's checkpoint when it has a ready one
//     (the list is on the run, each patch comes from T30's `scope=run` route, badge "Exact"), else the thread's journal;
//   - a changed-files tree (our own `role="tree"`), and one section per file, unfolded to fetch its patch;
//   - at most 4 patch requests at once, only for files that are unfolded or near the screen;
//   - phone (a sheet, one column): the tree folds open and shut under a "Files · 12 · +230 -41" header;
//     desktop, when the panel itself is 600 px wide or more: the tree is a left column;
//   - refresh on the button, when the run ends, and when the page comes back (the Git tab's triggers).
// Read-only: no staging, commit, revert or rollback. T28 adds the reading aids: split view (a wide desktop column
// only), ignore whitespace (the host's `git diff -w`, never a client-side edit of a patch) and expand unchanged
// lines (the host's whole-file route, asked for on the first tap of a control). Line comments (T29): tapping a line
// number starts a comment that is kept in a pending list (a "Comments N" button here opens it in place of the files);
// "Add to message" puts it in the composer as quoted text.
//
// The diffs mount in windows (hand renderer), so two things are said in the panel, not hidden: the
// browser's find (Ctrl+F) sees only lines already drawn, and the scroll position comes back to a file
// and an offset into it, not to an exact line.
import { ChevronRightIcon, ChevronsDownUpIcon, Columns2Icon, MessageSquareIcon, PanelLeftIcon, PilcrowIcon, RotateCwIcon, Rows2Icon, WrapTextIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { deriveRunChangedFilesFromItems } from "@/components/chat/ChangedFiles.logic";
import { ChangedFilesSnapshotNotes } from "@/components/chat/ChangedFilesSnapshotNotes";
import { ChangedFilesSourceBadge } from "@/components/chat/ChangedFilesSourceBadge";
import { DiffStatLabel } from "@/components/chat/DiffStatLabel";
import { useRunChanges } from "@/components/chat/useRunChanges";
import { showToast } from "@/components/toast";
import { samePath } from "@/lib/runChanges";
import { useLayout } from "@/hooks/useLayout";
import { useDiffPanelStore, useDiffScope, type DiffScope } from "@/diffPanelStore";
import { DiffContentsCache } from "@/lib/diffFileContents";
import { useDiffFileList, useDiffIgnoreWhitespace, useDiffLayout, useDiffWrap, useRightPanelStore } from "@/rightPanelStore";
import { useSidebarThread } from "@/state/sidebar";
import { useBridgeInfo, useThread } from "@/stream/stores";
import { revealCommentLine, setCommentsListOpen, setOpenEditor, useCommentsListOpen } from "@/state/commentsUi";
import { markMissingFiles, useLineComments, type LineComment } from "@/state/lineComments";

import { DiffPanelLoadingState, DiffPanelMessage, DiffPanelShell } from "./DiffPanelShell";
import { baseExists, useDiffBranches } from "./diffs/DiffBranchPicker";
import { DiffCommentsContext, type DiffCommentsContextValue } from "./diffs/AnnotatableCodeView";
import { DiffScrollRootContext, preloadDiffRenderer } from "./diffs/DiffCodeView";
import { LineCommentsList } from "./diffs/LineCommentsList";
import { DiffFileSection } from "./diffs/DiffFileSection";
import { DiffFileTree } from "./diffs/DiffFileTree";
import { DiffScopePicker } from "./diffs/DiffScopePicker";
import { canOpenInFiles, filesPathOf } from "./diffs/diffFileActions";
import { effectiveDiffLayout, splitAvailable } from "./diffs/diffLayout.logic";
import { diffTotals, treeOrder } from "./diffs/diffFileTree.logic";
import { repoRootPath } from "./diffs/diffRootPath";
import { attachAnchorMemory, diffMemoryKey, readAnchor, readDiffMemory, writeDiffMemory, type AnchorMemory } from "./diffs/diffPanelMemory";
import { reviewReason } from "./diffs/diffReasons";
import { IDLE, type DiffFileEntry, type PatchState } from "./diffs/diffTypes";
import { useRunOptions, useRunScopeFiles } from "./diffs/runScope";
import { requestScope, useDiffFilePatches } from "./diffs/useDiffFilePatches";
import { useRunCheckpointPatches } from "./diffs/useRunCheckpointPatches";
import { checkpointDiffState, entryOfCheckpointRow } from "./right-panel/checkpointDiffState";
import { openPrintedPath } from "./right-panel/OpenFileLink";
import { RunPicker } from "./right-panel/RunPicker";
import { useRefreshTriggers } from "./right-panel/useRefreshTriggers";
import { usePaneFolder } from "./right-panel/usePaneFolder";

/** The panel is a two-column layout (tree left, diffs right) from this width, on a desktop. */
export const DIFF_PANEL_WIDE_PX = 600;
/** Unfolded by default when there are this few files (and no file was asked for). */
export const DIFF_AUTO_UNFOLD_MAX = 3;

export function DiffPanel({ threadId }: { threadId: string }) {
  const state = useThread(threadId);
  const shellThread = useSidebarThread(threadId);
  const thread = state?.thread ?? shellThread ?? null;
  const paneId = thread?.paneId || null;
  const folder = usePaneFolder(paneId);
  const scope = useDiffScope(threadId);
  // The renderer's chunk starts loading now, so the first diff does not wait ~300 ms in the Suspense fallback.
  useEffect(() => {
    void preloadDiffRenderer();
  }, []);

  if (!thread) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  // A run reads the journal, so it needs no folder; the other scopes read the repo around it.
  if (scope.kind !== "run") {
    if (folder.filesOff) return <p className="p-4 text-sm text-muted-foreground">Files isn't turned on. Set SIGHTR_WORK_ROOT on the host.</p>;
    if (folder.path === null) return <p className="p-4 text-sm text-muted-foreground">This thread's folder is outside the Files root.</p>;
  }
  return <DiffPanelBody key={diffMemoryKey(threadId, scope)} threadId={threadId} paneId={paneId} folderPath={folder.path} scope={scope} />;
}

function DiffPanelBody({ threadId, paneId, folderPath, scope }: { threadId: string; paneId: string | null; folderPath: string | null | undefined; scope: DiffScope }) {
  const memKey = diffMemoryKey(threadId, scope);
  const layout = useLayout();
  const { refreshes, refresh } = useRefreshTriggers(threadId);
  const [wrap, setWrap] = useDiffWrap();
  const [layoutPref, setLayoutPref] = useDiffLayout();
  const [wsPref, setWsPref] = useDiffIgnoreWhitespace();
  const setScope = useDiffPanelStore((s) => s.setScope);
  const reveal = useDiffPanelStore((s) => s.reveal);
  const consumeReveal = useDiffPanelStore((s) => s.consumeReveal);

  // ── Layout: the tree is a left column when the panel itself is wide (not the viewport) ──
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    setPanelWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setPanelWidth(Math.round(entries[0]?.contentRect.width ?? el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const wide = layout === "desktop" && panelWidth >= DIFF_PANEL_WIDE_PX;

  // ── Scope: a stored base the repo no longer has falls back to the default base ──
  const [droppedBase, setDroppedBase] = useState<string | null>(null);
  const [branchesWanted, setBranchesWanted] = useState(false);
  const storedBase = scope.kind === "branch" ? scope.baseRef : undefined;
  const branches = useDiffBranches(folderPath, branchesWanted || storedBase !== undefined, refreshes);
  const baseGone = storedBase !== undefined && (droppedBase === storedBase || baseExists(branches, storedBase) === false);
  const fetchScope = useMemo<Exclude<DiffScope, { kind: "run" }> | null>(
    () => (scope.kind === "run" ? null : scope.kind === "branch" && baseGone ? { kind: "branch" } : scope),
    [scope, baseGone],
  );

  // ── Remembered state (folds, tree) ──
  const [unfolded, setUnfolded] = useState<ReadonlySet<string> | null>(() => {
    const m = readDiffMemory(memKey);
    return m.unfolded ? new Set(m.unfolded) : null;
  });
  const [treeOpen, setTreeOpen] = useState<boolean>(() => readDiffMemory(memKey).treeOpen ?? true);
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set(readDiffMemory(memKey).collapsedDirs));
  // The wide layout's file list column can be hidden (T28), per device: the panel is at most 720 px and the column takes
  // 256 of it, so split view (a 640 px diff column) is only reachable with the column hidden.
  const [treeColumn, setTreeColumn] = useDiffFileList();
  useEffect(() => {
    writeDiffMemory(memKey, { unfolded: unfolded ? [...unfolded] : null, treeOpen, collapsedDirs: [...collapsedDirs] });
  }, [memKey, unfolded, treeOpen, collapsedDirs]);

  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  const [revealPath, setRevealPath] = useState<string | null>(null);
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);

  // ── Line comments (T29) ──
  const readOnly = useBridgeInfo((s) => s.readOnly);
  const comments = useLineComments(threadId);
  const listOpen = useCommentsListOpen(threadId);
  const commentsOff = readOnly ? "Comments are off: this device is read-only." : null;
  const commentsCtx = useMemo<DiffCommentsContextValue>(() => ({ threadId, off: commentsOff, run: scope.kind === "run" }), [threadId, commentsOff, scope.kind]);

  // ── The files and their patches ──
  // A run (T31): the run's checkpoint when it has a ready one, else the journal. The list of a checkpoint is on the run
  // (`Run.checkpoint.files`), so only its patches are fetched; the journal needs no fetch at all.
  const runId = scope.kind === "run" ? scope.runId : "";
  const threadState = useThread(threadId);
  const runRecord = runId ? threadState?.runs[runId] : undefined;
  const journalSummary = useMemo(() => {
    const items = threadState?.items;
    if (!runId || !items) return null;
    return deriveRunChangedFilesFromItems(Object.values(items).filter((item) => item.runId === runId)).get(runId) ?? null;
  }, [threadState?.items, runId]);
  const changes = useRunChanges(runRecord, journalSummary);
  const exactRun = scope.kind === "run" && changes.source === "checkpoint";
  // Ignore whitespace needs the run's snapshots to exist (`w=1` is computed from them); the journal's edits cannot be re-diffed.
  const exactLive = exactRun && changes.live;
  const ignoreWs = wsPref && (scope.kind !== "run" || exactLive);
  const patches = useDiffFilePatches({
    folderPath: scope.kind === "run" ? null : folderPath,
    scope: fetchScope,
    unfolded: unfolded ?? NO_PATHS,
    near,
    revealPath,
    refreshToken: refreshes,
    ignoreWhitespace: ignoreWs && scope.kind !== "run",
  });
  const run = useRunScopeFiles(threadId, runId);
  const runs = useRunOptions(threadId);
  const runByPath = useMemo(() => new Map(run.files.map((f) => [f.entry.path, f.state] as const)), [run.files]);
  const journalEntries = useMemo(() => run.files.map((f) => f.entry), [run.files]);
  const exactFiles = useMemo(() => (exactRun ? changes.files.map(entryOfCheckpointRow) : null), [exactRun, changes.files]);
  const runPatches = useRunCheckpointPatches({
    threadId,
    runId,
    files: exactFiles,
    unfolded: unfolded ?? NO_PATHS,
    near,
    revealPath,
    ignoreWhitespace: ignoreWs && scope.kind === "run",
    pauseOnFailure: journalEntries.length > 0,
  });
  const loaded = threadState !== null;
  const diffState = useMemo(
    () => (scope.kind === "run" ? checkpointDiffState({ threadLoaded: loaded, changes, journalFiles: journalEntries, fetchFailed: runPatches.failed }) : null),
    [scope.kind, loaded, changes, journalEntries, runPatches.failed],
  );
  const exactShown = diffState?.status === "ready" && diffState.source === "checkpoint";
  const sourceFiles = useMemo(
    () => (scope.kind === "run" ? (diffState && (diffState.status === "ready" || diffState.status === "running") ? diffState.files : NO_ENTRIES) : patches.files),
    [scope.kind, diffState, patches.files],
  );
  const files = useMemo(() => treeOrder(sourceFiles), [sourceFiles]);
  const patchFor = useCallback(
    (path: string): PatchState => (scope.kind === "run" ? (exactShown ? runPatches.patchFor(path) : (runByPath.get(path) ?? IDLE)) : patches.patchFor(path)),
    [scope.kind, exactShown, runPatches, runByPath, patches],
  );
  const onRetryFile = scope.kind === "run" && exactShown ? runPatches.retry : patches.retry;
  const summary = patches.summary;
  // A list to work from: the server's, once it has answered and is available; a run's, once the thread has its items.
  const listOk = scope.kind === "run" ? diffState?.status === "ready" || diffState?.status === "running" : summary.status === "ready";
  // Nothing more is coming for a request that has failed for good, so a reveal waiting for the list is dropped then.
  const listFailed = scope.kind === "run" ? diffState?.status === "unavailable" : summary.status === "unavailable" || summary.status === "error";

  // A file the current scope does not list: its comments are outdated until it comes back.
  useEffect(() => {
    if (listOk) markMissingFiles(threadId, new Set(files.map((f) => f.path)));
  }, [listOk, files, threadId]);

  // A base the host does not know (it was deleted since): ask for the default instead.
  useEffect(() => {
    if (summary.status === "unavailable" && summary.reason === "bad-base" && storedBase !== undefined) setDroppedBase(storedBase);
  }, [summary, storedBase]);

  const defaultBase = scope.kind === "branch" && summary.status === "ready" && summary.preview.baseIsDefault ? summary.preview.base : branches.status === "ready" ? branches.data.defaultBase : undefined;

  // Unfolded by default: the revealed file (below), else every file when there are few.
  const revealPending = reveal !== null && reveal.threadId === threadId;
  // Only from a list that loaded: a failed first load must not save an empty choice in its place.
  useEffect(() => {
    if (unfolded !== null || !listOk) return;
    setUnfolded(revealPending || files.length > DIFF_AUTO_UNFOLD_MAX ? new Set() : new Set(files.map((f) => f.path)));
  }, [unfolded, listOk, files, revealPending]);

  const unfold = useCallback((path: string) => setUnfolded((prev) => (prev?.has(path) ? prev : new Set([...(prev ?? []), path]))), []);

  // A tap-through (the Git tab, a run's changed-files card): unfold the file, scroll to it once, mark it briefly.
  // The place it names wins over the place remembered from last time (`anchor`), also when that restore is still running.
  const anchor = useRef<AnchorMemory | null>(null);
  const skipRestore = useRef(false);
  useEffect(() => {
    if (!reveal || reveal.threadId !== threadId || !(listOk || listFailed)) return;
    consumeReveal(reveal.requestId);
    // A run's card may name a path the journal wrote (a folder deeper than the repo's) where the checkpoint has the repo's own.
    const hit = files.find((f) => f.path === reveal.filePath) ?? (scope.kind === "run" ? files.find((f) => samePath(reveal.filePath, f.path)) : undefined);
    if (!hit) return;
    skipRestore.current = true;
    anchor.current?.stopRestoring();
    unfold(hit.path);
    setRevealPath(hit.path);
    setPendingScroll(hit.path);
    setHighlight(hit.path);
    // Asked for a file, so the file is the point: the phone's tree folds out of the way, as when one is picked in it.
    if (!wide) setTreeOpen(false);
  }, [reveal, threadId, listOk, listFailed, files, unfold, consumeReveal, wide, scope.kind]);
  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(null), 1600);
    return () => clearTimeout(t);
  }, [highlight]);

  // Scroll to a file once it is in the DOM and unfolded (the section exists as soon as the list does).
  useEffect(() => {
    if (!pendingScroll || !scrollerEl) return;
    const el = Array.from(scrollerEl.querySelectorAll<HTMLElement>("[data-diff-file]")).find((s) => s.dataset.diffFile === pendingScroll);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    setPendingScroll(null);
  }, [pendingScroll, scrollerEl, files, unfolded]);

  // Scroll comes back to a file header plus an offset into it (windows hold estimated heights).
  useEffect(() => {
    if (!scrollerEl) return;
    const memory = attachAnchorMemory(scrollerEl, memKey, { restore: !skipRestore.current });
    anchor.current = memory;
    return () => {
      memory.detach();
      anchor.current = null;
    };
  }, [scrollerEl, memKey]);

  // Sections within 400 px of the scroller: their patch is fetched ahead (after the unfolded and revealed
  // files), so a file about to scroll in is already there. A folded file off the screen is never fetched.
  const fileKey = files.map((f) => f.path).join("\0");
  useEffect(() => {
    if (!scrollerEl || typeof IntersectionObserver === "undefined") return;
    const seen = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const e of entries) {
          const path = (e.target as HTMLElement).dataset.diffFile;
          if (!path) continue;
          if (e.isIntersecting) {
            if (!seen.has(path)) {
              seen.add(path);
              changed = true;
            }
          } else if (seen.delete(path)) changed = true;
        }
        if (changed) setNear(new Set(seen));
      },
      { root: scrollerEl, rootMargin: "400px 0px" },
    );
    scrollerEl.querySelectorAll("[data-diff-file]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [scrollerEl, fileKey]);

  // ── Split view: a desktop viewport and a diff column of 640 px (624 once split) ──
  const [columnPx, setColumnPx] = useState(0);
  useLayoutEffect(() => {
    if (!scrollerEl) return;
    setColumnPx(Math.round(scrollerEl.clientWidth));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setColumnPx(Math.round(entries[0]?.contentRect.width ?? scrollerEl.clientWidth)));
    ro.observe(scrollerEl);
    return () => ro.disconnect();
  }, [scrollerEl]);
  // Hysteresis on what is showing: a split view stays down to 624 px, a stacked one needs 640 px to offer the toggle.
  const [showingSplit, setShowingSplit] = useState(false);
  const splitOk = splitAvailable({ layout, columnPx, showingSplit });
  const shownLayout = effectiveDiffLayout(layoutPref, splitOk);
  useEffect(() => setShowingSplit(shownLayout === "split"), [shownLayout]);

  // Heights differ between layouts, so when the layout changes the file that was topmost stays topmost.
  const topFile = useRef<string | null>(null);
  useEffect(() => {
    if (!scrollerEl) return;
    let frame = 0;
    const note = () => {
      frame = 0;
      topFile.current = readAnchor(scrollerEl)?.path ?? null;
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(note);
    };
    scrollerEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scrollerEl.removeEventListener("scroll", onScroll);
    };
  }, [scrollerEl]);
  const lastLayout = useRef(shownLayout);
  useLayoutEffect(() => {
    if (lastLayout.current === shownLayout) return;
    lastLayout.current = shownLayout;
    const path = topFile.current;
    if (!path || !scrollerEl) return;
    Array.from(scrollerEl.querySelectorAll<HTMLElement>("[data-diff-file]")).find((s) => s.dataset.diffFile === path)?.scrollIntoView({ block: "start" });
  }, [shownLayout, scrollerEl]);

  // ── Expand unchanged lines: the whole file, once per file, on the first tap of a control ──
  const contents = useRef<DiffContentsCache | null>(null);
  contents.current ??= new DiffContentsCache();
  useEffect(() => () => contents.current?.dispose(), []);
  const readyPreview = summary.status === "ready" ? summary.preview : null;
  // A run read from live snapshots expands from the run route (`scope=run`, T30); the stamp stands for the list's `diffHash`.
  const runExpand = exactShown && exactLive ? { threadId, runId, stamp: String(runRecord?.checkpoint?.capturedAt ?? 0), files: sourceFiles } : null;
  const expandSource = useRef({ folderPath, scope: fetchScope, preview: readyPreview, files: patches.files, runExpand });
  expandSource.current = { folderPath, scope: fetchScope, preview: readyPreview, files: patches.files, runExpand };
  const onExpandContext = useCallback(async (filePath: string) => {
    const src = expandSource.current;
    if (src.runExpand) {
      const hit = src.runExpand.files.find((f) => f.path === filePath);
      if (!hit) return null;
      return (contents.current as DiffContentsCache).load({
        folder: "",
        scope: { kind: "run", threadId: src.runExpand.threadId, runId: src.runExpand.runId },
        diffHash: src.runExpand.stamp,
        file: { path: hit.path },
        range: {},
      });
    }
    const file = src.files.find((f) => f.path === filePath);
    if (!src.scope || src.folderPath == null || !src.preview || !file) return null;
    return (contents.current as DiffContentsCache).load({
      folder: src.folderPath,
      scope: requestScope(src.scope),
      diffHash: src.preview.diffHash,
      file: { path: file.path, ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }) },
      range: { ...(src.preview.from === undefined ? {} : { from: src.preview.from }), ...(src.preview.to === undefined ? {} : { to: src.preview.to }) },
    });
  }, []);
  const canExpand = scope.kind === "run" ? runExpand !== null : folderPath != null;

  // ── Actions ──
  const onToggle = useCallback((path: string) => setUnfolded((prev) => {
    const next = new Set(prev ?? []);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  }), []);
  const onSelect = useCallback(
    (path: string) => {
      unfold(path);
      setPendingScroll(path);
      if (!wide) setTreeOpen(false);
    },
    [unfold, wide],
  );
  // A list row's path, or Edit: unfold the file, load its patch, scroll to the line (the file's header when the lines are gone).
  const showComment = useCallback(
    (c: LineComment, edit: boolean) => {
      setCommentsListOpen(threadId, false);
      skipRestore.current = true;
      anchor.current?.stopRestoring();
      unfold(c.path);
      setRevealPath(c.path);
      if (edit) setOpenEditor(threadId, { path: c.path, gesture: { side: c.side, anchor: c.start, head: c.end, hunk: -1 }, note: c.note, editingId: c.id, notice: null });
      if (c.state === "outdated") setPendingScroll(c.path);
      else revealCommentLine(threadId, { path: c.path, side: c.side, line: c.start });
      if (!wide) setTreeOpen(false);
    },
    [threadId, unfold, wide],
  );
  const onToggleDir = useCallback((path: string) => setCollapsedDirs((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  }), []);
  const onOpenInFiles = useCallback(
    async (file: DiffFileEntry) => {
      if (scope.kind === "run" || folderPath == null) {
        await openPrintedPath(threadId, paneId, file.path);
        return;
      }
      const root = await repoRootPath(folderPath, paneId);
      if (root === undefined) {
        showToast("Couldn't find this file's folder.", "error");
        return;
      }
      useRightPanelStore.getState().openFile(threadId, filesPathOf(root, file.path));
    },
    [scope.kind, folderPath, paneId, threadId],
  );

  const totals = useMemo(() => diffTotals(files), [files]);
  const anyUnfolded = unfolded !== null && unfolded.size > 0;
  const loading = scope.kind !== "run" && summary.status === "loading";
  // The source of what is listed, for the badge: "Exact" only for a checkpoint whose diff loaded.
  const sourceInfo =
    diffState?.status === "ready"
      ? {
          source: diffState.source,
          state: changes.state,
          reason: changes.reason,
          ...(diffState.loadFailed ? { note: "Couldn't load the exact diff, so this is the list of the agent's edits." } : {}),
        }
      : diffState?.status === "running"
        ? { source: "journal" as const, state: changes.state, reason: changes.reason }
        : null;

  const toolbar = (
    <>
      <DiffScopePicker
        scope={scope}
        onScope={(next) => setScope(threadId, next)}
        runs={runs}
        defaultBase={defaultBase}
        branches={branches}
        onWantBranches={() => setBranchesWanted(true)}
      />
      {scope.kind === "run" ? <RunPicker runs={runs} runId={scope.runId} onPick={(id) => setScope(threadId, { kind: "run", runId: id })} /> : null}
      {sourceInfo ? <ChangedFilesSourceBadge info={sourceInfo} /> : null}
      <span className="flex-1" />
      {wide ? (
        <Button size="xs" variant="ghost-muted" aria-label={treeColumn ? "Hide file list" : "Show file list"} onClick={() => setTreeColumn(!treeColumn)} className={cn(treeColumn && "bg-accent text-foreground")} data-diff-tree-column-toggle="">
          <PanelLeftIcon aria-hidden="true" />
          File list
        </Button>
      ) : null}
      {splitOk ? (
        <span role="group" aria-label="Diff layout" className="flex items-center" data-diff-layout-toggle="">
          <Button size="xs" variant="ghost-muted" aria-pressed={shownLayout === "stacked"} onClick={() => setLayoutPref("stacked")} className={cn(shownLayout === "stacked" && "bg-accent text-foreground")}>
            <Rows2Icon aria-hidden="true" />
            Stacked
          </Button>
          <Button size="xs" variant="ghost-muted" aria-pressed={shownLayout === "split"} onClick={() => setLayoutPref("split")} className={cn(shownLayout === "split" && "bg-accent text-foreground")}>
            <Columns2Icon aria-hidden="true" />
            Split
          </Button>
        </span>
      ) : null}
      <Button
        size="xs"
        variant="ghost-muted"
        aria-pressed={ignoreWs}
        disabled={scope.kind === "run" && !exactLive}
        title={scope.kind === "run" && !exactLive ? (exactRun ? "No longer available for this run" : "Not available for this run") : undefined}
        onClick={() => setWsPref(!wsPref)}
        className={cn(ignoreWs && "bg-accent text-foreground")}
      >
        <PilcrowIcon aria-hidden="true" />
        Ignore whitespace
      </Button>
      <Button size="xs" variant="ghost-muted" aria-pressed={wrap} onClick={() => setWrap(!wrap)} className={cn(wrap && "bg-accent text-foreground")}>
        <WrapTextIcon aria-hidden="true" />
        Wrap
      </Button>
      <Button size="xs" variant="ghost-muted" disabled={!anyUnfolded} onClick={() => setUnfolded(new Set())}>
        <ChevronsDownUpIcon aria-hidden="true" />
        Collapse all
      </Button>
      {comments.length > 0 || listOpen ? (
        <Button size="xs" variant="ghost-muted" aria-pressed={listOpen} onClick={() => setCommentsListOpen(threadId, !listOpen)} className={cn(listOpen && "bg-accent text-foreground")} data-diff-comments-chip="">
          <MessageSquareIcon aria-hidden="true" />
          Comments {comments.length}
        </Button>
      ) : null}
      {scope.kind !== "run" ? (
        <Button size="xs" variant="ghost-muted" disabled={loading} onClick={refresh}>
          <RotateCwIcon className={cn("size-3.5", loading && "motion-safe:animate-spin")} aria-hidden="true" />
          Refresh
        </Button>
      ) : null}
    </>
  );

  const countsLine = (
    <>
      Files · {totals.files}
      {totals.added > 0 || totals.removed > 0 ? (
        <>
          {" · "}
          <DiffStatLabel additions={totals.added} deletions={totals.removed} layout="inline" />
        </>
      ) : null}
    </>
  );

  const diffBody = (() => {
    if (scope.kind === "run") {
      if (diffState?.status === "loading") return <DiffPanelLoadingState label="Loading changes" />;
      if (diffState?.status === "unavailable") return <DiffPanelMessage>No recorded changes for this run.</DiffPanelMessage>;
    } else if (summary.status === "loading" || summary.status === "idle") {
      return <DiffPanelLoadingState label="Loading changes" />;
    } else if (summary.status === "unavailable") {
      return <DiffPanelMessage>{reviewReason(summary.reason)}</DiffPanelMessage>;
    } else if (summary.status === "error") {
      return (
        <DiffPanelMessage
          action={
            <Button size="xs" variant="outline" onClick={refresh}>
              <RotateCwIcon aria-hidden="true" />
              Try again
            </Button>
          }
        >
          Couldn't read the changes.
        </DiffPanelMessage>
      );
    }
    if (files.length === 0) {
      return (
        <DiffPanelMessage>{scope.kind === "run" && exactShown ? emptyNetText(changes.journalCount) : emptyText(scope, summary.status === "ready" ? summary.preview.base : undefined)}</DiffPanelMessage>
      );
    }
    const first = files[0]?.path;
    return (
      <div className={cn("flex min-h-0 flex-1", wide ? "flex-row" : "flex-col")}>
        {wide && treeColumn ? (
          <aside className="flex w-64 shrink-0 flex-col border-r" data-diff-tree-column="">
            <p className="shrink-0 border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">{countsLine}</p>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
              <DiffFileTree files={files} collapsedDirs={collapsedDirs} onToggleDir={onToggleDir} onSelect={onSelect} activePath={revealPath} />
            </div>
          </aside>
        ) : wide ? null : (
          <div className="shrink-0 border-b">
            <button
              type="button"
              aria-expanded={treeOpen}
              onClick={() => setTreeOpen((o) => !o)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-muted-foreground pointer-coarse:min-h-11"
              data-diff-tree-toggle=""
            >
              <ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", treeOpen && "rotate-90")} />
              <span className="min-w-0 flex-1">{countsLine}</span>
            </button>
            {treeOpen ? (
              <div className="max-h-[40dvh] overflow-y-auto overscroll-y-contain border-t">
                <DiffFileTree files={files} collapsedDirs={collapsedDirs} onToggleDir={onToggleDir} onSelect={onSelect} activePath={revealPath} />
              </div>
            ) : null}
          </div>
        )}
        <div ref={setScrollerEl} className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain" data-diff-scroller="" data-diff-column={columnPx} data-diff-layout-shown={shownLayout}>
          <DiffScrollRootContext value={scrollerEl}>
          <DiffCommentsContext value={commentsCtx}>
            {commentsOff ? (
              <p className="border-b px-3 py-1.5 text-xs text-muted-foreground" data-diff-note="comments-off">
                {commentsOff}
              </p>
            ) : null}
            {ignoreWs && summary.status === "ready" && summary.plainMissing ? (
              <p className="border-b px-3 py-1.5 text-xs text-muted-foreground" data-diff-note="whitespace-only-missing">
                Whitespace-only files can't be shown right now.
              </p>
            ) : null}
            {scope.kind === "branch" && baseGone && storedBase ? (
              <p className="border-b px-3 py-1.5 text-xs text-muted-foreground" data-diff-note="base-gone">
                {storedBase} isn't a branch here any more, so this is against the default base{defaultBase ? ` (${defaultBase})` : ""}.
              </p>
            ) : null}
            {diffState?.status === "running" ? (
              <p className="border-b px-3 py-1.5 text-xs text-muted-foreground" role="status" data-diff-note="run-running">
                {diffState.phase === "finishing" ? "Finishing snapshot. The exact diff appears in a moment." : "Run in progress. The exact diff appears when it ends."}
              </p>
            ) : null}
            {diffState?.status === "ready" && diffState.loadFailed ? (
              <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground" data-diff-note="load-failed">
                <span className="min-w-0 flex-1">Couldn't load the exact diff. This is the list of the agent's edits.</span>
                <Button size="xs" variant="outline" onClick={runPatches.retryFailed}>
                  <RotateCwIcon aria-hidden="true" />
                  Retry
                </Button>
              </div>
            ) : null}
            {scope.kind === "run" && exactShown && !changes.live ? (
              <p className="border-b px-3 py-1.5 text-xs text-muted-foreground" data-diff-note="expired">
                No longer available for this run: Ignore whitespace and unchanged lines. The saved diffs still show.
              </p>
            ) : null}
            {scope.kind === "run" && !exactShown ? (
              <p className="border-b px-3 py-1.5 text-xs text-muted-foreground" data-diff-note="run">
                From the agent's edits in this run, one after another; it may not match what is on disk now. Each edit's line numbers are its own.
                {run.shellRan ? " A shell command ran too, and files it changed are not listed." : ""} Ignore whitespace and unchanged lines are not available for this run.
              </p>
            ) : null}
            {files.map((file) => (
              <DiffFileSection
                key={file.path}
                file={file}
                state={patchFor(file.path)}
                unfolded={unfolded?.has(file.path) ?? false}
                wrap={wrap}
                eager={file.path === first || file.path === revealPath}
                layout={shownLayout}
                {...(canExpand ? { onExpandContext } : {})}
                highlighted={highlight === file.path}
                canOpen={canOpenInFiles(file)}
                onToggle={onToggle}
                onRetry={onRetryFile}
                onOpenInFiles={onOpenInFiles}
              />
            ))}
            {summary.status === "ready" && scope.kind !== "run" ? (
              <>
                {summary.preview.hidden > 0 ? (
                  <p className="px-3 py-1.5 text-xs text-muted-foreground">
                    {summary.preview.hidden} hidden file{summary.preview.hidden === 1 ? "" : "s"} not shown.
                  </p>
                ) : null}
                {summary.preview.truncated ? <p className="px-3 py-1.5 text-xs text-muted-foreground">The list was cut at 500 files.</p> : null}
              </>
            ) : null}
            {scope.kind === "run" && exactShown ? <ChangedFilesSnapshotNotes changes={changes} className="px-3 py-1.5 pb-1.5" /> : null}
            <p className="px-3 py-2 text-xs text-muted-foreground" data-diff-caveats="">
              Long diffs draw a screenful at a time: Ctrl+F finds only the lines already drawn, and a returning scroll position is the file and a place inside it, not an exact line.
            </p>
          </DiffCommentsContext>
          </DiffScrollRootContext>
        </div>
      </div>
    );
  })();
  const body = listOpen ? (
    <LineCommentsList
      threadId={threadId}
      inScope={new Set(files.map((f) => f.path))}
      onBack={() => setCommentsListOpen(threadId, false)}
      onJump={(c) => showComment(c, false)}
      onEdit={(c) => showComment(c, true)}
    />
  ) : (
    diffBody
  );

  return (
    <DiffPanelShell header={toolbar} panelRef={panelRef}>
      {body}
    </DiffPanelShell>
  );
}

const NO_PATHS: ReadonlySet<string> = new Set();
const NO_ENTRIES: DiffFileEntry[] = [];

function emptyNetText(journalCount: number): string {
  return journalCount > 0 ? `No net changes. The agent edited ${journalCount} file${journalCount === 1 ? "" : "s"}; the folder ended as it started.` : "No net changes.";
}

function emptyText(scope: DiffScope, base: string | undefined): string {
  if (scope.kind === "workingTree") return "Working tree clean.";
  if (scope.kind === "branch") return `Nothing committed on this branch since ${scope.baseRef ?? base ?? "its base"}.`;
  return "This run changed no files.";
}
