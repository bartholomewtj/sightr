import { useCallback } from "react";

import { showToast } from "@/components/toast";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { closeThreadPane } from "@/lib/archived";

/** The operator's words for a refused `thread.pane.close`. */
export function closePaneRefusalText(reason: string): string {
  return `Could not close the pane: ${reason}`;
}

/**
 * Two-tap "Close pane" for one thread at a time: the first tap arms `armed(threadId)`, the second sends
 * `thread.pane.close` and toasts the outcome. The thread leaves the shelf (archived as `pane-closed`)
 * through the stream, not from here.
 */
export function useClosePane() {
  const { pending, confirm } = usePendingConfirm();
  const key = (threadId: string) => `close-pane:${threadId}`;
  const armed = useCallback((threadId: string) => pending === key(threadId), [pending]);
  /** Returns true once the command was sent (second tap). */
  const request = useCallback(
    (threadId: string): boolean => {
      if (!confirm(key(threadId))) return false;
      void closeThreadPane(threadId).then((out) => {
        if (out.kind === "refused") showToast(closePaneRefusalText(out.reason), "error");
        else showToast("Pane closed.");
      });
      return true;
    },
    [confirm],
  );
  return { armed, request };
}
