// Sightr code (T27). What the Diff panel's file list and file bodies are made of, whatever the scope: the
// working tree and a branch fill them from T26's review routes, a run from the thread's journal.
import type { ReviewFileKind, ReviewFileStat } from "@shared/v2/review";

/** One changed file as the tree and the file sections read it. Repo-relative paths only. */
export interface DiffFileEntry {
  path: string;
  /** A rename's previous path. */
  oldPath?: string;
  kind: ReviewFileKind;
  added: number;
  removed: number;
  /** False when the run's journal gave no counts for the file (shown without +/-). */
  countsKnown: boolean;
  binary?: boolean;
  /** The bridge listed the file but will not read it (an untracked file past the size budget). */
  tooLarge?: boolean;
  /** Changes whitespace only (ignore-whitespace is T28's); shown as a plain file. */
  whitespaceOnly?: boolean;
  /** Changes whenever the file's patch should be fetched again (T26's per-file hash; a run's edit signature). */
  rev: string;
  /** Run scope: how many edits the file had in the run. */
  edits?: number;
  /** Run scope, from a checkpoint (T31): no edit tool reported this path, so a shell command made the change. */
  shell?: boolean;
}

export function entryFromStat(file: ReviewFileStat): DiffFileEntry {
  return {
    path: file.path,
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
    kind: file.kind,
    added: file.added,
    removed: file.removed,
    countsKnown: file.binary !== true,
    ...(file.binary ? { binary: true } : {}),
    ...(file.tooLarge ? { tooLarge: true } : {}),
    ...(file.whitespaceOnly ? { whitespaceOnly: true } : {}),
    rev: file.rev,
  };
}

/** Where one file's patch stands. */
export type PatchState =
  | { state: "idle" }
  /** `patch` is the previous one, kept on screen while a newer one loads. */
  | { state: "loading"; patch?: string }
  | { state: "ready"; patch: string }
  | { state: "error"; message: string; retryable: boolean; patch?: string }
  /** The bridge (or the journal) cut the diff, or the file is too large to read at all (`patch` null). */
  | { state: "truncated"; patch: string | null; message: string }
  | { state: "binary" };

export const IDLE: PatchState = { state: "idle" };

/** A patch shown, if any, for whichever state holds one. */
export function patchOf(state: PatchState): string | null {
  switch (state.state) {
    case "loading":
    case "error":
      return state.patch ?? null;
    case "ready":
      return state.patch;
    case "truncated":
      return state.patch;
    default:
      return null;
  }
}
