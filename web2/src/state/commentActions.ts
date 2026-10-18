// Sightr code (T29). What the buttons around the pending line comments do: Add to message, Delete with Undo, Discard.
// The only way a comment reaches the pane is the composer's own send (`message.dispatch`); nothing here types into
// one. "Add" asks the composer to append blocks to its text (`requestInsert`), never edits the draft itself.
import { showThreadUndoNotice } from "@/hooks/showThreadUndoNotice";
import { useSidebarThread } from "@/state/sidebar";
import { useBridgeInfo, useThread } from "@/stream/stores";
import { formatReviewBlock } from "@/lib/reviewCommentContext";
import { useRightPanelStore } from "@/rightPanelStore";
import { setCommentsListOpen } from "@/state/commentsUi";
import { requestInsert } from "@/state/composer";
import {
  clearLineComments,
  commentView,
  removeLineComment,
  restoreLineComment,
  type LineComment,
} from "@/state/lineComments";

/** The block a comment adds to a draft (`, outdated` in its header when its lines changed). */
export const blockOf = (c: LineComment): string => formatReviewBlock({ ...c, outdated: c.state === "outdated" });

export type AddGate = { ok: true } | { ok: false; reason: string };

/** Whether comments can be added to this thread's message, and if not, why (shown beside the disabled button). */
export function useAddGate(threadId: string): AddGate {
  const state = useThread(threadId);
  const shell = useSidebarThread(threadId);
  const thread = state?.thread ?? shell ?? null;
  const readOnly = useBridgeInfo((s) => s.readOnly);
  if (readOnly) return { ok: false, reason: "This device is read-only." };
  if (!thread) return { ok: false, reason: "Loading the thread." };
  if (thread.shelf === "archived") return { ok: false, reason: "This thread is archived." };
  // A pane that takes a pasted multi-line message: a plain shell has none, and each line would run as a command.
  if (thread.capabilities?.canQueueDrain !== true) return { ok: false, reason: "This pane is a shell. Its lines would each run." };
  return { ok: true };
}

/**
 * Ask the composer to append these comments' blocks to its text. A phone closes the Diff sheet and does not focus the
 * box (no surprise keyboard); a desktop keeps the panel open and focuses the box. Outdated comments are left out
 * unless `includeOutdated` (the caller has had its confirm tap).
 */
export function addToMessage(threadId: string, comments: readonly LineComment[], draft: string, opts: { phone: boolean; includeOutdated?: boolean }): number {
  const chosen = comments.filter((c) => commentView(c, draft) !== "in message" && (opts.includeOutdated || c.state !== "outdated"));
  if (chosen.length === 0) return 0;
  requestInsert(threadId, chosen.map(blockOf), { focus: !opts.phone });
  if (opts.phone) {
    // The sheet closes; the Diff tab opens on its files next time, not on a list that is no longer needed.
    setCommentsListOpen(threadId, false);
    useRightPanelStore.getState().closeSheet();
  }
  return chosen.length;
}

/** Delete one comment, with five seconds to take it back. */
export function deleteWithUndo(threadId: string, id: string): void {
  const removed = removeLineComment(threadId, id);
  if (!removed) return;
  showThreadUndoNotice({
    action: "Comment removed",
    threadId,
    undo: async () => restoreLineComment(threadId, removed.comment, removed.index),
  });
}

export function discardAll(threadId: string): void {
  clearLineComments(threadId);
}
