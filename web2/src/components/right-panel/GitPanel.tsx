/**
 * The Git tab (T13), read-only: `/api/files/git` for the thread's folder. The branch and how far it is
 * ahead of or behind its base (the upstream, else origin's default branch), "Changes" (one summary row:
 * how many files and lines, with a button into the Diff tab, where the working tree is reviewed since T27)
 * and "Commits" (the last 20 on HEAD), so work an agent already committed is still visible. A commit, or
 * the whole branch against its base, opens its own file list with each file's diff on tap
 * (`/api/files/git/diff`); "Open branch in Diff" reviews the same range in the Diff tab. Refreshes on the button, when the thread's run ends, and
 * when the page returns to the foreground or the network is back. No stage, commit, push, PR, checkout
 * or per-turn diff: out of scope (docs/T3_ADAPTATION.md).
 *
 * Phone: paths wrap (a truncated path hides the file name), each file row has Copy path and Open in
 * Files, rows are thumb-sized on a touch screen, diff lines wrap by default below the desktop layout
 * (Wrap toggles it per device) and otherwise scroll sideways inside their own box without dragging the
 * sheet; Collapse all folds every open diff. The view (list, a commit, the branch), the expanded files
 * and the scroll position are remembered per thread so a closed and reopened sheet resumes where it was.
 */
import { ArrowLeftIcon, ChevronsDownUpIcon, DiffIcon, FileSymlinkIcon, GitBranchIcon, GitCommitHorizontalIcon, GitCompareIcon, RotateCwIcon, WrapTextIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { FolderGitCommit, FolderGitDiffResponse, FolderGitResponse } from "@shared/wire";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { DiffStatLabel } from "@/components/chat/DiffStatLabel";
import { DiffFilePathCopyButton } from "@/components/DiffFilePathCopyButton";
import { useScrollMemory } from "@/hooks/use-scroll-memory";
import { useDiffPanelStore } from "@/diffPanelStore";
import { fetchFolderGit, fetchFolderGitDiff } from "@/lib/api";
import { useDiffWrap, useRightPanelStore } from "@/rightPanelStore";
import { useSidebarThread } from "@/state/sidebar";
import { useThread } from "@/stream/stores";

import { DiffLines, diffLinesByPath, parseDiff } from "./DiffView";
import { relativeTime, repoFilePath, syncLabel } from "./GitPanel.logic";
import { useRefreshTriggers } from "./useRefreshTriggers";
import { usePaneFolder } from "./usePaneFolder";

type Available = Extract<FolderGitResponse, { available: true }>;

const UNAVAILABLE: Record<Extract<FolderGitResponse, { available: false }>["reason"], string> = {
  "outside-root": "This folder is outside the Files root.",
  "not-a-repo": "This folder is not a git repository.",
  "git-unavailable": "git isn't installed on the host.",
  timeout: "git took too long. Try Refresh.",
};
const DIFF_UNAVAILABLE: Record<Extract<FolderGitDiffResponse, { available: false }>["reason"], string> = {
  ...UNAVAILABLE,
  "no-base": "This branch has nothing to compare with (no upstream, main or master).",
  "bad-commit": "That commit isn't in this repository any more.",
};

/** What the tab shows: the overview, one commit, or the branch against its base. */
export type GitView = { kind: "list" } | { kind: "commit"; sha: string } | { kind: "branch" };

const viewKey = (v: GitView) => (v.kind === "commit" ? `c:${v.sha}` : v.kind === "branch" ? "b" : "w");

/** Each thread's view and expanded files, kept across a closed sheet. */
const navMemory = new Map<string, { view: GitView; expanded: string[] }>();

/** Test helper. */
export function __resetGitNav(): void {
  navMemory.clear();
}

export function GitPanel({ threadId }: { threadId: string }) {
  const state = useThread(threadId);
  const shellThread = useSidebarThread(threadId);
  const thread = state?.thread ?? shellThread ?? null;
  const paneId = thread?.paneId || null;
  const folder = usePaneFolder(paneId);
  const [result, setResult] = useState<FolderGitResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<GitView>(() => navMemory.get(threadId)?.view ?? { kind: "list" });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(navMemory.get(threadId)?.expanded ?? []));
  const [wrap, setWrap] = useDiffWrap();
  useEffect(() => {
    navMemory.set(threadId, { view, expanded: [...expanded] });
  }, [threadId, view, expanded]);
  const scrollRef = useScrollMemory<HTMLDivElement>(`git:${threadId}:${viewKey(view)}`);

  // The run ended, the page came back, the network returned (shared with the Diff tab), and the button.
  const { refreshes, refresh } = useRefreshTriggers(threadId);

  useEffect(() => {
    if (folder.path === undefined || folder.path === null || !paneId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    fetchFolderGit(folder.path, [paneId], controller.signal)
      .then((r) => setResult(r))
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [folder.path, paneId, refreshes]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const prefix = `${viewKey(view)}:`;
  const anyOpen = [...expanded].some((k) => k.startsWith(prefix));
  const collapseAll = () => setExpanded((prev) => new Set([...prev].filter((k) => !k.startsWith(prefix))));
  const available = result?.available ? result : null;
  const openInFiles =
    available?.rootPath !== undefined
      ? (path: string) => useRightPanelStore.getState().openFile(threadId, repoFilePath(available.rootPath!, path))
      : null;

  if (!thread) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (folder.filesOff) return <p className="p-4 text-sm text-muted-foreground">Files isn't turned on. Set SIGHTR_WORK_ROOT on the host.</p>;
  if (folder.path === null) return <p className="p-4 text-sm text-muted-foreground">This thread's folder is outside the Files root.</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-git-tab="">
      <div className="flex items-start gap-2 border-b px-3 py-1.5 text-sm">
        <GitBranchIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <span className="block wrap-anywhere" data-git-head="">
            {available
              ? `${available.branch ?? (available.detached ? "detached HEAD" : "no commits yet")} · ${available.repo}${available.rel ? `/${available.rel}` : ""}`
              : "Git"}
          </span>
          {available ? <SyncLine result={available} /> : null}
        </div>
        <Button size="xs" variant="ghost-muted" disabled={loading} onClick={refresh}>
          <RotateCwIcon className={cn("size-3.5", loading && "motion-safe:animate-spin")} aria-hidden="true" />
          Refresh
        </Button>
      </div>
      {available && view.kind !== "list" ? (
        <div className="flex items-center gap-1 border-b px-2 py-1">
          <Button size="xs" variant="ghost-muted" onClick={() => setView({ kind: "list" })}>
            <ArrowLeftIcon aria-hidden="true" />
            All changes
          </Button>
          <span className="flex-1" />
          <Button size="xs" variant="ghost-muted" aria-pressed={wrap} onClick={() => setWrap(!wrap)} className={cn(wrap && "bg-accent text-foreground")}>
            <WrapTextIcon aria-hidden="true" />
            Wrap
          </Button>
          <Button size="xs" variant="ghost-muted" disabled={!anyOpen} onClick={collapseAll}>
            <ChevronsDownUpIcon aria-hidden="true" />
            Collapse all
          </Button>
        </div>
      ) : null}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-3 text-sm">
        {loading && !result ? <p className="text-muted-foreground">Checking…</p> : null}
        {error ? <p className="text-muted-foreground">Couldn't read git here.</p> : null}
        {result && !result.available ? <p>{UNAVAILABLE[result.reason]}</p> : null}
        {available && view.kind === "list" ? (
          <Overview
            threadId={threadId}
            result={available}
            onCommit={(sha) => setView({ kind: "commit", sha })}
            onBranch={() => setView({ kind: "branch" })}
          />
        ) : null}
        {available && view.kind !== "list" && folder.path !== undefined ? (
          <HistoryDiff
            key={viewKey(view)}
            folderPath={folder.path}
            view={view}
            refreshes={refreshes}
            expanded={expanded}
            prefix={prefix}
            toggle={toggle}
            wrap={wrap}
            openInFiles={openInFiles}
          />
        ) : null}
      </div>
    </div>
  );
}

/** "↑2 ↓0 · origin/main", or why there is nothing to compare. */
function SyncLine({ result }: { result: Available }) {
  if (result.base === undefined || result.ahead === undefined) {
    if (result.noCommits) return null;
    return <span className="block text-xs text-muted-foreground" data-git-sync="">{result.upstream ? `Upstream ${result.upstream} is gone` : "No upstream"}</span>;
  }
  const behind = result.behind ?? 0;
  return (
    <span className="block text-xs text-muted-foreground" data-git-sync="" aria-label={syncLabel(result.ahead, behind, result.base)}>
      <span aria-hidden="true" className="font-mono tabular-nums">
        ↑{result.ahead} ↓{behind}
      </span>
      <span aria-hidden="true"> · {result.upstream ? result.base : `vs ${result.base}`}</span>
    </span>
  );
}

interface RowsProps {
  expanded: Set<string>;
  prefix: string;
  toggle: (key: string) => void;
  wrap: boolean;
  openInFiles: ((path: string) => void) | null;
}

/** "12 files changed · +230 −41": every entry counts (untracked and conflicted files too); the lines come from the tracked diff. */
export function changesSummary(result: Pick<Available, "entries" | "diff" | "diffTruncated">): { files: number; added: number; removed: number; partial: boolean } {
  let added = 0;
  let removed = 0;
  for (const f of parseDiff(result.diff)) {
    added += f.added;
    removed += f.removed;
  }
  return { files: result.entries.length, added, removed, partial: result.diffTruncated };
}

function Overview(props: { threadId: string; result: Available; onCommit: (sha: string) => void; onBranch: () => void }) {
  const { result, threadId } = props;
  const summary = useMemo(() => changesSummary(result), [result]);
  const openDiff = useDiffPanelStore((s) => s.openDiff);
  const commits = result.commits ?? [];
  return (
    <>
      <section aria-label="Changes">
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Changes</h3>
        {result.clean ? (
          <p className="text-muted-foreground">Working tree clean.</p>
        ) : (
          <div className="flex items-center gap-2 rounded border px-2 py-1.5" data-git-changes-summary="">
            <p className="min-w-0 flex-1 wrap-anywhere">
              {summary.files} file{summary.files === 1 ? "" : "s"} changed
              {summary.added > 0 || summary.removed > 0 ? (
                <>
                  {" · "}
                  <DiffStatLabel additions={summary.added} deletions={summary.removed} layout="inline" />
                  {summary.partial ? <span className="text-muted-foreground"> (counts may be short)</span> : null}
                </>
              ) : null}
            </p>
            <Button size="xs" variant="outline" className="shrink-0" onClick={() => openDiff(threadId, { kind: "workingTree" })}>
              <DiffIcon aria-hidden="true" />
              Review in Diff
            </Button>
          </div>
        )}
        {result.hidden > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {result.hidden} hidden file{result.hidden === 1 ? "" : "s"} not shown.
          </p>
        ) : null}
        {result.statusTruncated ? <p className="mt-2 text-xs text-muted-foreground">First 500 changes counted.</p> : null}
        {result.noCommits ? <p className="mt-2 text-xs text-muted-foreground">No commits yet: nothing to diff against.</p> : null}
      </section>
      {commits.length > 0 || result.base ? (
        <section aria-label="Commits" className="mt-4">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Commits</h3>
          {result.base && result.ahead ? (
            <div className="mb-1 flex items-stretch gap-1">
              <button
                type="button"
                onClick={props.onBranch}
                className="flex min-w-0 flex-1 items-center gap-2 rounded border px-2 py-1.5 text-left hover:bg-accent pointer-coarse:py-2.5"
                data-git-branch-range=""
              >
                <GitCompareIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 wrap-anywhere">
                  All {result.ahead} commit{result.ahead === 1 ? "" : "s"} not on {result.base}
                </span>
              </button>
              <Button size="xs" variant="outline" className="h-auto shrink-0" onClick={() => openDiff(threadId, { kind: "branch", baseRef: result.base })}>
                <DiffIcon aria-hidden="true" />
                Open branch in Diff
              </Button>
            </div>
          ) : null}
          <ul aria-label="Recent commits" className="space-y-1">
            {commits.map((c) => (
              <li key={c.sha}>
                <CommitRow commit={c} onOpen={() => props.onCommit(c.sha)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function CommitRow({ commit, onOpen }: { commit: FolderGitCommit; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left hover:bg-accent pointer-coarse:py-2.5"
      data-git-commit={commit.short}
    >
      <GitCommitHorizontalIcon className={cn("mt-0.5 size-4 shrink-0", commit.ahead ? "text-house-accent" : "text-muted-foreground")} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block wrap-anywhere">{commit.subject || "(no message)"}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <code className="font-mono">{commit.short}</code>
          <span>{relativeTime(commit.time)}</span>
          {commit.ahead ? <span className="text-house-accent">not pushed</span> : null}
          <span>
            {commit.parents > 1 ? "merge · " : ""}
            {commit.files} file{commit.files === 1 ? "" : "s"}
          </span>
          {commit.files > 0 ? <DiffStatLabel additions={commit.added} deletions={commit.removed} layout="inline" /> : null}
        </span>
      </span>
    </button>
  );
}

/** One commit's files, or the branch range's, fetched for this view. */
function HistoryDiff(props: RowsProps & { folderPath: string; view: Exclude<GitView, { kind: "list" }>; refreshes: number }) {
  const [data, setData] = useState<FolderGitDiffResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const sha = props.view.kind === "commit" ? props.view.sha : null;
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    fetchFolderGitDiff(props.folderPath, sha ? { scope: "commit", sha } : { scope: "branch" }, controller.signal)
      .then(setData)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [props.folderPath, sha, props.refreshes]);
  const lines = useMemo(() => (data?.available ? diffLinesByPath(data.diff) : new Map<string, string[]>()), [data]);

  if (failed) return <p className="text-muted-foreground">Couldn't read this diff.</p>;
  if (!data) return <p className="text-muted-foreground">Loading…</p>;
  if (!data.available) return <p>{DIFF_UNAVAILABLE[data.reason]}</p>;
  const c = data.commit;
  return (
    <section aria-label={c ? `Commit ${c.short}` : `Branch against ${data.base}`} data-git-history={c ? c.short : "branch"}>
      {c ? (
        <div className="mb-2">
          <p className="wrap-anywhere font-medium">{c.subject || "(no message)"}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <code className="font-mono">{c.short}</code>
            <span>{c.author}</span>
            <span>{relativeTime(c.time)}</span>
            {c.parents > 1 ? <span>merge, against its first parent</span> : null}
          </p>
        </div>
      ) : (
        <p className="mb-2 text-xs text-muted-foreground">Everything on this branch since it left {data.base} (committed only).</p>
      )}
      {data.files.length === 0 ? <p className="text-muted-foreground">No visible file changes.</p> : null}
      <FileRows
        {...props}
        label="Files in this change"
        rows={data.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed, binary: f.binary === true, openable: true, ...(lines.has(f.path) ? { lines: lines.get(f.path)! } : {}) }))}
      />
      {data.hidden > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {data.hidden} hidden file{data.hidden === 1 ? "" : "s"} not shown.
        </p>
      ) : null}
      {data.filesTruncated ? <p className="mt-2 text-xs text-muted-foreground">First 500 files shown.</p> : null}
      {data.diffTruncated ? <p className="mt-2 text-xs text-muted-foreground">Diff truncated: some files show counts only.</p> : null}
    </section>
  );
}

interface FileRow {
  path: string;
  status?: string;
  lines?: string[];
  added?: number;
  removed?: number;
  binary?: boolean;
  /** The file exists on disk, so Files can open it. */
  openable: boolean;
}

/** Changed files: tap to expand the diff; +N −M, Copy path and Open in Files on each row. */
function FileRows(props: RowsProps & { label: string; rows: FileRow[] }) {
  return (
    <ul aria-label={props.label} className="space-y-1">
      {props.rows.map((row) => {
        const key = `${props.prefix}${row.path}`;
        const open = props.expanded.has(key) && row.lines !== undefined;
        return (
          <li key={row.path} className="rounded border" data-git-file={row.path}>
            <div className="flex items-start gap-1 pe-1">
              <button
                type="button"
                aria-expanded={row.lines ? open : undefined}
                disabled={!row.lines}
                onClick={() => props.toggle(key)}
                className="flex min-w-0 flex-1 items-start gap-3 px-2 py-1 text-left disabled:cursor-default pointer-coarse:py-2.5"
              >
                {row.status !== undefined ? <code className="w-6 shrink-0 font-mono text-xs text-muted-foreground">{row.status}</code> : null}
                <span className="min-w-0 flex-1 wrap-anywhere font-mono text-xs">{row.path}</span>
              </button>
              <span className="shrink-0 py-1 text-xs pointer-coarse:py-2.5">
                {row.binary ? (
                  <span className="text-muted-foreground">binary</span>
                ) : row.added !== undefined && row.removed !== undefined ? (
                  <DiffStatLabel additions={row.added} deletions={row.removed} layout="inline" />
                ) : null}
              </span>
              <DiffFilePathCopyButton filePath={row.path} />
              {props.openInFiles && row.openable ? (
                <Button size="icon-xs" variant="ghost-muted" aria-label={`Open ${row.path} in Files`} title="Open in Files" onClick={() => props.openInFiles!(row.path)}>
                  <FileSymlinkIcon />
                </Button>
              ) : null}
            </div>
            {open && row.lines ? <DiffLines lines={row.lines} wrap={props.wrap} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
