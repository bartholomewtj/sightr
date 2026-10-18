/**
 * Where a tap on a changed file goes (T24). `openChangedFile` is the one seam: today it opens
 * `ChangedFileSheet`, the sheet of that path's edits. T27 repoints this single function at the diff
 * panel's run scope on a desktop; the card and its tree do not change.
 *
 * Open state is module-level, as the thread details sheet's is (`openThreadDetails`): one sheet at a
 * time, shown while that thread's timeline is mounted.
 */
import { useSyncExternalStore } from "react";

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

/** Open the sheet for one changed file of one run. */
export function openChangedFile(target: ChangedFileTarget): void {
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
