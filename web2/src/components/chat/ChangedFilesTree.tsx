// Adapted from T3 Code apps/web/src/components/chat/ChangedFilesTree.tsx @ 3a4d118a518a (MIT, see THIRD_PARTY.md).
// Kept: the tree of `buildTurnDiffTree` (compacted single-child directories, per-directory stat roll-up),
// the folder row with its chevron and `aria-expanded`, the 8 px + 14 px-per-level indent, the file row
// with `DiffStatLabel` at the right.
// Changes from upstream:
// - Rows are Sightr's `ChangedFileRow` (T24); a tap calls `onSelect(path)`, not `onOpenTurnDiff`.
// - A row carries marks: "new" (created), "failed", and a pulse while an edit runs. A row with no
//   counts (`countsKnown` false, or only failed/running edits) shows no `+/-`.
// - A path wraps (no middle truncation: a 360 px lane has no room, and the tail is what tells files
//   apart); `pointer-coarse:min-h-11` makes the row a 44 px target on touch.
// - A flat view (`view="flat"`): one row per file with its folder dim, for a few files in one place.
// - Folding is the caller's: `collapsedDirs` + `onToggleDir` (`state/timeline.ts` keeps them per run),
//   not component state, so a card the list unmounts comes back as it was left. The "Collapse all" /
//   "Expand all" button and the header live in `AssistantChangedFilesSection`.
// - Left out: Pierre file icons, MorphIcon, tooltips, the context menu, the "Open diff" button, the
//   sticky header and the card frame (T27 brings the diff panel).
import { ChevronRightIcon, FileIcon, FolderClosedIcon, FolderOpenIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { cn } from "~/lib/utils";
import { buildTurnDiffTree, type TurnDiffTreeFileNode, type TurnDiffTreeNode } from "~/lib/turnDiffTree";

import type { ChangedFileRow } from "./ChangedFiles.logic";
import { DiffStatLabel } from "./DiffStatLabel";

/** The path a tree node carries: `buildTurnDiffTree` drops empty segments (a leading `/`). */
function treePath(path: string): string {
  return path.split("/").filter((segment) => segment.length > 0).join("/");
}

/** Every directory path in the tree of `rows` (what "Collapse all" folds). */
export function collectChangedDirectoryPaths(rows: ReadonlyArray<ChangedFileRow>): string[] {
  const out: string[] = [];
  const walk = (nodes: ReadonlyArray<TurnDiffTreeNode>) => {
    for (const node of nodes) {
      if (node.kind !== "directory") continue;
      out.push(node.path);
      walk(node.children);
    }
  };
  walk(buildTurnDiffTree(rows.map(toTurnDiffFile)));
  return out;
}

function toTurnDiffFile(row: ChangedFileRow) {
  return row.countsKnown ? { path: row.path, additions: row.additions, deletions: row.deletions } : { path: row.path };
}

const ROW_CLASS =
  "group flex w-full items-start gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background pointer-coarse:min-h-11 pointer-coarse:py-2.5";

function RowMarks({ row }: { row: ChangedFileRow }) {
  return (
    <>
      {row.created ? (
        <span data-mark="new" className="shrink-0 rounded-full border border-success/30 bg-success/8 px-1.5 text-3xs leading-4 text-success">
          new
        </span>
      ) : null}
      {row.failed > 0 ? (
        <span data-mark="failed" className="shrink-0 rounded-full border border-destructive/25 bg-destructive/8 px-1.5 text-3xs leading-4 text-destructive">
          failed
        </span>
      ) : null}
      {row.running ? (
        <span
          data-mark="running"
          role="img"
          aria-label="Editing now"
          className="mt-1.5 size-1.5 shrink-0 rounded-full bg-info motion-safe:animate-status-pulse"
        />
      ) : null}
    </>
  );
}

function RowStat({ row }: { row: ChangedFileRow }) {
  if (!row.countsKnown) return null;
  return (
    <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
      <DiffStatLabel additions={row.additions} deletions={row.deletions} />
    </span>
  );
}

export const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  rows: ReadonlyArray<ChangedFileRow>;
  view: "tree" | "flat";
  collapsedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const { rows, view, collapsedDirs, onToggleDir, onSelect } = props;

  const tree = useMemo(() => {
    const nodes = buildTurnDiffTree(rows.map(toTurnDiffFile));
    // Each file node gets its row by walking in order: two rows can share a tree path (`/a/b` and
    // `a/b`), so the node's own path is not a key.
    const queues = new Map<string, ChangedFileRow[]>();
    for (const row of rows) {
      const key = treePath(row.path);
      const list = queues.get(key);
      if (list) list.push(row);
      else queues.set(key, [row]);
    }
    const rowByNode = new Map<TurnDiffTreeFileNode, ChangedFileRow>();
    const walk = (list: ReadonlyArray<TurnDiffTreeNode>) => {
      for (const node of list) {
        if (node.kind === "directory") walk(node.children);
        else {
          const row = queues.get(node.path)?.shift();
          if (row) rowByNode.set(node, row);
        }
      }
    };
    walk(nodes);
    return { nodes, rowByNode };
  }, [rows]);

  if (view === "flat") {
    return (
      <div className="p-2" data-changed-files-view="flat">
        {rows.map((row) => {
          const slash = row.path.lastIndexOf("/");
          const dir = slash >= 0 ? row.path.slice(0, slash + 1) : "";
          const name = slash >= 0 ? row.path.slice(slash + 1) : row.path;
          return (
            <button key={row.path} type="button" data-changed-file={row.path} className={cn(ROW_CLASS, "pl-2")} onClick={() => onSelect(row.path)}>
              <FileIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 flex-1 font-mono text-xs wrap-anywhere" data-changed-file-label="">
                {dir ? <span className="text-muted-foreground/70">{dir}</span> : null}
                <span className="text-foreground/85 group-hover:text-foreground">{name}</span>
              </span>
              <RowMarks row={row} />
              <RowStat row={row} />
            </button>
          );
        })}
      </div>
    );
  }

  const renderNode = (node: TurnDiffTreeNode, depth: number, hasDirectories: boolean) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded = !collapsedDirs.has(node.path);
      const hasStat = node.stat.additions > 0 || node.stat.deletions > 0;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            data-scroll-anchor-ignore
            data-changed-dir={node.path}
            aria-expanded={isExpanded}
            className={ROW_CLASS}
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => onToggleDir(node.path)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80", isExpanded && "rotate-90")}
            />
            {isExpanded ? (
              <FolderOpenIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/75" />
            ) : (
              <FolderClosedIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/75" />
            )}
            <span className="min-w-0 flex-1 font-mono text-2xs text-muted-foreground/90 wrap-anywhere group-hover:text-foreground/90">{node.name}</span>
            {hasStat ? (
              <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
              </span>
            ) : null}
          </button>
          {isExpanded ? <div>{node.children.map((child) => renderNode(child, depth + 1, hasDirectories))}</div> : null}
        </div>
      );
    }
    const row = tree.rowByNode.get(node);
    if (!row) return null;
    return (
      <button
        key={`file:${row.path}`}
        type="button"
        data-changed-file={row.path}
        className={ROW_CLASS}
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onSelect(row.path)}
      >
        {hasDirectories || depth > 0 ? <span aria-hidden="true" className="size-3.5 shrink-0" /> : null}
        <FileIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 font-mono text-xs text-foreground/85 wrap-anywhere group-hover:text-foreground" data-changed-file-label="">
          {node.name}
        </span>
        <RowMarks row={row} />
        <RowStat row={row} />
      </button>
    );
  };

  const hasDirectories = tree.nodes.some((node) => node.kind === "directory");
  return (
    <div className="p-2" data-changed-files-view="tree">
      {tree.nodes.map((node) => renderNode(node, 0, hasDirectories))}
    </div>
  );
});
