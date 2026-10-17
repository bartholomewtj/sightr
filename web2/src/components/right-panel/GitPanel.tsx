/**
 * The Git tab (T13), read-only: v1's `/api/files/git` for the thread's folder. Branch, the changed
 * files with their status letters, and each file's diff on tap (v1's `parseDiff`). Refreshes on the
 * button, when the thread's run ends, and when the page returns to the foreground or the network is back. No stage, commit, push or PR (out of scope, README).
 *
 * Phone: paths wrap (a truncated path hides the file name), rows are thumb-sized on a touch screen, a
 * diff scrolls sideways inside its own box without dragging the sheet, and the expanded file and the
 * scroll position are remembered per thread so a closed and reopened sheet resumes where it was.
 */
import { GitBranchIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { FolderGitResponse } from "@shared/wire";
import { Button } from "~/components/ui/button";
import { useScrollMemory } from "@/hooks/use-scroll-memory";
import { fetchFolderGit } from "@/lib/api";
import { useSidebarThread } from "@/state/sidebar";
import { useThread } from "@/stream/stores";

import { lineStyle, parseDiff } from "./DiffView";
import { usePaneFolder } from "./usePaneFolder";

const UNAVAILABLE: Record<Extract<FolderGitResponse, { available: false }>["reason"], string> = {
  "outside-root": "This folder is outside the Files root.",
  "not-a-repo": "This folder is not a git repository.",
  "git-unavailable": "git isn't installed on the host.",
  timeout: "git took too long. Try Refresh.",
};

const FINAL = new Set(["completed", "interrupted", "failed"]);

/** The newest run's id and status; a change from running to final means the run ended. */
function useRunEnded(threadId: string, onEnd: () => void): void {
  const state = useThread(threadId);
  const latest = useMemo(() => {
    const runs = Object.values(state?.runs ?? {});
    return runs.length === 0 ? null : runs.reduce((a, b) => (b.ordinal > a.ordinal ? b : a));
  }, [state?.runs]);
  const seen = useRef<{ id: string; status: string } | null>(null);
  const fire = useRef(onEnd);
  fire.current = onEnd;
  useEffect(() => {
    const prev = seen.current;
    seen.current = latest ? { id: latest.id, status: latest.status } : null;
    if (!latest || !prev) return;
    if (prev.id === latest.id && prev.status === "running" && FINAL.has(latest.status)) fire.current();
  }, [latest?.id, latest?.status]);
}

/** The file each thread's Git tab had expanded, kept across a closed sheet. */
const expandedMemory = new Map<string, string | null>();

/** Test helper. */
export function __resetGitNav(): void {
  expandedMemory.clear();
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
  const [refreshes, setRefreshes] = useState(0);
  const [openFile, setOpenFile] = useState<string | null>(() => expandedMemory.get(threadId) ?? null);
  useEffect(() => {
    expandedMemory.set(threadId, openFile);
  }, [threadId, openFile]);
  const scrollRef = useScrollMemory<HTMLDivElement>(`git:${threadId}`);

  const refresh = () => setRefreshes((n) => n + 1);
  useRunEnded(threadId, refresh);
  // Back from sleep or another app (and the network returning): the status may have moved on meanwhile.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setRefreshes((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, []);

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

  const diffs = useMemo(() => {
    const map = new Map<string, string[]>();
    if (result?.available) for (const f of parseDiff(result.diff)) if (f.path) map.set(f.path, f.lines);
    return map;
  }, [result]);

  if (!thread) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (folder.filesOff) return <p className="p-4 text-sm text-muted-foreground">Files isn't turned on. Set SIGHTR_WORK_ROOT on the host.</p>;
  if (folder.path === null) return <p className="p-4 text-sm text-muted-foreground">This thread's folder is outside the Files root.</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-git-tab="">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-sm">
        <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate" data-git-head="">
          {result?.available
            ? `${result.branch ?? (result.detached ? "detached HEAD" : "no commits yet")} · ${result.repo}${result.rel ? `/${result.rel}` : ""}`
            : "Git"}
        </span>
        <Button size="xs" variant="ghost-muted" disabled={loading} onClick={refresh}>
          <RotateCwIcon className="size-3.5" aria-hidden="true" />
          Refresh
        </Button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-3 text-sm">
        {loading && !result ? <p className="text-muted-foreground">Checking…</p> : null}
        {error ? <p className="text-muted-foreground">Couldn't read git here.</p> : null}
        {result && !result.available ? <p>{UNAVAILABLE[result.reason]}</p> : null}
        {result?.available ? (
          <>
            {result.clean ? <p className="text-muted-foreground">Working tree clean.</p> : null}
            <ul aria-label="Changed files" className="space-y-1">
              {result.entries.map((e) => {
                const lines = diffs.get(e.path);
                const expanded = openFile === e.path;
                return (
                  <li key={e.path} className="rounded border">
                    <button
                      type="button"
                      aria-expanded={lines ? expanded : undefined}
                      disabled={!lines}
                      onClick={() => setOpenFile(expanded ? null : e.path)}
                      className="flex w-full items-start gap-3 px-2 py-1 text-left disabled:cursor-default pointer-coarse:py-2.5"
                    >
                      <code className="w-6 shrink-0 font-mono text-xs text-muted-foreground">
                        {e.x}
                        {e.y}
                      </code>
                      <span className="min-w-0 flex-1 wrap-anywhere font-mono text-xs">{e.path}</span>
                    </button>
                    {expanded && lines ? (
                      <pre className="overflow-x-auto overscroll-x-contain border-t py-1 font-mono text-xs leading-5">
                        {lines.map((line, i) => (
                          <div key={i} className="w-max min-w-full px-2" data-diff-line={line[0] ?? " "} style={lineStyle(line)}>
                            {line || " "}
                          </div>
                        ))}
                      </pre>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {result.hidden > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {result.hidden} hidden file{result.hidden === 1 ? "" : "s"} not shown.
              </p>
            ) : null}
            {result.statusTruncated ? <p className="mt-2 text-xs text-muted-foreground">First 500 changes shown.</p> : null}
            {result.diffTruncated ? <p className="mt-2 text-xs text-muted-foreground">Diff truncated.</p> : null}
            {result.noCommits ? <p className="mt-2 text-xs text-muted-foreground">No commits yet: nothing to diff against.</p> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

