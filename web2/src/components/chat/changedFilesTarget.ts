/**
 * Where a tap on a changed file goes (T24, repointed by T27). `openChangedFile` is the one seam: since T27 it
 * opens the Diff tab on that run (`openDiffForRun`: the run's scope, the file unfolded and scrolled to; the
 * desktop panel, or the sheet on a phone). The card and its tree did not change.
 *
 * `openChangedFileSheet` is T24's earlier target, the sheet of that path's edits (`ChangedFileSheet`). The
 * Diff tab's run scope shows the same edits as consecutive hunks, so nothing calls it from the card any more;
 * it is kept, with its sheet, until a later slice decides whether to drop it.
 *
 * Open state is module-level, as the thread details sheet's is (`openThreadDetails`): one sheet at a
 * time, shown while that thread's timeline is mounted.
 */
import { useSyncExternalStore } from "react";

import { useDiffPanelStore } from "@/diffPanelStore";

export interface ChangedFileTarget {
  readonly threadId: string;
  readonly runId: string;
  /** The row's normalised path (`ChangedFileRow.path`). */
  readonly path: string;
}

let current: ChangedFileTarget | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** A tap on a changed file: the Diff tab, on that run, at that file. */
export function openChangedFile(target: ChangedFileTarget): void {
  useDiffPanelStore.getState().openDiffForRun(target.threadId, target.runId, target.path);
}

/** Open the sheet for one changed file of one run (T24's target; see the note above). */
export function openChangedFileSheet(target: ChangedFileTarget): void {
  current = target;
  emit();
}

export function closeChangedFile(): void {
  if (current === null) return;
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The open target when it belongs to `threadId`, else null. */
export function useChangedFileTarget(threadId: string): ChangedFileTarget | null {
  return useSyncExternalStore(
    subscribe,
    () => (current !== null && current.threadId === threadId ? current : null),
    () => null,
  );
}
