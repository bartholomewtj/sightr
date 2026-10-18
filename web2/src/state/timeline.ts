/**
 * The timeline's UI state (T11), beside the thread store it renders from:
 * - which turn folds and tool groups the operator opened, per thread (T3 keeps the same sets in its
 *   UI state store: `expandedRunIds`, `expandedWorkGroupIds`). The app never closes one the operator
 *   opened; a group that is live shows as the live row whatever the set says.
 * - older history: one page request in flight per thread, its error, and the "start of thread" end.
 * - `followRequest`: bumped by this client's own send (T12 calls `followTimeline()`), which always
 *   brings the reader back to the bottom.
 */
import { create } from "zustand";

import { fetchThreadHistory } from "@/stream/history";
import { mergeHistoryPage } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";

export interface ThreadTimelineUi {
  expandedRunIds: ReadonlySet<string>;
  expandedWorkGroupIds: ReadonlySet<string>;
  /**
   * T24: the directories the operator folded in a run's changed-files tree, by run id. Empty by
   * default, so the tree opens fully; in memory like the sets above, so a card the list unmounts comes
   * back as it was left.
   */
  collapsedChangedDirs: Readonly<Record<string, ReadonlySet<string>>>;
}

export type HistoryStatus = "idle" | "loading" | "error";

interface TimelineStore {
  byThread: Record<string, ThreadTimelineUi>;
  history: Record<string, { status: HistoryStatus; error: string | null }>;
  followRequest: number;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_DIRS: Readonly<Record<string, ReadonlySet<string>>> = {};
export const EMPTY_TIMELINE_UI: ThreadTimelineUi = {
  expandedRunIds: EMPTY_SET,
  expandedWorkGroupIds: EMPTY_SET,
  collapsedChangedDirs: EMPTY_DIRS,
};

export const useTimelineStore = create<TimelineStore>(() => ({ byThread: {}, history: {}, followRequest: 0 }));

export function useThreadTimelineUi(threadId: string): ThreadTimelineUi {
  return useTimelineStore((s) => s.byThread[threadId] ?? EMPTY_TIMELINE_UI);
}

function toggleIn(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function toggleTurnFold(threadId: string, runId: string): void {
  useTimelineStore.setState((s) => {
    const ui = s.byThread[threadId] ?? EMPTY_TIMELINE_UI;
    return { byThread: { ...s.byThread, [threadId]: { ...ui, expandedRunIds: toggleIn(ui.expandedRunIds, runId) } } };
  });
}

export function toggleWorkGroup(threadId: string, groupId: string): void {
  useTimelineStore.setState((s) => {
    const ui = s.byThread[threadId] ?? EMPTY_TIMELINE_UI;
    return {
      byThread: { ...s.byThread, [threadId]: { ...ui, expandedWorkGroupIds: toggleIn(ui.expandedWorkGroupIds, groupId) } },
    };
  });
}

/** The folded directories of a run's changed-files tree (empty set: all open). */
export function collapsedChangedDirsOf(ui: ThreadTimelineUi, runId: string): ReadonlySet<string> {
  return ui.collapsedChangedDirs[runId] ?? EMPTY_SET;
}

/** Fold or open one directory of a run's changed-files tree. */
export function toggleChangedDir(threadId: string, runId: string, dir: string): void {
  useTimelineStore.setState((s) => {
    const ui = s.byThread[threadId] ?? EMPTY_TIMELINE_UI;
    const next = toggleIn(collapsedChangedDirsOf(ui, runId), dir);
    return { byThread: { ...s.byThread, [threadId]: { ...ui, collapsedChangedDirs: { ...ui.collapsedChangedDirs, [runId]: next } } } };
  });
}

/** "Collapse all" passes every directory path; "Expand all" passes none. */
export function setChangedDirsCollapsed(threadId: string, runId: string, dirs: Iterable<string>): void {
  useTimelineStore.setState((s) => {
    const ui = s.byThread[threadId] ?? EMPTY_TIMELINE_UI;
    return {
      byThread: { ...s.byThread, [threadId]: { ...ui, collapsedChangedDirs: { ...ui.collapsedChangedDirs, [runId]: new Set(dirs) } } },
    };
  });
}

/** This client sent a message: the timeline follows to the bottom whatever the reader was doing. */
export function followTimeline(): void {
  useTimelineStore.setState((s) => ({ followRequest: s.followRequest + 1 }));
}

export function useHistoryState(threadId: string): { status: HistoryStatus; error: string | null } {
  return useTimelineStore((s) => s.history[threadId] ?? IDLE_HISTORY);
}
const IDLE_HISTORY = { status: "idle" as HistoryStatus, error: null };

function setHistory(threadId: string, status: HistoryStatus, error: string | null): void {
  useTimelineStore.setState((s) => ({ history: { ...s.history, [threadId]: { status, error } } }));
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Fetch the page before the open thread's `historyCursor` and prepend it. One request per thread at a
 * time (a second call returns the first's promise); nothing to do when the cursor is null (start of
 * thread). A failure leaves the cursor as it was and shows a retry row; it is not retried by itself.
 */
export function loadOlderHistory(threadId: string): Promise<void> {
  const running = inFlight.get(threadId);
  if (running) return running;
  const state = useThreadStore.getState().current;
  if (!state || state.threadId !== threadId || state.historyCursor === null) return Promise.resolve();
  const cursor = state.historyCursor;
  setHistory(threadId, "loading", null);
  const job = fetchThreadHistory(threadId, cursor)
    .then((page) => {
      const current = useThreadStore.getState().current;
      // The stream replaced or closed the thread meanwhile: drop the page, the cursor is stale.
      if (!current || current.threadId !== threadId || current.historyCursor !== cursor) {
        setHistory(threadId, "idle", null);
        return;
      }
      useThreadStore.setState({ current: mergeHistoryPage(current, page) });
      setHistory(threadId, "idle", null);
    })
    .catch(() => {
      setHistory(threadId, "error", "Couldn't load earlier messages.");
    })
    .finally(() => {
      inFlight.delete(threadId);
    });
  inFlight.set(threadId, job);
  return job;
}

/** Test helper. */
export function __resetTimelineState(): void {
  inFlight.clear();
  useTimelineStore.setState({ byThread: {}, history: {}, followRequest: 0 }, true);
}
