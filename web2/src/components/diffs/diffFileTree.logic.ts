// Adapted from T3 Code apps/web/src/components/diffs/diffFileTree.logic.ts @ 3a4d118a518a (MIT, see THIRD_PARTY.md).
// Kept: `collectDirectoryPaths` (every ancestor once, parents first; Pierre's trailing slash dropped), the
// per-path status folding of `diffFileTreeEntries` (a path listed twice with different statuses is "modified").
// Changes: Pierre's types (`FileDiffMetadata`, `GitStatus`) are replaced by local ones, and T3's
// `diffFileTreePositions`, `compareDiffFileTreeEntries` and `buildDiffFileTreeUpdates` (reading order and
// imperative updates for `@pierre/trees`, not taken) are left out: the tree is our own `role="tree"` over
// `buildTurnDiffTree` (T24: folders first, single-child folders compressed, folder totals).
import { buildTurnDiffTree, type TurnDiffTreeNode } from "~/lib/turnDiffTree";

import type { DiffFileEntry } from "./diffTypes";

export type DiffTreeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface DiffFileTreeEntry {
  readonly path: string;
  readonly status: DiffTreeStatus;
}

/** One entry per path; a path listed twice with different statuses reads as modified (a file-to-symlink change). */
export function diffFileTreeEntries(files: ReadonlyArray<Pick<DiffFileEntry, "path" | "kind">>): ReadonlyArray<DiffFileTreeEntry> {
  const statusByPath = new Map<string, DiffTreeStatus>();
  for (const file of files) {
    const previous = statusByPath.get(file.path);
    statusByPath.set(file.path, previous === undefined || previous === file.kind ? file.kind : "modified");
  }
  return [...statusByPath].map(([path, status]) => ({ path, status }));
}

/** Every ancestor directory of `paths` once, parents first, without a trailing slash. */
export function collectDirectoryPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    let directory = "";
    for (const segment of path.split("/").slice(0, -1)) {
      directory = directory ? `${directory}/${segment}` : segment;
      directories.add(directory);
    }
  }
  return [...directories];
}

/** The tree of a file list: compressed single-child folders, folders before files, folder +/- totals. */
export function buildDiffTree(files: ReadonlyArray<DiffFileEntry>): TurnDiffTreeNode[] {
  return buildTurnDiffTree(files.map((f) => (f.countsKnown ? { path: f.path, additions: f.added, deletions: f.removed } : { path: f.path })));
}

/** The files in the order the tree reads, top to bottom: the order the diffs are listed in, so the tree and the page agree. */
export function treeOrder(files: ReadonlyArray<DiffFileEntry>): DiffFileEntry[] {
  const byPath = new Map<string, DiffFileEntry[]>();
  for (const f of files) {
    const list = byPath.get(f.path);
    if (list) list.push(f);
    else byPath.set(f.path, [f]);
  }
  const out: DiffFileEntry[] = [];
  const walk = (nodes: ReadonlyArray<TurnDiffTreeNode>) => {
    for (const node of nodes) {
      if (node.kind === "directory") walk(node.children);
      else {
        const hit = byPath.get(node.path)?.shift();
        if (hit) out.push(hit);
      }
    }
  };
  walk(buildDiffTree(files));
  // A path the tree could not place (an empty or all-slash name) still gets listed.
  for (const list of byPath.values()) out.push(...list);
  return out;
}

/** Every directory node's path in the tree (what "fold all" would close). */
export function treeDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    out.push(node.path);
    out.push(...treeDirectoryPaths(node.children));
  }
  return out;
}

export interface DiffTotals {
  files: number;
  added: number;
  removed: number;
}

export function diffTotals(files: ReadonlyArray<DiffFileEntry>): DiffTotals {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    if (!f.countsKnown) continue;
    added += f.added;
    removed += f.removed;
  }
  return { files: files.length, added, removed };
}
