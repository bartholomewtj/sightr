// Same job and name as T3 Code apps/web/src/components/chat/useThreadFind.ts @ e3b35d1b (pattern; MIT,
// see THIRD_PARTY.md). T3's hook pages a server search; Sightr's (T19) searches the open thread's items
// in memory, so it only knows the loaded pages ("Loaded messages only" while older history exists).
// The open bar, its query and the focused match are one small store, so `chat.find` (mod+f), the
// header's search button, the bar and the timeline all read the same state.
import { useMemo } from "react";
import { create } from "zustand";

import { orderedItems } from "~/session-logic";
import { useThread } from "@/stream/stores";

import { searchThreadItems, stepThreadFindIndex, type ThreadFindMatch } from "./threadFind";

interface ThreadFindState {
  /** The thread whose bar is open, or null. */
  threadId: string | null;
  query: string;
  activeIndex: number;
  /** Bumps on every open, so a second mod+f re-focuses the input. */
  focusRequestId: number;
  /** Bumps on every query change or step, so the timeline reveals the hit once per navigation. */
  navigationId: number;
}

const CLOSED = { threadId: null, query: "", activeIndex: 0, navigationId: 0 };

export const useThreadFindStore = create<ThreadFindState>(() => ({ ...CLOSED, focusRequestId: 0 }));

export function openThreadFind(threadId: string): void {
  useThreadFindStore.setState((s) =>
    s.threadId === threadId
      ? { focusRequestId: s.focusRequestId + 1 }
      : { ...CLOSED, threadId, focusRequestId: s.focusRequestId + 1 },
  );
}

/** Escape or ×: the bar goes and the highlights with it. */
export function closeThreadFind(): void {
  useThreadFindStore.setState({ ...CLOSED });
}

export function setThreadFindQuery(query: string): void {
  useThreadFindStore.setState((s) => ({ query, activeIndex: 0, navigationId: s.navigationId + 1 }));
}

/** Next (+1) or previous (-1), wrapping at both ends. */
export function stepThreadFind(delta: number, total: number): void {
  if (total <= 0) return;
  useThreadFindStore.setState((s) => ({
    activeIndex: stepThreadFindIndex(s.activeIndex, total, delta),
    navigationId: s.navigationId + 1,
  }));
}

export interface ThreadFindView {
  isOpen: boolean;
  query: string;
  matches: readonly ThreadFindMatch[];
  activeIndex: number;
  match: ThreadFindMatch | null;
  navigationId: number;
  focusRequestId: number;
  /** Older history pages exist, so the search does not cover the whole thread. */
  partial: boolean;
}

export function useThreadFind(threadId: string): ThreadFindView {
  const state = useThread(threadId);
  const open = useThreadFindStore((s) => s.threadId === threadId);
  const query = useThreadFindStore((s) => (s.threadId === threadId ? s.query : ""));
  const index = useThreadFindStore((s) => s.activeIndex);
  const navigationId = useThreadFindStore((s) => s.navigationId);
  const focusRequestId = useThreadFindStore((s) => s.focusRequestId);
  const items = state?.items;
  const matches = useMemo(
    () => (open && query.trim() && items ? searchThreadItems(orderedItems(items), query) : []),
    [open, query, items],
  );
  const activeIndex = matches.length === 0 ? 0 : Math.min(index, matches.length - 1);
  return {
    isOpen: open,
    query,
    matches,
    activeIndex,
    match: matches[activeIndex] ?? null,
    navigationId,
    focusRequestId,
    partial: (state?.historyCursor ?? null) !== null,
  };
}

/** Test helper. */
export function __resetThreadFind(): void {
  useThreadFindStore.setState({ ...CLOSED, focusRequestId: 0 });
}
