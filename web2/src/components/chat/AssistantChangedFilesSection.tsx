// Pattern from T3 Code apps/web/src/components/chat/MessagesTimeline.tsx @ 3a4d118a518a (MIT, see THIRD_PARTY.md).
// The same job as the "changed files" section T3 draws under a turn's reply: a header with the file count
// and the total `+N -M`, then the files grouped in a tree (`ChangedFilesTree`). T3 reads git checkpoints
// and offers "Open diff"; Sightr reads the journal's edits (T24) and a tap calls `openChangedFile`
// (`changedFilesTarget.ts`, the seam T27 repoints at the diff panel).
// Sightr's own: a tree/flat toggle (auto: a tree when the files span more than one folder and number 5
// or more; the choice is a per-device preference), "Collapse all" / "Expand all", a cap of 50 rows with
// "Show all N", and a caveat line when the counts can mislead (a shell command ran, or a file was edited
// more than once).
import { ListIcon, ListTreeIcon } from "lucide-react";
import { memo, useCallback, useState, useSyncExternalStore } from "react";

import { setChangedDirsCollapsed, collapsedChangedDirsOf, toggleChangedDir, useThreadTimelineUi } from "@/state/timeline";

import type { RunChangedFiles } from "./ChangedFiles.logic";
import { ChangedFilesTree, collectChangedDirectoryPaths } from "./ChangedFilesTree";
import { openChangedFile } from "./changedFilesTarget";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { Button } from "../ui/button";

/** Rows drawn before "Show all N". */
export const CHANGED_FILES_CAP = 50;
/** A tree is the automatic view from this many files, when they span more than one folder. */
export const CHANGED_FILES_TREE_MIN = 5;
export const CHANGED_FILES_VIEW_KEY = "sightr:v2:changed-files-view";

type View = "tree" | "flat";

// ── The per-device view preference ──────────────────────────────────────────────────────────────

let override: View | null | undefined; // undefined: not read yet
const listeners = new Set<() => void>();

function readOverride(): View | null {
  if (override !== undefined) return override;
  try {
    const stored = window.localStorage.getItem(CHANGED_FILES_VIEW_KEY);
    override = stored === "tree" || stored === "flat" ? stored : null;
  } catch {
    override = null;
  }
  return override;
}

function setOverride(view: View): void {
  override = view;
  try {
    window.localStorage.setItem(CHANGED_FILES_VIEW_KEY, view);
  } catch {
    // Private window or blocked storage: the choice holds until the page reloads.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test helper: forget the cached preference so the next read goes to storage. */
export function __resetChangedFilesView(): void {
  override = undefined;
  for (const l of listeners) l();
}

/** The view a card shows: the device's choice, else a tree when the files span folders and number enough. */
export function autoChangedFilesView(paths: ReadonlyArray<string>): View {
  const dirs = new Set(paths.map((path) => path.slice(0, Math.max(0, path.lastIndexOf("/")))));
  return dirs.size > 1 && paths.length >= CHANGED_FILES_TREE_MIN ? "tree" : "flat";
}

// ── The card ────────────────────────────────────────────────────────────────────────────────────

export const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection(props: {
  threadId: string;
  runId: string;
  summary: RunChangedFiles;
}) {
  const { threadId, runId, summary } = props;
  const ui = useThreadTimelineUi(threadId);
  const collapsedDirs = collapsedChangedDirsOf(ui, runId);
  const [showAll, setShowAll] = useState(false);
  const chosen = useSyncExternalStore(subscribe, readOverride, () => null);

  const total = summary.rows.length;
  const rows = showAll || total <= CHANGED_FILES_CAP ? summary.rows : summary.rows.slice(0, CHANGED_FILES_CAP);
  const view = chosen ?? autoChangedFilesView(summary.rows.map((row) => row.path));
  const dirPaths = view === "tree" ? collectChangedDirectoryPaths(rows) : [];
  const allCollapsed = dirPaths.length > 0 && dirPaths.every((dir) => collapsedDirs.has(dir));

  const onToggleDir = useCallback((dir: string) => toggleChangedDir(threadId, runId, dir), [threadId, runId]);
  const onSelect = useCallback((path: string) => openChangedFile({ threadId, runId, path }), [threadId, runId]);

  const heading = summary.files === 0 ? "No files changed" : `Changed files (${summary.files})`;
  const caveat = summary.shellRan || summary.editedTwice;

  return (
    <section
      aria-label="Changed files"
      className="mt-1 rounded-lg bg-secondary dark:bg-input/20"
      data-thread-find-ignore=""
      data-changed-files={runId}
      data-changed-files-view={view}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-foreground">
          <span>{heading}</span>
          {summary.files > 0 && hasNonZeroStat(summary) ? (
            <DiffStatLabel additions={summary.additions} deletions={summary.deletions} layout="inline" className="text-xs leading-4" />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {view === "tree" && dirPaths.length > 0 ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              className="pointer-coarse:min-h-11"
              onClick={() => setChangedDirsCollapsed(threadId, runId, allCollapsed ? [] : dirPaths)}
            >
              {allCollapsed ? "Expand all" : "Collapse all"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            className="pointer-coarse:size-11"
            aria-label={view === "tree" ? "Show as a list" : "Show as a tree"}
            aria-pressed={chosen !== null}
            onClick={() => setOverride(view === "tree" ? "flat" : "tree")}
          >
            {view === "tree" ? <ListIcon className="size-3" /> : <ListTreeIcon className="size-3" />}
          </Button>
        </div>
      </div>
      {total > 0 ? <ChangedFilesTree rows={rows} view={view} collapsedDirs={collapsedDirs} onToggleDir={onToggleDir} onSelect={onSelect} /> : null}
      {total > CHANGED_FILES_CAP && !showAll ? (
        <div className="px-3 pb-2">
          <Button type="button" size="xs" variant="ghost-muted" className="pointer-coarse:min-h-11" onClick={() => setShowAll(true)}>
            Show all {total}
          </Button>
        </div>
      ) : null}
      {caveat ? (
        <p className="px-3 pb-2 text-2xs text-muted-foreground" data-changed-files-caveat="">
          Counts add up each edit and miss changes made by shell commands.
        </p>
      ) : null}
    </section>
  );
});
