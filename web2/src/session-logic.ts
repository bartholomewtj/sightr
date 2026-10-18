// Adapted from T3 Code apps/web/src/session-logic.ts @ db5919d87 (MIT, see THIRD_PARTY.md).
// Turn items → timeline entries, as upstream's `deriveTimelineEntriesFromVisibleTurnItems` and
// `projectedWorkEntry`, on Sightr's item shapes (shared/v2/contracts.ts). Changes from upstream:
// - Times are epoch ms (Sightr), not ISO strings; there are no attempts, plan artifacts, MCP apps or
//   HTML renders. `proposed_plan` is an `event` entry (T3: its own `proposed-plan` kind), and so are
//   `subagent`, `run_interrupt_result` and `compaction` (drawn by V2LifecycleRow).
// - `todo_list` is a work row that opens to the checklist (T3 skips it here and shows it in the
//   composer's tasks badge); a `web_search` of a URL reads "Fetched <url>". A run the journal marked
//   interrupted gets no synthetic "Stopped" notice.
// - An entry's id is the turn item's id, also for messages: a journal entry with two text parts gives
//   two items that share a `messageId`.
// - An MCP tool (`mcp__server__tool`) is labelled "<tool> · <server>" (`dynamicToolDisplayName`).
// - Sightr items: `session` and `screen` become `event` entries; a run that ended `interrupted` or
//   `failed` gets a synthetic notice entry after its last item (there is no run_interrupt item here).
// - A run's `checkpoint` item (T30) draws no row; the changed-files card reads it (T31).
// - Reasoning gets a duration (Sightr, `reasoningTime`), because journals record thinking as one
//   finished block with the entry's timestamp.
import type { ChatAttachment, Run, TurnItem } from "@shared/v2/contracts";

import {
  workEntryIndicatesToolFailure,
  type WorkLogPresentationEntry,
  type WorkLogToolLifecycleStatus,
} from "@t3tools/client-runtime/work-log/presentation";
import {
  classifyToolActivity,
  collectToolFilePaths,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";

export { formatDuration } from "@t3tools/shared/orchestrationTiming";
export {
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolFailure,
} from "@t3tools/client-runtime/work-log/presentation";
export type { WorkLogToolLifecycleStatus };

/** How long a reasoning item took: ms, `"live"` (still thinking, since `createdAt`), or null (unknown). */
export type ReasoningTime = number | "live" | null;

export interface WorkLogEntry extends WorkLogPresentationEntry {
  readonly runId?: string | null;
  readonly sourceActivityKind?: string;
  readonly projectedItem?: TurnItem;
  /** Sightr: reasoning duration (see `reasoningTime`). */
  readonly reasoningTime?: ReasoningTime;
  /** Sightr: the item's own `truncated` flag. */
  readonly truncated?: boolean;
}

/** T3's `ChatMessage` (apps/web/src/types.ts), cut to what a herdr journal carries. */
export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly runId?: string | null;
  readonly streaming: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly inputIntent?: string;
}

export type TimelineEntry =
  | {
      readonly id: string;
      readonly kind: "message";
      readonly createdAt: number;
      readonly message: ChatMessage;
      readonly projectedItem?: TurnItem;
    }
  | {
      readonly id: string;
      readonly kind: "work";
      readonly createdAt: number;
      readonly entry: WorkLogEntry;
    }
  | {
      readonly id: string;
      readonly kind: "event";
      readonly createdAt: number;
      readonly projectedItem: TurnItem;
    };

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean {
  return (
    entry.tone === "tool" ||
    entry.tone === "thinking" ||
    entry.tone === "error" ||
    entry.command !== undefined ||
    entry.requestKind !== undefined
  );
}

export function workEntrySignalsSevereFailure(entry: WorkLogEntry): boolean {
  return entry.itemType === "error";
}

export function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean {
  if (
    !workLogEntryIsToolLike(entry) ||
    workEntryIndicatesToolFailure(entry) ||
    (entry.tone === "thinking" && entry.itemType !== "reasoning")
  ) {
    return false;
  }
  const status = entry.toolLifecycleStatus;
  return (
    status !== "failed" &&
    status !== "declined" &&
    status !== "inProgress" &&
    status !== "stopped" &&
    status !== "idle"
  );
}

export function workEntryIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean {
  return (
    workLogEntryIsToolLike(entry) &&
    !workEntryIndicatesToolFailure(entry) &&
    !workEntryIndicatesToolSuccess(entry)
  );
}

/**
 * Items that render as standalone event rows: Sightr's `session` and `screen`, T3's lifecycle rows
 * (`run_interrupt_result`, `subagent`; `compaction` too here, as a divider), and `proposed_plan`
 * (T3 gives it its own `proposed-plan` entry kind; here it is an event row that draws the card).
 */
const STANDALONE_ITEM_TYPES = new Set<TurnItem["type"]>([
  "session",
  "screen",
  "run_interrupt_result",
  "subagent",
  "compaction",
  "proposed_plan",
]);

/** "Updated tasks · 2/5 done" for a `todo_list` row (Sightr: T3 shows the list only in the composer's tasks badge). */
export function todoListLabel(item: Extract<TurnItem, { type: "todo_list" }>): string {
  const done = item.steps.filter((s) => s.status === "completed").length;
  return item.steps.length === 0 ? "Cleared tasks" : `Updated tasks · ${done}/${item.steps.length} done`;
}

/** A `web_search` whose pattern is a URL was a page fetch (Claude WebFetch): "Fetched example.com/docs". */
export function webSearchLabel(item: Extract<TurnItem, { type: "web_search" }>): string {
  const [first] = item.patterns ?? [];
  if (first && /^https?:\/\//i.test(first)) {
    try {
      const url = new URL(first);
      return `Fetched ${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return `Fetched ${first}`;
    }
  }
  return "Searched the web";
}

/** `mcp__<server>__<tool>` (Claude's MCP tool names) as its parts; null for any other name. */
export function mcpToolParts(toolName: string | null | undefined): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName ?? "");
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

/** A tool's name as a row shows it: an MCP tool as "<tool> · <server>", anything else as named. */
export function dynamicToolDisplayName(toolName: string | null | undefined): string | null {
  const mcp = mcpToolParts(toolName);
  if (mcp) return `${mcp.tool} · ${mcp.server}`;
  return toolName?.trim() || null;
}

function itemCreatedAt(item: TurnItem): number {
  return item.startedAt ?? item.createdAt;
}

function projectedWorkEntryStatus(item: TurnItem): WorkLogToolLifecycleStatus {
  switch (item.status) {
    case "pending":
    case "running":
    case "waiting":
      return "inProgress";
    case "completed":
      return "completed";
    case "idle":
      return "idle";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

function projectedWorkEntryTone(item: TurnItem): WorkLogEntry["tone"] {
  if (item.type === "error") return "info";
  if (item.type === "reasoning") return "thinking";
  switch (item.type) {
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
    case "subagent":
    case "todo_list":
    case "user_input_request":
    case "approval_request":
      return "tool";
    default:
      return "info";
  }
}

export function providerErrorPresentation(item: Extract<TurnItem, { type: "error" }>): {
  readonly label: string;
  readonly detail: string;
} {
  if (item.retry === undefined) {
    return {
      label:
        item.failure.class === "usage_limit"
          ? "Usage limit reached"
          : item.title?.trim() || "Provider error",
      detail: item.failure.message,
    };
  }
  const progress =
    item.retry.maxAttempts === null
      ? `${item.retry.attempt}`
      : `${item.retry.attempt}/${item.retry.maxAttempts}`;
  const label =
    item.status === "running"
      ? `Retrying provider (${progress})`
      : item.status === "completed"
        ? `Provider recovered (${progress} retries)`
        : item.status === "failed"
          ? `${item.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error"} after ${progress} retries`
          : `Provider retry stopped (${progress})`;
  const retryDelay =
    item.status === "running" && item.retry.retryDelayMs !== null && item.retry.retryDelayMs > 0
      ? item.retry.retryDelayMs < 1_000
        ? ` Retrying in ${item.retry.retryDelayMs}ms.`
        : ` Retrying in ${(item.retry.retryDelayMs / 1_000).toFixed(1).replace(/\.0$/u, "")}s.`
      : "";
  return { label, detail: `${item.failure.message}${retryDelay}` };
}


function projectedWorkEntry(item: TurnItem, reasoningTime: ReasoningTime | undefined): WorkLogEntry {
  const title = item.title?.trim() || null;
  const common = {
    id: item.id,
    createdAt: itemCreatedAt(item),
    runId: item.runId,
    tone: projectedWorkEntryTone(item),
    itemType: item.type,
    toolLifecycleStatus: projectedWorkEntryStatus(item),
    structuredPayload: item,
    projectedItem: item,
    ...(item.truncated ? { truncated: true } : {}),
  } as const;

  switch (item.type) {
    case "reasoning":
      return {
        ...common,
        label: "Thinking",
        ...(item.text ? { detail: item.text } : {}),
        ...(reasoningTime !== undefined ? { reasoningTime } : {}),
        // A thought still being written is the live activity (T3 marks it in progress).
        ...(reasoningTime === "live" ? { toolLifecycleStatus: "inProgress" as const } : {}),
      };
    case "command_execution":
      return {
        ...common,
        label: "Ran command",
        command: item.input,
        rawCommand: item.input,
        toolTitle: title ?? "Command",
        toolData: item,
      };
    case "file_change":
      return {
        ...common,
        label: `Changed ${item.fileName}`,
        changedFiles: [item.fileName],
        toolTitle: title ?? "File change",
        toolData: item,
      };
    case "file_search":
      return {
        ...common,
        label: formatSearchToolLabel(item as unknown as Record<string, unknown>) ?? "Searched files",
        ...(item.pattern ? { detail: item.pattern } : {}),
        toolTitle: title ?? "File search",
        toolData: item,
      };
    case "web_search": {
      const label = webSearchLabel(item);
      // Sightr: a fetch's row reads "Fetched <url>" (its title and label); a search keeps T3's form.
      return label.startsWith("Fetched ")
        ? { ...common, label, toolTitle: label, toolData: item }
        : {
            ...common,
            label,
            ...(item.patterns?.length ? { detail: item.patterns.join(", ") } : {}),
            toolTitle: title ?? "Web search",
            toolData: item,
          };
    }
    case "todo_list":
      // Sightr: T3 skips todo lists in the timeline (its composer badge shows them); here each update
      // is a tool row that opens to the checklist.
      return { ...common, label: todoListLabel(item), toolTitle: todoListLabel(item), toolData: item };
    case "system_notice":
      // Sightr: a notice that finished cleanly (a background command completing, "Stopped") is not a warning.
      return item.status === "completed" ? { ...common, label: item.message } : { ...common, label: item.message, sourceActivityKind: "runtime.warning" };
    case "error": {
      const presentation = providerErrorPresentation(item);
      return {
        ...common,
        ...presentation,
        ...(item.failure.class === "usage_limit" && item.status !== "completed"
          ? { sourceActivityKind: "runtime.warning" }
          : item.retry === undefined
            ? { sourceActivityKind: "runtime.error" }
            : {}),
        toolData: item,
      };
    }
    case "dynamic_tool": {
      const classified = classifyToolActivity({
        itemType: "dynamic_tool_call",
        data: { toolName: item.toolName ?? undefined, input: item.input },
      });
      // Sightr: journals record a tool's input as one summary string (the path, for a read).
      const [readPath] =
        typeof item.input === "string" ? [item.input] : collectToolFilePaths({ input: item.input });
      // Sightr: an MCP tool reads "<tool> · <server>", not its raw `mcp__server__tool` name.
      const displayName = dynamicToolDisplayName(item.toolName);
      return {
        ...common,
        label:
          classified === "read"
            ? formatReadToolLabel(readPath ?? "")
            : classified === "search"
              ? (formatSearchToolLabel({ input: item.input }) ??
                (typeof item.input === "string" && item.input ? `Searched ${item.input}` : null) ??
                displayName ??
                "Tool call")
              : (displayName ?? "Tool call"),
        toolTitle: displayName ?? title ?? "Tool",
        toolData: { input: item.input, output: item.output },
        ...(typeof item.input === "string" && item.input && classified !== "read"
          ? { detail: item.input }
          : {}),
      };
    }
    case "approval_request":
      return {
        ...common,
        label: title ?? "Approval requested",
        detail: item.prompt ?? item.requestKind,
        toolData: item,
      };
    case "user_input_request":
      return { ...common, label: title ?? "Input requested", toolData: item };
    default:
      return { ...common, label: title ?? item.type.replaceAll("_", " "), toolData: item };
  }
}

// ── Reasoning duration (Sightr) ─────────────────────────────────────────────────────────────────

/** A gap longer than this is not think time; it is the agent (or the operator) idle between turns. */
export const MAX_THINK_SECONDS = 10 * 60;

/** The journal entry an item came from: T03 ids are `<entry key>:<part index>`. */
function entryKeyOf(id: string): string {
  const cut = id.lastIndexOf(":");
  return cut < 0 ? id : id.slice(0, cut);
}

/**
 * How long the reasoning at `index` took (docs/specs/t3/T11-timeline.md; the rules of v1's
 * `thinkingDuration`, spec 15):
 * - its own `startedAt` and `completedAt` when the item has both;
 * - speech or a tool from the same journal entry means the thinking finished before the entry was
 *   written, so its length is unknown (null);
 * - otherwise the gap to the next item of the same run, unless that item is a user message, the gap
 *   is negative or longer than {@link MAX_THINK_SECONDS} (idle, not thinking): null;
 * - the last item of a running run is still thinking: `"live"`.
 */
export function reasoningTime(
  items: ReadonlyArray<TurnItem>,
  index: number,
  runningRunId: string | null,
): ReasoningTime {
  const item = items[index];
  if (!item || item.type !== "reasoning") return null;
  if (item.startedAt !== null && item.completedAt !== null) {
    return Math.max(0, item.completedAt - item.startedAt);
  }
  const key = entryKeyOf(item.id);
  const prev = items[index - 1];
  const next = items[index + 1];
  if ((prev && entryKeyOf(prev.id) === key) || (next && entryKeyOf(next.id) === key)) return null;
  if (!next || next.runId !== item.runId) {
    return item.runId !== null && item.runId === runningRunId && !next ? "live" : null;
  }
  if (next.type === "user_message") return null;
  const gap = itemCreatedAt(next) - itemCreatedAt(item);
  return gap < 0 || gap > MAX_THINK_SECONDS * 1000 ? null : gap;
}

/** Whole seconds under a minute, then T3's duration format ("Thought for 12s", "Thought for 2m 5s"). */
export function formatThinkDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** "Thought for 12s", "Thought briefly" (under a second) or "Thought" (unknown). Live is the caller's. */
export function reasoningLabel(time: ReasoningTime | undefined): string {
  if (time === "live") return "Thinking…";
  if (time === null || time === undefined) return "Thought";
  return time < 1000 ? "Thought briefly" : `Thought for ${formatThinkDuration(time)}`;
}

// ── Entries ─────────────────────────────────────────────────────────────────────────────────────

export interface TimelineEntriesInput {
  /** The thread's items, in ordinal order. */
  readonly items: ReadonlyArray<TurnItem>;
  readonly runs: ReadonlyArray<Run>;
}

/** Items in timeline order: by `ordinal`, ties (none expected) by id. */
export function orderedItems(items: Record<string, TurnItem> | ReadonlyArray<TurnItem>): TurnItem[] {
  const list = Array.isArray(items) ? [...items] : Object.values(items);
  return list.sort((a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The synthetic notice a run that ended `interrupted` or `failed` leaves behind (Sightr). */
function runEndItem(run: Run, after: number): TurnItem | null {
  if (run.status !== "interrupted" && run.status !== "failed") return null;
  const at = run.completedAt ?? after;
  const base = {
    id: `run-end:${run.id}`,
    threadId: run.threadId,
    runId: run.id,
    ordinal: Number.NaN,
    title: null,
    startedAt: at,
    completedAt: at,
    createdAt: at,
    updatedAt: at,
  };
  return run.status === "interrupted"
    ? { ...base, type: "system_notice", status: "completed", message: "Stopped" }
    : {
        ...base,
        type: "error",
        status: "failed",
        title: "The run failed",
        failure: {
          class: "unknown",
          message: "The agent stopped with an error. Open the Terminal tab to see what it printed.",
          code: null,
          retryable: null,
        },
      };
}

export function deriveTimelineEntries(input: TimelineEntriesInput): TimelineEntry[] {
  // Sightr: a run's `checkpoint` item (T30) draws no timeline row; T31's changed-files card reads it.
  const items = input.items.filter((item) => item.type !== "checkpoint");
  const runningRunId = input.runs.find((run) => run.status === "running")?.id ?? null;
  const lastIndexByRun = new Map<string, number>();
  // A run whose journal recorded the interrupt already has T3's divider; no synthetic "Stopped".
  const interruptedByJournal = new Set<string>();
  items.forEach((item, index) => {
    if (item.runId !== null) lastIndexByRun.set(item.runId, index);
    if (item.runId !== null && item.type === "run_interrupt_result") interruptedByJournal.add(item.runId);
  });
  const endByIndex = new Map<number, TurnItem>();
  for (const run of input.runs) {
    const last = lastIndexByRun.get(run.id);
    if (last === undefined) continue;
    if (run.status === "interrupted" && interruptedByJournal.has(run.id)) continue;
    const end = runEndItem(run, items[last]!.updatedAt);
    if (end) endByIndex.set(last, end);
  }

  const entries: TimelineEntry[] = [];
  const push = (item: TurnItem, index: number) => {
    const createdAt = itemCreatedAt(item);
    if (item.type === "user_message" || item.type === "assistant_message") {
      const message: ChatMessage = {
        id: item.id,
        role: item.type === "user_message" ? "user" : "assistant",
        text: item.text,
        ...((item.attachments?.length ?? 0) > 0 ? { attachments: item.attachments } : {}),
        runId: item.runId,
        streaming: item.type === "assistant_message" && item.streaming,
        createdAt,
        updatedAt: item.updatedAt,
        ...(item.type === "user_message" && item.inputIntent ? { inputIntent: item.inputIntent } : {}),
      };
      entries.push({ id: item.id, kind: "message", createdAt, message, projectedItem: item });
      return;
    }
    if (STANDALONE_ITEM_TYPES.has(item.type)) {
      entries.push({ id: item.id, kind: "event", createdAt, projectedItem: item });
      return;
    }
    const time = item.type === "reasoning" ? reasoningTime(items, index, runningRunId) : undefined;
    entries.push({ id: item.id, kind: "work", createdAt, entry: projectedWorkEntry(item, time) });
  };
  items.forEach((item, index) => {
    push(item, index);
    const end = endByIndex.get(index);
    if (end) push(end, -1);
  });
  return entries;
}
