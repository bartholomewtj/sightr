// Adapted from T3 Code apps/web/src/components/chat/threadFind.ts @ db5919d87 (MIT, see THIRD_PARTY.md).
// Kept: `ThreadFindMatch`, `stepThreadFindIndex`, `formatThreadFindCount`. Changed: T3 asks the server
// to search the thread; Sightr searches the thread store's items in memory (T19) with v1's matcher
// (`@v1/lib/find`), so a hit can sit in a folded run or a collapsed tool group. `findRevealPlan` says
// which fold and group to open so the hit gets a row.
import type { TurnItem } from "@shared/v2/contracts";
import { findMatches } from "@v1/lib/find";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface ThreadFindMatch {
  readonly entryId: string;
  readonly runId: string | null;
  readonly occurrence: number;
}

function clampThreadFindIndex(index: number, total: number): number {
  if (total <= 0 || !Number.isFinite(index) || index < 0) return 0;
  return Math.min(Math.trunc(index), total - 1);
}

export function stepThreadFindIndex(index: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  const clamped = clampThreadFindIndex(index, total);
  return (((clamped + delta) % total) + total) % total;
}

export function formatThreadFindCount(index: number, total: number): string {
  return total <= 0 ? "0/0" : `${clampThreadFindIndex(index, total) + 1}/${total}`;
}

// ── Sightr: in-memory search ────────────────────────────────────────────────────────────────────

function plain(value: unknown): string {
  if (typeof value === "string") return value;
  return "";
}

/** The text a find searches for one turn item: what its row shows or opens to. */
export function turnItemFindText(item: TurnItem): string {
  const parts: string[] = [];
  if (item.title) parts.push(item.title);
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
    case "screen":
      parts.push(item.text);
      break;
    case "command_execution":
      parts.push(item.input, item.output ?? "");
      break;
    case "file_change":
      parts.push(item.fileName, item.errorText ?? "");
      break;
    case "proposed_plan":
      parts.push(item.markdown);
      break;
    case "todo_list":
      parts.push(...item.steps.map((s) => s.text));
      break;
    case "subagent":
      parts.push(item.result ?? "", item.model ?? "");
      break;
    case "run_interrupt_result":
      parts.push(item.message);
      break;
    case "compaction":
      break;
    case "file_search":
      parts.push(item.pattern ?? "");
      break;
    case "web_search":
      parts.push(...(item.patterns ?? []));
      break;
    case "dynamic_tool":
      parts.push(item.toolName ?? "", plain(item.input), plain(item.output));
      break;
    case "approval_request":
      parts.push(item.prompt ?? "", ...(item.options ?? []).map((o) => o.label));
      break;
    case "user_input_request":
      for (const q of item.questions) parts.push(q.question, ...q.options.map((o) => o.label));
      break;
    case "system_notice":
      parts.push(item.message);
      break;
    case "error":
      parts.push(item.failure.message);
      break;
    case "session":
      break;
  }
  return parts.filter((p) => p !== "").join("\n");
}

/** Every occurrence of `query` in the items, in timeline order (case-insensitive, v1's matcher). */
export function searchThreadItems(items: readonly TurnItem[], query: string): ThreadFindMatch[] {
  const needle = query.trim();
  if (!needle) return [];
  const out: ThreadFindMatch[] = [];
  for (const item of items) {
    const hits = findMatches(turnItemFindText(item), needle);
    for (let occurrence = 0; occurrence < hits.length; occurrence += 1) {
      out.push({ entryId: item.id, runId: item.runId, occurrence });
    }
  }
  return out;
}

/** The index of the row that shows `entryId`, or -1 (folded, in a collapsed group, or not rendered). */
export function findRowIndex(rows: readonly MessagesTimelineRow[], entryId: string): number {
  return rows.findIndex((row) => {
    if (row.id === entryId) return true;
    if (row.kind === "work") return row.groupedEntries.some((entry) => entry.id === entryId);
    // A live group shows only its newest entry; the rest are on its details row once opened.
    if (row.kind === "work-live") return row.entry.id === entryId;
    return false;
  });
}

/** A set that holds everything: rows derived with it have every fold and group open. */
export class EverythingSet extends Set<string> {
  override has(): boolean {
    return true;
  }
}

/**
 * What to open so `entryId` gets a row: its run's fold (when that run has one) and the tool group it
 * sits in. `allOpen` are the rows derived with every fold and group open.
 */
export function findRevealPlan(
  allOpen: readonly MessagesTimelineRow[],
  entryId: string,
  runId: string | null,
): { runIds: string[]; groupIds: string[] } {
  const runIds = runId !== null && allOpen.some((row) => row.kind === "turn-fold" && row.runId === runId) ? [runId] : [];
  const groupIds: string[] = [];
  for (const row of allOpen) {
    if (row.kind === "work" && row.id.endsWith(":details") && row.groupedEntries.some((entry) => entry.id === entryId)) {
      groupIds.push(row.id.slice(0, -":details".length));
      break;
    }
  }
  return { runIds, groupIds };
}
