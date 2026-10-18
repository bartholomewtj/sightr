// Pattern from T3 Code apps/web/src/components/DiffPanel.tsx @ 3a4d118a518a (MIT, see THIRD_PARTY.md). T3 has
// one diff panel for the whole app: a branch or unstaged toggle, a run's own diff, a Pierre `CodeView` over
// every file, an Effect-atom read per file. Sightr's is a right-panel tab (`diff`, opened by `mod+d` or
// from the Git tab and a run's changed-files card) written against the `DiffCodeView` seam (T25) and plain
// fetches to the bridge (T26):
//   - scope: the working tree, the branch against a base, or one run (from the thread's journal);
//   - a changed-files tree (our own `role="tree"`), and one section per file, unfolded to fetch its patch;
//   - at most 4 patch requests at once, only for files that are unfolded or near the screen;
//   - phone (a sheet, one column): the tree folds open and shut under a "Files · 12 · +230 -41" header;
//     desktop, when the panel itself is 600 px wide or more: the tree is a left column;
//   - refresh on the button, when the run ends, and when the page comes back (the Git tab's triggers).
// Read-only: no staging, commit, revert or rollback. T28 adds the reading aids: split view (a wide desktop column
// only), ignore whitespace (the host's `git diff -w`, never a client-side edit of a patch) and expand unchanged
// lines (the host's whole-file route, asked for on the first tap of a control). Not here: line comments (T29).
//
// The diffs mount in windows (hand renderer), so two things are said in the panel, not hidden: the
// browser's find (Ctrl+F) sees only lines already drawn, and the scroll position comes back to a file
// and an offset into it, not to an exact line.
import { ChevronRightIcon, ChevronsDownUpIcon, Columns2Icon, PilcrowIcon, RotateCwIcon, Rows2Icon, WrapTextIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { DiffStatLabel } from "@/components/chat/DiffStatLabel";
import { showToast } from "@/components/toast";
import { useLayout } from "@/hooks/useLayout";
import { useDiffPanelStore, useDiffScope, type DiffScope } from "@/diffPanelStore";
import { DiffContentsCache } from "@/lib/diffFileContents";
import { useDiffIgnoreWhitespace, useDiffLayout, useDiffWrap, useRightPanelStore } from "@/rightPanelStore";
import { useSidebarThread } from "@/state/sidebar";
import { useThread } from "@/stream/stores";

import { DiffPanelLoadingState, DiffPanelMessage, DiffPanelShell } from "./DiffPanelShell";
import { baseExists, useDiffBranches } from "./diffs/DiffBranchPicker";
import { DiffScrollRootContext, preloadDiffRenderer } from "./diffs/DiffCodeView";
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
import { openPrintedPath } from "./right-panel/OpenFileLink";
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
  useEffect(() => {
    writeDiffMemory(memKey, { unfolded: unfolded ? [...unfolded] : null, treeOpen, collapsedDirs: [...collapsedDirs] });
  }, [memKey, unfolded, treeOpen, collapsedDirs]);

  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  const [revealPath, setRevealPath] = useState<string | null>(null);
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);

  // ── The files and their patches ──
  // A run reads the journal, which `-w` cannot change: the preference stays stored but does not apply there.
  const ignoreWs = wsPref && scope.kind !== "run";
  const patches = useDiffFilePatches({
    folderPath: scope.kind === "run" ? null : folderPath,
    scope: fetchScope,
    unfolded: unfolded ?? NO_PATHS,
    near,
    revealPath,
    refreshToken: refreshes,
    ignoreWhitespace: ignoreWs,
  });
  const run = useRunScopeFiles(threadId, scope.kind === "run" ? scope.runId : "");
  const runs = useRunOptions(threadId);
  const runByPath = useMemo(() => new Map(run.files.map((f) => [f.entry.path, f.state] as const)), [run.files]);
  const sourceFiles = useMemo(() => (scope.kind === "run" ? run.files.map((f) => f.entry) : patches.files), [scope.kind, run.files, patches.files]);
  const files = useMemo(() => treeOrder(sourceFiles), [sourceFiles]);
  const patchFor = useCallback((path: string): PatchState => (scope.kind === "run" ? (runByPath.get(path) ?? IDLE) : patches.patchFor(path)), [scope.kind, runByPath, patches]);
  const summary = patches.summary;
  // A list to work from: the server's, once it has answered and is available; a run's, once the thread has its items.
  const listOk = scope.kind === "run" ? run.found : summary.status === "ready";
  // Nothing more is coming for a request that has failed for good, so a reveal waiting for the list is dropped then.
  const listFailed = scope.kind !== "run" && (summary.status === "unavailable" || summary.status === "error");

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
    const hit = files.find((f) => f.path === reveal.filePath);
    if (!hit) return;
    skipRestore.current = true;
    anchor.current?.stopRestoring();
    unfold(hit.path);
    setRevealPath(hit.path);
    setPendingScroll(hit.path);
    setHighlight(hit.path);
    // Asked for a file, so the file is the point: the phone's tree folds out of the way, as when one is picked in it.
    if (!wide) setTreeOpen(false);
  }, [reveal, threadId, listOk, listFailed, files, unfold, consumeReveal, wide]);
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
  const [wasSplit, setWasSplit] = useState(false);
  const splitOk = splitAvailable({ layout, columnPx, wasSplit });
  useEffect(() => setWasSplit(splitOk), [splitOk]);
  const shownLayout = effectiveDiffLayout(layoutPref, splitOk);

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
  const expandSource = useRef({ folderPath, scope: fetchScope, preview: readyPreview, files: patches.files });
  expandSource.current = { folderPath, scope: fetchScope, preview: readyPreview, files: patches.files };
  const onExpandContext = useCallback(async (filePath: string) => {
    const src = expandSource.current;
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
  const canExpand = scope.kind !== "run" && folderPath != null;

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
      <span className="flex-1" />
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
        disabled={scope.kind === "run"}
        title={scope.kind === "run" ? "Not available for this run" : undefined}
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

  const body = (() => {
    if (scope.kind === "run") {
      if (!run.found) return <DiffPanelMessage>This run's edits aren't loaded, or it changed no files.</DiffPanelMessage>;
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
      return <DiffPanelMessage>{emptyText(scope, summary.status === "ready" ? summary.preview.base : undefined)}</DiffPanelMessage>;
    }
    const first = files[0]?.path;
    return (
      <div className={cn("flex min-h-0 flex-1", wide ? "flex-row" : "flex-col")}>
        {wide ? (
          <aside className="flex w-64 shrink-0 flex-col border-r" data-diff-tree-column="">
            <p className="shrink-0 border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">{countsLine}</p>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
              <DiffFileTree files={files} collapsedDirs={collapsedDirs} onToggleDir={onToggleDir} onSelect={onSelect} activePath={revealPath} />
            </div>
          </aside>
        ) : (
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
        <div ref={setScrollerEl} className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain" data-diff-scroller="">
          <DiffScrollRootContext value={scrollerEl}>
            {scope.kind === "branch" && baseGone && storedBase ? (
              <p className="border-b px-3 py-1.5 text-xs text-muted-foreground" data-diff-note="base-gone">
                {storedBase} isn't a branch here any more, so this is against the default base{defaultBase ? ` (${defaultBase})` : ""}.
              </p>
            ) : null}
            {scope.kind === "run" ? (
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
                onRetry={patches.retry}
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
            <p className="px-3 py-2 text-xs text-muted-foreground" data-diff-caveats="">
              Long diffs draw a screenful at a time: Ctrl+F finds only the lines already drawn, and a returning scroll position is the file and a place inside it, not an exact line.
            </p>
          </DiffScrollRootContext>
        </div>
      </div>
    );
  })();

  return (
    <DiffPanelShell header={toolbar} panelRef={panelRef}>
      {body}
    </DiffPanelShell>
  );
}

const NO_PATHS: ReadonlySet<string> = new Set();

function emptyText(scope: DiffScope, base: string | undefined): string {
  if (scope.kind === "workingTree") return "Working tree clean.";
  if (scope.kind === "branch") return `Nothing committed on this branch since ${scope.baseRef ?? base ?? "its base"}.`;
  return "This run changed no files.";
}
