// Same job and name as T3 Code apps/web/src/components/chat/useThreadFindNavigation.ts @ e3b35d1b
// (pattern; MIT, see THIRD_PARTY.md): bring the focused match into view through the windowed list,
// then hand the row to the highlighter. Sightr's (T19): a hit inside a folded run or a collapsed tool
// group opens that fold and group first (`findRevealPlan`), then `scrollToIndex` mounts its row. It
// never pages history; the bar says "Loaded messages only" instead.
import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, type RefObject } from "react";

import { useTimelineStore, EMPTY_TIMELINE_UI } from "@/state/timeline";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { findRevealPlan, findRowIndex, type ThreadFindMatch } from "./threadFind";
import { useThreadFindHighlights } from "./threadFindHighlights";

/** Open folds and groups (never closes one the operator opened). */
export function openForFind(threadId: string, runIds: readonly string[], groupIds: readonly string[]): void {
  if (runIds.length === 0 && groupIds.length === 0) return;
  useTimelineStore.setState((s) => {
    const ui = s.byThread[threadId] ?? EMPTY_TIMELINE_UI;
    const expandedRunIds = new Set(ui.expandedRunIds);
    const expandedWorkGroupIds = new Set(ui.expandedWorkGroupIds);
    runIds.forEach((id) => expandedRunIds.add(id));
    groupIds.forEach((id) => expandedWorkGroupIds.add(id));
    return { byThread: { ...s.byThread, [threadId]: { ...ui, expandedRunIds, expandedWorkGroupIds } } };
  });
}

export function useThreadFindNavigation({
  threadId,
  container,
  query,
  match,
  navigationId,
  rows,
  deriveAllOpenRows,
  listRef,
}: {
  threadId: string;
  container: HTMLElement | null;
  query: string;
  match: ThreadFindMatch | null;
  navigationId: number;
  rows: readonly MessagesTimelineRow[];
  /** The rows with every fold and group open (only called when a hit has no row). */
  deriveAllOpenRows: () => readonly MessagesTimelineRow[];
  listRef: RefObject<LegendListRef | null>;
}): void {
  const matchKey = match ? `${navigationId}:${match.entryId}:${match.occurrence}` : null;
  const opened = useRef<string | null>(null);
  const scrolled = useRef<string | null>(null);
  const rowIndex = match ? findRowIndex(rows, match.entryId) : -1;

  useEffect(() => {
    if (!match || matchKey === null) return;
    if (rowIndex < 0) {
      if (opened.current === matchKey) return;
      opened.current = matchKey;
      const plan = findRevealPlan(deriveAllOpenRows(), match.entryId, match.runId);
      openForFind(threadId, plan.runIds, plan.groupIds);
      return;
    }
    if (scrolled.current === matchKey) return;
    scrolled.current = matchKey;
    void listRef.current?.scrollToIndex({ index: rowIndex, animated: false, viewPosition: 0.3 });
    // `rows` and the callbacks change on every stream event; the navigation key decides.
  }, [matchKey, rowIndex, threadId]);

  useThreadFindHighlights({
    container,
    query,
    activeRowId: rowIndex >= 0 ? (rows[rowIndex]?.id ?? null) : null,
    activeOccurrence: match?.occurrence ?? 0,
    revealKey: rowIndex >= 0 ? matchKey : null,
  });
}
