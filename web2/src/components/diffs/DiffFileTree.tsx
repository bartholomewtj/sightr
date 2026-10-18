// Pattern from T3 Code apps/web/src/components/diffs/DiffFileTree.tsx @ 3a4d118a518a (MIT, see THIRD_PARTY.md).
// T3 draws the changed files with `@pierre/trees` (a beta, not taken) in a shadow root, with git status
// decorations and a context menu. Sightr's is its own `role="tree"` over `buildTurnDiffTree` (T24:
// single-child folders compressed, folders before files, folder +N/-M totals): a status chip and the +N/-M
// on each file, a chevron on each folder, the path wrapping rather than truncating, and 44 px rows on a
// touch screen. Folding is the caller's (`collapsedDirs`), so it survives the tree being unmounted.
import { ChevronRightIcon, FolderClosedIcon, FolderOpenIcon } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "../chat/DiffStatLabel";

import { buildDiffTree, diffFileTreeEntries } from "./diffFileTree.logic";
import { DiffFileStatus } from "./DiffFileStatus";
import type { DiffFileEntry } from "./diffTypes";
import type { TurnDiffTreeNode } from "~/lib/turnDiffTree";

const ROW =
  "group flex w-full items-start gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:py-2.5";

export const DiffFileTree = memo(function DiffFileTree(props: {
  files: ReadonlyArray<DiffFileEntry>;
  collapsedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  onSelect: (path: string) => void;
  /** The file the page is on, marked in the tree. */
  activePath?: string | null;
}) {
  const { files, collapsedDirs, onToggleDir, onSelect, activePath } = props;
  const nodes = useMemo(() => buildDiffTree(files), [files]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f] as const)), [files]);
  const status = useMemo(() => new Map(diffFileTreeEntries(files).map((e) => [e.path, e.status] as const)), [files]);

  const renderNode = (node: TurnDiffTreeNode, depth: number): ReactNode => {
    const pad = 8 + depth * 14;
    if (node.kind === "directory") {
      const open = !collapsedDirs.has(node.path);
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={open}
            data-diff-tree-dir={node.path}
            className={ROW}
            style={{ paddingLeft: pad }}
            onClick={() => onToggleDir(node.path)}
          >
            <ChevronRightIcon aria-hidden="true" className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform", open && "rotate-90")} />
            {open ? (
              <FolderOpenIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
            ) : (
              <FolderClosedIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
            )}
            <span className="min-w-0 flex-1 font-mono text-xs wrap-anywhere text-muted-foreground">{node.name}</span>
            {hasNonZeroStat(node.stat) ? (
              <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
              </span>
            ) : null}
          </button>
          {open ? <div role="group">{node.children.map((child) => renderNode(child, depth + 1))}</div> : null}
        </div>
      );
    }
    const file = byPath.get(node.path);
    const kind = status.get(node.path) ?? file?.kind ?? "modified";
    return (
      <button
        key={`file:${node.path}`}
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={activePath === node.path}
        data-diff-tree-file={node.path}
        className={cn(ROW, activePath === node.path && "bg-accent")}
        style={{ paddingLeft: pad + 16 }}
        onClick={() => onSelect(node.path)}
      >
        <DiffFileStatus kind={kind} className="mt-0.5" />
        <span className="min-w-0 flex-1 font-mono text-xs wrap-anywhere">{node.name}</span>
        {file?.binary ? (
          <span className="ml-auto shrink-0 font-mono text-3xs text-muted-foreground">binary</span>
        ) : file?.whitespaceOnly ? (
          <span className="ml-auto shrink-0 font-mono text-3xs text-muted-foreground" data-diff-whitespace-only="">whitespace only</span>
        ) : node.stat && hasNonZeroStat(node.stat) ? (
          <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div role="tree" aria-label="Changed files" className="p-1" data-diff-tree="">
      {nodes.map((node) => renderNode(node, 0))}
    </div>
  );
});
