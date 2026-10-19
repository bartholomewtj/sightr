// Sightr code (T31). What a run changed, resolved once for both surfaces that show it (the changed-files card under
// the run's reply and the Diff panel's run scope): the run's git checkpoint when it has a usable one (T30), else the
// journal's edits (T24). The precedence is the "Fallback matrix" of docs/specs/t3/T31-checkpoint-ui.md. Pure and
// clock-free apart from the `now` it is given, so every row of the matrix is a fixture.
//
// Invariants kept here: "Exact" (`source: "checkpoint"`) comes only from a `ready` checkpoint; checkpoint and journal
// numbers are never added or merged (`additions`/`deletions` are the chosen source's own totals); the journal is read
// for names only when it must say what the checkpoint left out (a reverted edit) or what it saw (the empty-net line).
import type { CheckpointAbsentReason, CheckpointFile, Run, RunCheckpoint } from "@shared/v2/contracts";

import type { ChangedFileRow, RunChangedFiles } from "@/components/chat/ChangedFiles.logic";

import { isRefusedName } from "./refusedPaths";

/** How long an ended run waits for a `pending` checkpoint before the journal is shown instead. */
export const FINISHING_GRACE_MS = 10_000;

/** Why the journal is shown although a snapshot was expected. The first eight are T30's absent reasons. */
export type FallbackReason = CheckpointAbsentReason | "no-checkpoint" | "finishing-timeout";

export type RunChangesState =
  /** A `ready` checkpoint with files (or files it could not show). */
  | "ready"
  /** A `ready` checkpoint whose end tree equals its start tree. */
  | "empty"
  /** The run is still working; the journal is shown. */
  | "running"
  /** The run ended and its checkpoint is still `pending`, for up to `FINISHING_GRACE_MS`; the journal is shown. */
  | "finishing"
  /** The journal is shown because there is no usable checkpoint. */
  | "fallback"
  /** No checkpoint and no journal items. */
  | "none";

export interface RunChanges {
  /** `checkpoint` only for a `ready` checkpoint. The badge reads "Exact" for it and "From agent edits" otherwise. */
  source: "checkpoint" | "journal";
  state: RunChangesState;
  /** Card rows, in the source's order. A checkpoint row carries `shell` when no edit tool reported the path. */
  files: ReadonlyArray<ChangedFileRow>;
  /** The source's own totals (a checkpoint's sum every file, also the ones past its list cap). */
  additions: number;
  deletions: number;
  /** Paths the journal edited that the checkpoint does not list (undone, or reverted by a command). Checkpoint source only. */
  reverted: ReadonlyArray<string>;
  revertedCount: number;
  /** Files the journal counted for this run (the empty-net line says "The agent edited N files"). */
  journalCount: number;
  /** The checkpoint's list was cut at its cap. */
  truncated: boolean;
  /** Paths the snapshot refused or could not read (`hidden` + `skipped`). */
  notShown: number;
  /** The snapshot objects still exist, so ignore-whitespace and expand-context can work. False for the journal. */
  live: boolean;
  shared: boolean;
  approximate: boolean;
  unsettled: boolean;
  /** Set for every non-checkpoint state that has a cause worth saying. */
  reason?: FallbackReason;
}

export interface ResolveRunChangesInput {
  run?: Pick<Run, "status" | "completedAt" | "checkpoint"> | null;
  /** Defaults to `run.checkpoint`. */
  checkpoint?: RunCheckpoint | null;
  journalFiles?: RunChangedFiles | null;
  /** Epoch ms; for the finishing grace. */
  now?: number;
}

/** A journal path and a checkpoint path name the same file: equal, or the journal's is the checkpoint's under a folder. */
export function samePath(journalPath: string, checkpointPath: string): boolean {
  return journalPath === checkpointPath || journalPath.endsWith(`/${checkpointPath}`);
}

function rowOfCheckpointFile(file: CheckpointFile): ChangedFileRow {
  return {
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    countsKnown: file.binary !== true,
    edits: 0,
    itemIds: [],
    created: file.kind === "added",
    failed: 0,
    running: false,
    truncated: false,
    ...(file.authored === false ? { shell: true } : {}),
    ...(file.kind === "deleted" ? { deleted: true } : {}),
    ...(file.binary ? { binary: true } : {}),
  };
}

const isRefused = (path: string): boolean => path.split("/").some((segment) => segment !== "" && isRefusedName(segment));

/** Journal rows with an edit that landed or is landing. A path with only failed edits changed nothing. */
function editedRows(journal: RunChangedFiles | null | undefined): ReadonlyArray<ChangedFileRow> {
  return journal ? journal.rows.filter((row) => row.edits > 0 || row.running) : [];
}

export function resolveRunChanges(input: ResolveRunChangesInput): RunChanges {
  const { run, journalFiles } = input;
  const checkpoint = input.checkpoint === undefined ? run?.checkpoint : input.checkpoint;
  const now = input.now ?? Date.now();
  const journalCount = journalFiles?.files ?? 0;
  const base = { reverted: [] as string[], revertedCount: 0, journalCount, truncated: false, notShown: 0, live: false, shared: false, approximate: false, unsettled: false };

  if (checkpoint?.status === "ready") {
    const files = checkpoint.files.map(rowOfCheckpointFile);
    // The list cap hides the rest and an unreadable file was left out of the snapshot: an edit the list lacks may not be undone then.
    // A refused name is never listed, so it is skipped by name below.
    const whole = checkpoint.truncated !== true && !checkpoint.skipped;
    const reverted = whole
      ? editedRows(journalFiles)
          .map((row) => row.path)
          .filter((path) => !checkpoint.files.some((f) => samePath(path, f.path)) && !isRefused(path))
      : [];
    const notShown = (checkpoint.hidden ?? 0) + (checkpoint.skipped ?? 0);
    return {
      ...base,
      source: "checkpoint",
      state: files.length > 0 || notShown > 0 ? "ready" : "empty",
      files,
      additions: checkpoint.additions,
      deletions: checkpoint.deletions,
      reverted,
      revertedCount: reverted.length,
      truncated: checkpoint.truncated === true,
      notShown,
      live: checkpoint.live !== false,
      shared: checkpoint.shared === true,
      approximate: checkpoint.approximate === true,
      unsettled: checkpoint.unsettled === true,
    };
  }

  // Everything below is the journal.
  const journal = {
    ...base,
    source: "journal" as const,
    files: journalFiles?.rows ?? [],
    additions: journalFiles?.additions ?? 0,
    deletions: journalFiles?.deletions ?? 0,
  };
  const absentReason: FallbackReason | undefined = checkpoint?.status === "absent" ? (checkpoint.reason ?? "git-failed") : checkpoint ? undefined : "no-checkpoint";
  const withState = (state: RunChangesState, reason: FallbackReason | undefined): RunChanges => {
    const hasJournal = journal.files.length > 0;
    return { ...journal, state: hasJournal ? state : "none", ...(reason === undefined ? {} : { reason }) };
  };

  if (run?.status === "running") return withState("running", absentReason);
  if (checkpoint?.status === "pending") {
    const ended = run?.completedAt ?? now;
    return now - ended < FINISHING_GRACE_MS ? withState("finishing", undefined) : withState("fallback", "finishing-timeout");
  }
  return withState("fallback", absentReason);
}

/** The sheet's line for a fallback: what happened, in words. */
export const FALLBACK_REASON_TEXT: Record<FallbackReason, string> = {
  disabled: "Snapshots are off for this project.",
  "no-repo": "This folder isn't a git repository.",
  "start-missed": "Sightr wasn't watching when the run started.",
  "end-missed": "Sightr wasn't watching when the run ended.",
  "too-large": "The folder is too large to snapshot.",
  timeout: "The snapshot took too long.",
  "git-failed": "Git couldn't take the snapshot.",
  "sparse-checkout": "A folder outside this repo's sparse checkout is on disk.",
  "no-checkpoint": "This run has no snapshot.",
  "finishing-timeout": "The snapshot didn't arrive.",
};

export function fallbackReasonText(reason: string): string {
  return (FALLBACK_REASON_TEXT as Record<string, string>)[reason] ?? "There is no snapshot for this run.";
}

/** Whether the card (and the picker) has anything to show for a run: a card is never drawn for a run that changed nothing and was never edited. */
export function hasRunChanges(changes: RunChanges): boolean {
  if (changes.state === "none") return false;
  if (changes.state === "empty") return changes.journalCount > 0;
  return true;
}

/** What the card or panel redraws on: every field a surface reads from a checkpoint. */
export function checkpointSignature(cp: RunCheckpoint | undefined | null): string {
  if (!cp) return "";
  return [
    cp.status,
    cp.reason ?? "",
    cp.live === false ? "x" : "l",
    cp.additions,
    cp.deletions,
    cp.truncated ? "t" : "",
    cp.hidden ?? 0,
    cp.skipped ?? 0,
    cp.shared ? "s" : "",
    cp.approximate ? "a" : "",
    cp.unsettled ? "u" : "",
    ...cp.files.map((f) => `${f.path},${f.kind},${f.additions},${f.deletions},${f.binary ? "b" : ""},${f.authored === false ? "sh" : ""}`),
  ].join("|");
}
