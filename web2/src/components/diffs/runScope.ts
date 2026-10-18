// Sightr code (T27). The Diff panel's "Run" scope: the files one run changed, read from the thread's journal
// (T24's `file_change` items grouped by path), not from git. It needs no fetch: it follows the thread stream.
// It never claims to be exact: the journal holds each edit on its own (no net diff of a file edited twice),
// misses edits made through a shell command, and a long diff is cut by the journal. T31 swaps the source of
// this adapter for checkpoints and changes nothing else (`useRunScopeFiles` keeps its shape).
import type { TurnItem } from "@shared/v2/contracts";
import { useMemo } from "react";

import { deriveRunChangedFilesFromItems, normalizeChangedPath, type ChangedFileRow } from "../chat/ChangedFiles.logic";
import { orderedItems } from "~/session-logic";
import { useThread } from "@/stream/stores";

import type { DiffFileEntry, PatchState } from "./diffTypes";

type FileChangeItem = Extract<TurnItem, { type: "file_change" }>;

export interface RunScopeFile {
  entry: DiffFileEntry;
  /** The agent's edits as one patch (consecutive hunks), or null when the journal kept no diff for any of them. */
  patch: string | null;
  /** The journal cut a diff, or an edit failed, or an edit has counts but no diff. */
  state: PatchState;
}

export interface RunScope {
  /** False when the run has no changed files in the loaded items. */
  found: boolean;
  files: RunScopeFile[];
  /** A shell command ran in the run, which can change files the journal never sees. */
  shellRan: boolean;
}

const EMPTY: RunScope = { found: false, files: [], shellRan: false };

/** A real hunk header, with line numbers (`parsePatch` reads only these). */
const NUMBERED_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * An edit's diff as hunks only: its `---`/`+++` markers dropped. The journal's own hunk header is `@@ @@`
 * (the edit tool sends fragments, so it has no line numbers); each such hunk gets a header with the counts
 * `parsePatch` needs and numbers that count from the edit's first line, and says so (`label`), since they
 * are not the file's line numbers. A numbered header (a new file's `@@ -0,0 +1,N @@`) is kept as it is.
 */
export function editHunks(diff: string, label = ""): string[] {
  if (diff.trim() === "") return [];
  const rows = diff.replace(/\r?\n$/, "").split("\n");
  const body = rows.filter((r, i) => !((r.startsWith("--- ") && (rows[i + 1] ?? "").startsWith("+++ ")) || (r.startsWith("+++ ") && (rows[i - 1] ?? "").startsWith("--- "))));
  if (body.length === 0) return [];
  const groups: string[][] = [];
  for (const row of body) {
    if (row.startsWith("@@") || groups.length === 0) groups.push([row]);
    else groups[groups.length - 1]!.push(row);
  }
  return groups.flatMap((g) => {
    const [first, ...lines] = g as [string, ...string[]];
    if (NUMBERED_HUNK.test(first)) return g;
    const rest = first.startsWith("@@") ? lines : g; // a diff with no header at all: every row is body
    const del = rest.filter((r) => r.startsWith("-")).length;
    const add = rest.filter((r) => r.startsWith("+")).length;
    const ctx = rest.length - del - add;
    return [`@@ -${del + ctx > 0 ? 1 : 0},${del + ctx} +${add + ctx > 0 ? 1 : 0},${add + ctx} @@${label ? ` ${label}` : ""}`, ...rest];
  });
}

/** All of a file's edits as one patch the seam can draw: one header, then each edit's hunks in order. Null when there are no diffs. */
export function combineEdits(path: string, diffs: ReadonlyArray<string>): string | null {
  const hunks = diffs.flatMap((d, i) => editHunks(d, diffs.length > 1 ? `edit ${i + 1} of ${diffs.length}` : "edit"));
  if (hunks.length === 0) return null;
  const created = diffs[0]?.startsWith("--- /dev/null") === true;
  return [created ? "--- /dev/null" : `--- a/${path}`, `+++ b/${path}`, ...hunks, ""].join("\n");
}

/** A run's files from the thread's items, in the order the agent first touched them. */
export function runScopeFromItems(items: Record<string, TurnItem> | undefined, runId: string): RunScope {
  if (!items) return EMPTY;
  const runItems = Object.values(items).filter((item) => item.runId === runId);
  const summary = deriveRunChangedFilesFromItems(runItems).get(runId);
  if (!summary) return EMPTY;
  const edits = orderedItems(runItems).filter((item): item is FileChangeItem => item.type === "file_change" && item.status === "completed");
  const byPath = new Map<string, FileChangeItem[]>();
  for (const item of edits) {
    const path = normalizeChangedPath(item.fileName);
    const list = byPath.get(path);
    if (list) list.push(item);
    else byPath.set(path, [item]);
  }
  const files = summary.rows.map((row): RunScopeFile => {
    const own = byPath.get(row.path) ?? [];
    const diffs = own.flatMap((item) => (item.diffStr?.trim() ? [item.diffStr] : []));
    const patch = combineEdits(row.path, diffs);
    return { entry: entryOfRow(row), patch, state: stateOfRow(row, own.length, diffs.length, patch) };
  });
  return { found: true, files, shellRan: summary.shellRan };
}

function entryOfRow(row: ChangedFileRow): DiffFileEntry {
  return {
    path: row.path,
    kind: row.created ? "added" : "modified",
    added: row.additions,
    removed: row.deletions,
    countsKnown: row.countsKnown,
    rev: [row.edits, row.failed, row.running ? "r" : "", row.truncated ? "t" : "", row.additions, row.deletions, row.itemIds.length].join(","),
    ...(row.edits > 0 ? { edits: row.edits } : {}),
  };
}

function stateOfRow(row: ChangedFileRow, completedEdits: number, withDiff: number, patch: string | null): PatchState {
  if (row.edits === 0 && row.failed > 0 && !row.running) {
    return { state: "error", message: row.errorText?.trim() ? `The edit failed: ${row.errorText.trim()}` : "The edit failed, so nothing changed in this file.", retryable: false };
  }
  if (row.running && patch === null) return { state: "loading" };
  if (patch === null) {
    return { state: "truncated", patch: null, message: completedEdits > 0 ? "The journal kept no diff for this edit, only that the file changed." : "No diff is loaded for this file." };
  }
  if (row.truncated || withDiff < completedEdits) {
    return {
      state: "truncated",
      patch,
      message: row.truncated ? "The journal cut a long diff. The +/- counts were taken before the cut." : "Some of this file's edits have no diff in the journal, so they are not shown.",
    };
  }
  return { state: "ready", patch };
}

/** The open thread's files for one run. Memoised on the thread's items. */
export function useRunScopeFiles(threadId: string, runId: string): RunScope {
  const state = useThread(threadId);
  const items = state?.items;
  return useMemo(() => runScopeFromItems(items, runId), [items, runId]);
}

export interface RunOption {
  runId: string;
  ordinal: number;
  files: number;
  additions: number;
  deletions: number;
  /** When the run finished (or started, while it runs), epoch ms. */
  at: number;
}

/** The thread's runs that changed files, newest first: what the scope picker offers. */
export function runOptionsFromState(
  runs: Record<string, { id: string; ordinal: number; startedAt: number; completedAt?: number }> | undefined,
  items: Record<string, TurnItem> | undefined,
): RunOption[] {
  if (!runs || !items) return [];
  const summaries = deriveRunChangedFilesFromItems(Object.values(items));
  const out: RunOption[] = [];
  for (const run of Object.values(runs)) {
    const s = summaries.get(run.id);
    if (!s || s.files === 0) continue;
    out.push({ runId: run.id, ordinal: run.ordinal, files: s.files, additions: s.additions, deletions: s.deletions, at: run.completedAt ?? run.startedAt });
  }
  return out.sort((a, b) => b.ordinal - a.ordinal);
}

export function useRunOptions(threadId: string): RunOption[] {
  const state = useThread(threadId);
  const runs = state?.runs;
  const items = state?.items;
  return useMemo(() => runOptionsFromState(runs, items), [runs, items]);
}
