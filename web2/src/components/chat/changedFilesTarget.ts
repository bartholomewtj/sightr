/**
 * Where a tap on a changed file goes (T24, repointed by T27). `openChangedFile` is the one seam: since T27 it
 * opens the Diff tab on that run (`openDiffForRun`: the run's scope, the file unfolded and scrolled to; the
 * desktop panel, or the sheet on a phone). The card and its tree did not change.
 *
 * T24's earlier target, a sheet of that path's edits (`ChangedFileSheet`), is gone: the Diff tab's run scope
 * shows the same edits as consecutive hunks.
 */
import { useDiffPanelStore } from "@/diffPanelStore";

export interface ChangedFileTarget {
  readonly threadId: string;
  readonly runId: string;
  /** The row's normalised path (`ChangedFileRow.path`). */
  readonly path: string;
}

/** A tap on a changed file: the Diff tab, on that run, at that file. */
export function openChangedFile(target: ChangedFileTarget): void {
  useDiffPanelStore.getState().openDiffForRun(target.threadId, target.runId, target.path);
}
