// The diff review API (spec T26): a file list, then one patch or one file at a time, for the working tree
// or a branch. Plain HTTP beside the Git tab routes, where T3 Code serves `review.getDiffPreview` and
// `review.getDiffFileContents` (packages/contracts/src/review.ts) over RPC. Shapes only: names and the
// preview/file-contents split follow T3, the fields are Sightr's (repo-relative paths, short ref names and
// oids; never an absolute path). Types only, so the bridge and web2 can both import it.
import type { FolderGitUnavailable } from "../wire.ts";

export const REVIEW_PATHS = { list: "/api/files/git/review", patch: "/api/files/git/review/patch", contents: "/api/files/git/review/contents", branches: "/api/files/git/branches" } as const;
/**
 * "run" (T30) is a thread run's checkpoint range: `threadId`, `runId` and `file` (a repo path), no `path`.
 * The run's file list is `Run.checkpoint.files` on the thread stream, so only the patch and contents
 * routes take it (`w=1` for ignore-whitespace there). A bridge with v2 off answers 501.
 */
export type ReviewScope = "working-tree" | "branch" | "run";
/** `no-checkpoint`: the run has no `ready` checkpoint. `expired`: its snapshot objects are gone (stored patches still serve with `w=0`). */
export type ReviewUnavailable = FolderGitUnavailable | "no-commits" | "no-base" | "bad-base" | "bad-commit" | "bad-file" | "busy" | "expired" | "no-checkpoint";
export type ReviewFileKind = "added" | "modified" | "deleted" | "renamed" | "untracked";
export interface ReviewFileStat {
  path: string; oldPath?: string; kind: ReviewFileKind; added: number; removed: number;
  binary?: true; tooLarge?: true; whitespaceOnly?: true;
  /** Per-file hash (kind, counts, paths, and the file's size and mtime or content): re-fetch a patch only when it changes. */
  rev: string;
}
export type ReviewDiffPreview = { available: false; reason: ReviewUnavailable } | {
  available: true; scope: "working-tree" | "branch";
  /** Branch scope only: the base's short name, whether it was picked by default, the merge-base oid and the HEAD oid. */
  base?: string; baseIsDefault?: boolean; from?: string; to?: string;
  files: ReviewFileStat[]; hidden: number; truncated: boolean; diffHash: string;
};
export type ReviewDiffFilePatch = { available: false; reason: ReviewUnavailable } | { available: true; patch: string; truncated: boolean; diffHash: string };
export type ReviewSide = { state: "text"; text: string; crlf: boolean } | { state: "absent" } | { state: "binary"; bytes: number } | { state: "too-large"; bytes: number };
export type ReviewDiffFileContents = { available: false; reason: ReviewUnavailable } | { available: true; old: ReviewSide; new: ReviewSide; diffHash: string };
export interface ReviewBranch { name: string; remote: boolean; current?: true; time: number }
export type ReviewBranches = { available: false; reason: ReviewUnavailable } | { available: true; current?: string; detached?: true; defaultBase?: string; branches: ReviewBranch[]; truncated: boolean };
