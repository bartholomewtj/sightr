// Sightr code (T31). What the Diff panel's run scope shows, as one value: the types and a mapper from `resolveRunChanges`
// plus the outcome of loading the exact diff. No reducer: every input is already a value (the thread stream, the patch
// hook), so the state is derived on each render, never stored.
import type { ChangedFileRow } from "@/components/chat/ChangedFiles.logic";
import type { RunChanges } from "@/lib/runChanges";

import type { DiffFileEntry } from "../diffs/diffTypes";

export type CheckpointDiffState =
  /** The thread is not loaded yet. */
  | { status: "loading" }
  /** The run is working, or just ended and its snapshot is being finished: the journal's files, with a strip saying so. */
  | { status: "running"; phase: "working" | "finishing"; files: DiffFileEntry[] }
  /**
   * The files to list. `source` is what they came from (`checkpoint` is "Exact"). `loadFailed`: the exact diff could not
   * be read, so these are the journal's files and the panel offers Retry; `source` is `journal` then, and the badge says so.
   */
  | { status: "ready"; source: "checkpoint" | "journal"; files: DiffFileEntry[]; truncated: boolean; loadFailed: boolean }
  /** Nothing to show: `none` is "No recorded changes for this run." */
  | { status: "unavailable"; reason: "none" };

/** A checkpoint row as a panel file. Its patch is fetched per file (`rev` changes when its counts or kind do). */
export function entryOfCheckpointRow(row: ChangedFileRow): DiffFileEntry {
  const kind = row.created ? "added" : row.deleted ? "deleted" : "modified";
  return {
    path: row.path,
    kind,
    added: row.additions,
    removed: row.deletions,
    countsKnown: row.countsKnown,
    ...(row.binary ? { binary: true } : {}),
    rev: `${kind},${row.additions},${row.deletions},${row.binary ? "b" : ""}`,
    ...(row.shell ? { shell: true } : {}),
  };
}

export function checkpointDiffState(input: {
  /** False until the thread stream has delivered this thread. */
  threadLoaded: boolean;
  changes: RunChanges;
  /** The journal's files as the panel lists them (T27's run scope). */
  journalFiles: DiffFileEntry[];
  /** A request for the exact diff threw and has not been retried. */
  fetchFailed: boolean;
}): CheckpointDiffState {
  const { threadLoaded, changes, journalFiles, fetchFailed } = input;
  if (!threadLoaded) return { status: "loading" };
  if (changes.state === "none") return { status: "unavailable", reason: "none" };
  if (changes.source === "checkpoint") {
    // A failed read falls back to the journal's list (never a blank panel); "Exact" is only for data that loaded.
    if (fetchFailed && journalFiles.length > 0) return { status: "ready", source: "journal", files: journalFiles, truncated: false, loadFailed: true };
    return { status: "ready", source: "checkpoint", files: changes.files.map(entryOfCheckpointRow), truncated: changes.truncated, loadFailed: false };
  }
  if (changes.state === "running") return { status: "running", phase: "working", files: journalFiles };
  if (changes.state === "finishing") return { status: "running", phase: "finishing", files: journalFiles };
  return { status: "ready", source: "journal", files: journalFiles, truncated: false, loadFailed: false };
}
