// Pattern from T3 Code packages/client-runtime/src/state/threadCheckpoints.ts @ 3a4d118a518a (MIT, see THIRD_PARTY.md).
// The same job as T3's `deriveThreadCheckpointSummaries`: one summary of the files a run changed, for
// the card under that run's reply. T3 reads its git checkpoints; this reads the journal's `file_change` items
// (T24). Counts are the sum of the agent's edits, not the net change of the file, and edits made through a shell
// command are not seen at all. T31 puts the run's checkpoint (T30) first where there is a ready one
// (`lib/runChanges.ts`); this stays the fallback, and says what the agent edited when the checkpoint cannot.
import type { TimelineEntry } from "~/session-logic";
import type { TurnItem } from "@shared/v2/contracts";

export interface ChangedFileRow {
  /** Normalised: `/` separators, no leading `./`; exact case. */
  readonly path: string;
  /** Sum over the completed edits. */
  readonly additions: number;
  readonly deletions: number;
  /** False when a completed edit has no counts (the journal built only `oldStr`/`newStr`), or none completed. */
  readonly countsKnown: boolean;
  /** Completed edits of this path in this run. */
  readonly edits: number;
  /** Every `file_change` item of this path in this run, in item order (failed and running ones too). */
  readonly itemIds: readonly string[];
  /** A completed edit whose diff starts `--- /dev/null` (the bridge's new-file Write). */
  readonly created: boolean;
  /** Items that failed, were cancelled or were interrupted. Never summed. */
  readonly failed: number;
  /** The first failed item's own error text. */
  readonly errorText?: string;
  /** An edit still pending or running. */
  readonly running: boolean;
  /** An item's diff was cut by the journal (the counts were taken before the cut). */
  readonly truncated: boolean;
  /** T31, a row built from a checkpoint file (never set on a journal row): no edit tool reported this path, so a shell command made the change. */
  readonly shell?: boolean;
  /** T31, checkpoint rows: the file is gone at the end of the run. */
  readonly deleted?: boolean;
  /** T31, checkpoint rows: a binary file (no counts). */
  readonly binary?: boolean;
}

export interface RunChangedFiles {
  readonly runId: string;
  /** Rows in the order each path was first touched. */
  readonly rows: readonly ChangedFileRow[];
  readonly additions: number;
  readonly deletions: number;
  /** Paths with a completed or running edit (a path with only failed edits is listed but not counted). */
  readonly files: number;
  /** Failed, cancelled and interrupted edits. */
  readonly failedEdits: number;
  /** The run ran a shell command, which can change files the journal never sees. */
  readonly shellRan: boolean;
  /** Some file was edited more than once, so its counts add up each edit. */
  readonly editedTwice: boolean;
}

/** `\` to `/`, no leading `./`, exact case. An empty result means no usable path. */
export function normalizeChangedPath(raw: string): string {
  let path = raw.trim().replaceAll("\\", "/");
  while (path.startsWith("./")) path = path.slice(2);
  return path;
}

const FAILED_STATUSES: ReadonlySet<string> = new Set(["failed", "cancelled", "interrupted"]);

interface MutableRow {
  path: string;
  additions: number;
  deletions: number;
  completed: number;
  countless: number;
  itemIds: string[];
  created: boolean;
  failed: number;
  errorText?: string;
  running: boolean;
  truncated: boolean;
}

/** The summary of one run from its items (any order; they are taken as given). */
function summarizeRun(runId: string, items: ReadonlyArray<TurnItem>): RunChangedFiles | null {
  const byPath = new Map<string, MutableRow>();
  let shellRan = false;
  for (const item of items) {
    if (item.type === "command_execution") shellRan = true;
    if (item.type !== "file_change") continue;
    const path = normalizeChangedPath(item.fileName);
    if (path === "") continue;
    let row = byPath.get(path);
    if (!row) {
      row = { path, additions: 0, deletions: 0, completed: 0, countless: 0, itemIds: [], created: false, failed: 0, running: false, truncated: false };
      byPath.set(path, row);
    }
    row.itemIds.push(item.id);
    if (item.truncated) row.truncated = true;
    if (item.status === "completed") {
      row.completed += 1;
      if (item.additions === undefined && item.deletions === undefined) row.countless += 1;
      row.additions += item.additions ?? 0;
      row.deletions += item.deletions ?? 0;
      if (item.diffStr?.startsWith("--- /dev/null")) row.created = true;
    } else if (FAILED_STATUSES.has(item.status)) {
      row.failed += 1;
      if (row.errorText === undefined && item.errorText?.trim()) row.errorText = item.errorText;
    } else {
      row.running = true;
    }
  }
  if (byPath.size === 0) return null;

  const rows: ChangedFileRow[] = [];
  let additions = 0;
  let deletions = 0;
  let files = 0;
  let failedEdits = 0;
  let editedTwice = false;
  for (const row of byPath.values()) {
    const countsKnown = row.completed > 0 && row.countless === 0;
    rows.push({
      path: row.path,
      additions: row.additions,
      deletions: row.deletions,
      countsKnown,
      edits: row.completed,
      itemIds: row.itemIds,
      created: row.created,
      failed: row.failed,
      ...(row.errorText === undefined ? {} : { errorText: row.errorText }),
      running: row.running,
      truncated: row.truncated,
    });
    additions += row.additions;
    deletions += row.deletions;
    failedEdits += row.failed;
    if (row.completed > 0 || row.running) files += 1;
    if (row.completed > 1) editedTwice = true;
  }
  return { runId, rows, additions, deletions, files, failedEdits, shellRan, editedTwice };
}

/** The changed-files summary of each run that has a `file_change` item, from raw items. Runless items are skipped. */
export function deriveRunChangedFilesFromItems(items: ReadonlyArray<TurnItem>): Map<string, RunChangedFiles> {
  const byRun = new Map<string, TurnItem[]>();
  for (const item of items) {
    if (item.runId === null) continue;
    const list = byRun.get(item.runId);
    if (list) list.push(item);
    else byRun.set(item.runId, [item]);
  }
  const out = new Map<string, RunChangedFiles>();
  for (const [runId, list] of byRun) {
    const summary = summarizeRun(runId, list);
    if (summary) out.set(runId, summary);
  }
  return out;
}

/**
 * The changed-files summary of each run, from the timeline entries (`entry.projectedItem`, so work a
 * fold hides still counts). O(entries). A run with no `file_change` item has no summary.
 */
export function deriveRunChangedFiles(entries: ReadonlyArray<TimelineEntry>): Map<string, RunChangedFiles> {
  const items: TurnItem[] = [];
  for (const entry of entries) {
    if (entry.kind === "work" && entry.entry.projectedItem) items.push(entry.entry.projectedItem);
  }
  return deriveRunChangedFilesFromItems(items);
}

/** What `isRowUnchanged` compares: everything the card draws, none of the diff bodies. */
export function changedFilesSignature(summary: RunChangedFiles): string {
  return [
    summary.shellRan ? "sh" : "",
    ...summary.rows.map((row) =>
      [
        row.path,
        row.additions,
        row.deletions,
        row.countsKnown ? "k" : "u",
        row.edits,
        row.failed,
        row.running ? "r" : "",
        row.created ? "c" : "",
        row.truncated ? "t" : "",
        row.itemIds.length,
      ].join(","),
    ),
  ].join("|");
}
