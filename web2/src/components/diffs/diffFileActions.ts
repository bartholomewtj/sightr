// Sightr code (T27). What a file in the Diff panel can do, and what it is called. The spec named an upstream
// `diffs/diffFileActions.ts` to adapt; T3 Code has no such file at any commit in the cache (its file actions
// live inside `DiffPanel.tsx` and the Pierre tree's context menu), so this is Sightr's own and has no ledger row.
import type { ReviewFileKind } from "@shared/v2/review";

import { repoFilePath } from "../right-panel/GitPanel.logic";
import type { DiffFileEntry } from "./diffTypes";

/** The letter chip and the word a screen reader hears for it. */
export const KIND_CHIP: Record<ReviewFileKind, { letter: string; word: string }> = {
  added: { letter: "A", word: "added" },
  modified: { letter: "M", word: "modified" },
  deleted: { letter: "D", word: "deleted" },
  renamed: { letter: "R", word: "renamed" },
  untracked: { letter: "?", word: "untracked" },
};

/** Files can open a file that is on disk: not a deleted one. */
export function canOpenInFiles(file: Pick<DiffFileEntry, "kind">): boolean {
  return file.kind !== "deleted";
}

/** The Files rel path of a repo-relative path. `rootPath` is the repo root's Files path (`""` is the Files root). */
export function filesPathOf(rootPath: string, path: string): string {
  return repoFilePath(rootPath, path);
}

/** "src/a.ts" or, for a rename, "src/old.ts → src/a.ts". */
export function fileLabel(file: Pick<DiffFileEntry, "path" | "oldPath">): string {
  return file.oldPath !== undefined && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
}

/** "3 edits" for a file edited more than once in a run; empty otherwise. */
export function editsLabel(edits: number | undefined): string {
  return edits !== undefined && edits > 1 ? `${edits} edits` : "";
}
