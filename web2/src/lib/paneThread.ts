import type { Thread } from "@shared/v2/contracts";

/**
 * The thread a push notification's `paneId` means. A pane id is bound to one live thread at a time;
 * archived threads can share it (an earlier terminal in the same pane), so a live one wins, then the
 * most recently archived.
 */
export function findThreadByPane(threads: Record<string, Thread>, paneId: string): string | null {
  let best: Thread | null = null;
  for (const thread of Object.values(threads)) {
    if (thread.paneId !== paneId) continue;
    if (!best) {
      best = thread;
      continue;
    }
    const live = thread.shelf !== "archived";
    const bestLive = best.shelf !== "archived";
    if (live && !bestLive) best = thread;
    else if (live === bestLive && (thread.archivedAt ?? thread.updatedAt) > (best.archivedAt ?? best.updatedAt)) best = thread;
  }
  return best?.id ?? null;
}
