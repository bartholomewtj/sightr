// Adapted from T3 Code apps/web/src/components/chat/MessagesTimeline.logic.ts @ e3b35d1b (MIT, see THIRD_PARTY.md).
// The row model is upstream's: messages, tool groups (`work-toggle` / `work` details), the live tool
// row (`work-live`), the `working` header and `thinking` tail of an active turn, `turn-fold` ("Worked
// for 1m 3s") over a settled run's work, and `assistant-meta` after trailing tool groups. Function
// names and order follow upstream so a later T3 change can be diffed in.
// Changes from upstream:
// - Times are epoch ms; runs are Sightr's (`Run`), so a fold is timed from its own run when known.
// - Left out (no herdr source): worktree setup, superseded attempts, subagents, proposed plans, HTML
//   renders, MCP apps, context compaction, checkpoint diffs / revert counts, citations, the minimap.
// - Sightr rows: `event` carries `session` and `screen` items; `day` dividers between calendar days
//   (`insertDayDividers`).
// - Follow re-arms within 80 px of the end (T11), not 40.
// - A dynamic tool's row leads with `dynamicToolDisplayName` (an MCP tool as "<tool> · <server>").
// - Sightr row: `changed-files` (the "Changed files" card under a run's reply, T24), derived from the
//   run's `file_change` items (`ChangedFiles.logic.ts`); it is not part of a work-log group.
// - The live row names a command by its first 40 characters (`commandPreview`), not its first word:
//   a Pi loop read "Running for" (live 2026-10-18). The row adds the elapsed time (MessagesTimeline).
import type { Run, TurnItem } from "@shared/v2/contracts";

import {
  dynamicToolDisplayName,
  formatDuration,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
  type ChatMessage,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import {
  commandDisplayText,
  commandProgramName,
} from "@t3tools/client-runtime/work-log/command-label";
import { checkpointSignature, hasRunChanges, resolveRunChanges } from "@/lib/runChanges";
import { sameSubagents, type SubagentItem } from "@/lib/subagentGroups";
import { changedFilesSignature, deriveRunChangedFiles, type RunChangedFiles } from "./ChangedFiles.logic";
import {
  liveActivityToolStatus,
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  type ToolGroupSummaryKind,
} from "@t3tools/client-runtime/work-log/presentation";
export {
  normalizeCompactToolLabel,
  toolGroupAction,
} from "@t3tools/client-runtime/work-log/presentation";
import {
  collectToolFilePaths,
  dynamicToolTitle,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";

type RunId = string;

function timelineEntryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.runId ?? null) : null;
  }
  return entry.kind === "work" ? (entry.entry.runId ?? null) : null;
}

function workEntryIsActiveTurnActivity(entry: WorkLogEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    (entry.toolLifecycleStatus === undefined &&
      (entry.sourceActivityKind === "task.progress" || workLogEntryIsToolLike(entry)))
  );
}

function singleToolCallLabel(entry: WorkLogEntry): string {
  if (entry.itemType === "reasoning") return entry.detail?.trim().replace(/\s+/g, " ") || "Thought";
  const toolPresentation = resolveWorkEntryToolPresentation(entry, "completed");
  if (toolPresentation) return toolPresentation.displayName;
  const item = entry.structuredPayload;
  const title =
    item?.type === "dynamic_tool" ? dynamicToolTitle(item.toolName, item.input, item.title) : null;
  if (title) return title;
  if (entry.itemType === "web_search") return entry.detail ?? entry.toolTitle ?? "Web search";
  return workEntryDisplayLabel(entry, undefined);
}

function workEntryToolDataRecord(entry: WorkLogEntry): Record<string, unknown> | undefined {
  return entry.toolData !== null &&
    typeof entry.toolData === "object" &&
    !Array.isArray(entry.toolData)
    ? (entry.toolData as Record<string, unknown>)
    : undefined;
}

function workEntryReadRawPaths(entry: WorkLogEntry): readonly string[] {
  const fromChanged = entry.changedFiles ?? [];
  if (fromChanged.length > 0) return fromChanged;
  const structured = entry.structuredPayload;
  if (structured?.type === "dynamic_tool") {
    // Sightr: a journal records the read's path as the input string.
    if (typeof structured.input === "string" && structured.input.trim()) return [structured.input];
    const structuredPaths = collectToolFilePaths({ input: structured.input });
    if (structuredPaths.length > 0) return structuredPaths;
  }
  return collectToolFilePaths(workEntryToolDataRecord(entry));
}

/** T3's `formatWorkspaceRelativePath`, without a workspace root (herdr panes have none here). */
function formatWorkspaceRelativePath(filePath: string, workspaceRoot: string | undefined): string {
  const path = filePath.trim().replaceAll("\\", "/");
  if (!workspaceRoot) return path;
  const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  return path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? path.slice(root.length + 1) : path;
}

function workEntryReadPaths(entry: WorkLogEntry, workspaceRoot: string | undefined): string[] {
  return workEntryReadRawPaths(entry).map((filePath) =>
    formatWorkspaceRelativePath(filePath, workspaceRoot),
  );
}

export function workEntryDisplayLabel(entry: WorkLogEntry, workspaceRoot: string | undefined) {
  if (entry.itemType === "system_notice") return entry.label;
  if (entry.itemType === "reasoning" || entry.tone === "thinking") {
    const thought = entry.detail?.trim().replace(/\s+/g, " ");
    return thought || entry.label;
  }
  if (entry.itemType === "approval_request") {
    const item = entry.projectedItem ?? entry.structuredPayload;
    if (item?.type === "approval_request") {
      const s = item.subject;
      if (s) {
        const title = s.title?.trim();
        const detail = s.detail?.trim();
        const target = s.target?.trim();
        if (detail) {
          return title ? `${title} · ${detail}` : detail;
        }
        if (target) {
          const preview = commandPreview(target);
          return title ? `${title} · ${preview}` : preview;
        }
        if (title) return title;
      }
    }
    return entry.label?.trim() || "Approval requested";
  }
  const toolPresentation = resolveWorkEntryToolPresentation(entry);
  if (toolPresentation) return toolPresentation.displayName;
  if (entry.command?.trim()) return commandDisplayText(entry.command);
  const action = toolGroupAction(entry);
  if (action === "code-search" || action === "search") {
    const searchLabel =
      entry.itemType === "file_search"
        ? entry.label
        : formatSearchToolLabel(workEntryToolDataRecord(entry));
    if (searchLabel) return searchLabel;
  }
  const readPaths = action === "read" ? workEntryReadPaths(entry, workspaceRoot) : [];
  if (action === "read" && readPaths[0]) {
    return formatReadToolLabel(readPaths[0], readPaths.length - 1);
  }
  const providerRetry = entry.projectedItem?.type === "error" && entry.projectedItem.retry !== undefined;
  const item = entry.structuredPayload;
  const title =
    item?.type === "dynamic_tool" ? dynamicToolTitle(item.toolName, item.input, item.title) : null;
  if (title) return title;
  const compactDetail = entry.detail?.trim();
  const detailIsSearchOutput =
    (action === "code-search" || action === "search") && /[\r\n]/.test(compactDetail ?? "");
  if (compactDetail && !providerRetry && action !== "read" && !detailIsSearchOutput) {
    // Sightr: a dynamic tool's detail is its input summary; lead with the tool name ("<tool> · <server>" for MCP).
    const toolName = item?.type === "dynamic_tool" ? dynamicToolDisplayName(item.toolName) : null;
    return toolName ? `${toolName} ${compactDetail.replace(/\s+/g, " ")}` : compactDetail;
  }
  const [firstPath] = entry.changedFiles ?? [];
  if (firstPath) {
    const path = formatWorkspaceRelativePath(firstPath, workspaceRoot);
    return entry.changedFiles!.length === 1
      ? path
      : `${path} +${entry.changedFiles!.length - 1} more`;
  }
  if (action === "read" && !entry.viewedImagePath) {
    return "Read file";
  }
  const heading = normalizeCompactToolLabel(entry.toolTitle || entry.label);
  return `${heading.charAt(0).toUpperCase()}${heading.slice(1)}`;
}

/** How much of a command the live row shows. */
export const COMMAND_PREVIEW_CHARS = 40;

/** A command's first {@link COMMAND_PREVIEW_CHARS} characters on one line, with "…" when cut. */
export function commandPreview(command: string, max = COMMAND_PREVIEW_CHARS): string {
  const flat = commandDisplayText(command).replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/** The live row is a command still running: it shows its elapsed time next to the label. */
export function liveWorkEntryIsRunningCommand(entry: WorkLogEntry, active: boolean): boolean {
  return Boolean(entry.command?.trim()) && entry.itemType !== "reasoning" && liveActivityToolStatus(entry.toolLifecycleStatus, active) === "inProgress";
}

export function liveWorkEntryLabel(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
  active: boolean,
) {
  const status = liveActivityToolStatus(entry.toolLifecycleStatus, active);
  if (entry.itemType === "reasoning") {
    return (
      entry.detail?.trim().replace(/\s+/g, " ") ||
      (status === "inProgress" ? "Thinking" : "Thought")
    );
  }
  const toolPresentation = resolveWorkEntryToolPresentation({
    ...entry,
    toolLifecycleStatus: status,
  });
  if (toolPresentation) return toolPresentation.displayName;
  const command = entry.command?.trim();
  if (command) {
    const verb =
      status === "inProgress"
        ? "Running"
        : status === "failed"
          ? "Failed"
          : status === "declined"
            ? "Declined"
            : status === "stopped"
              ? "Stopped"
              : "Ran";
    return `${verb} ${commandPreview(command) || commandProgramName(command) || "command"}`;
  }
  return workEntryDisplayLabel(entry, workspaceRoot);
}

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean {
  if (entry.itemType === "reasoning") return Boolean(entry.detail?.trim());
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    entry.toolLifecycleStatus === "stopped" ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * strict isAtEnd flickers false for a frame while streaming content grows under
 * the viewport, so follow re-arms within this distance of the real content
 * bottom instead. Sightr: 80 px (T11 "Follow mode").
 */
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 80;

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  if (!state) {
    return undefined;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  return contentLength - scroll - scrollLength <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

function computeElapsedMs(start: number | null | undefined, end: number | null | undefined): number | null {
  if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxTimestamp(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: number;
  updatedAt: number;
  streaming: boolean;
}

export type TimelineLatestRun = { runId: RunId } & Pick<Run, "status" | "startedAt" | "completedAt">;

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

export type MessagesTimelineRow = MessagesTimelineRowContent & {
  readonly continuesWorkLog?: boolean;
};

type MessagesTimelineRowContent =
  | {
      kind: "work";
      id: string;
      createdAt: number;
      groupedEntries: WorkLogEntry[];
      isExpandedToolGroup: boolean;
      displayLabel?: string;
    }
  | {
      kind: "work-live";
      id: string;
      createdAt: number;
      entry: WorkLogEntry;
      groupedEntries: WorkLogEntry[];
      groupId: string;
      expanded: boolean;
      active: boolean;
      thought?: WorkLogEntry;
    }
  | {
      kind: "working";
      id: string;
      createdAt: number | null;
    }
  | {
      kind: "thinking";
      id: string;
      createdAt: number | null;
      groupId?: string;
      expanded?: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: number;
      runId?: RunId | null;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      summary: string;
      summaryKind: ToolGroupSummaryKind;
      hasFailure: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: number;
      runId: RunId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: number;
      message: ChatMessage;
      projectedItem?: TurnItem;
      durationStart: number;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
    }
  | {
      kind: "assistant-meta";
      projectedItem?: TurnItem;
      id: string;
      createdAt: number;
      message: ChatMessage;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
    }
  | {
      kind: "event";
      id: string;
      createdAt: number;
      projectedItem: TurnItem;
      /** Sightr (T32): the agents of a run's subagent card (see `TimelineEntry`). */
      subagents?: readonly SubagentItem[];
    }
  | {
      /**
       * Sightr (T24, T31): the files a run changed. `summary` is the journal's (T24; null for a run whose only source is its
       * checkpoint, a shell-made change); `run` carries the checkpoint (T30) the card prefers when it is `ready`. Not a
       * work-log row.
       */
      kind: "changed-files";
      id: string;
      createdAt: number;
      runId: RunId;
      summary: RunChangedFiles | null;
      run?: Run;
    }
  | {
      /** Sightr: the calendar day changed between two rows. */
      kind: "day";
      id: string;
      createdAt: number;
      label: string;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, number> {
  const result = new Map<string, number>();
  let lastBoundary: number | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

export function workGroupId(timelineEntryId: string): string {
  return `work-group:${timelineEntryId}`;
}

function expandedWorkGroupRow(
  groupId: string,
  createdAt: number,
  groupedEntries: WorkLogEntry[],
): Extract<MessagesTimelineRow, { kind: "work" }> {
  return {
    kind: "work",
    id: `${groupId}:details`,
    createdAt,
    groupedEntries,
    isExpandedToolGroup: true,
  };
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  const visible = showCopyButton && hasText && !streaming;
  return {
    text: hasText ? text : null,
    visible,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.runId
      ? `turn:${message.runId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  runId: RunId;
  anchorEntryId: string;
  createdAt: number;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

/**
 * This is deliberately keyed on the turn's own lifecycle rather than transient
 * working state: right after the user sends a message, the previous turn is
 * still the "active" one until the server creates the new turn, and folding
 * must not flicker through that window.
 */
function deriveUnsettledRunId(
  latestRun: TimelineLatestRun | null,
  runningRunId: RunId | null = null,
): RunId | null {
  if (runningRunId !== null) return runningRunId;
  if (!latestRun) {
    return null;
  }
  const isSettled = latestRun.completedAt != null && latestRun.status !== "running";
  return isSettled ? null : latestRun.runId;
}

function timelineEntryFoldRunId(entry: TimelineEntry, runlessKey: RunId | null): RunId | null {
  if (entry.kind === "work" && entry.entry.itemType === "system_notice") return null;
  if (entry.kind === "message" && entry.message.role === "assistant") {
    return entry.message.runId ?? runlessKey;
  }
  if (entry.kind === "work") {
    return entry.entry.runId ?? runlessKey;
  }
  return null;
}

function timelineEntryStartsResponse(entry: TimelineEntry): boolean {
  return (
    entry.kind === "message" &&
    entry.message.role === "user" &&
    entry.message.inputIntent !== "steer" &&
    entry.message.inputIntent !== "promoted_queued_to_steer"
  );
}

function responseBoundaryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") return entry.message.runId ?? null;
  if (entry.kind === "work") return entry.entry.runId ?? null;
  return null;
}

/**
 * A promptless provider restart replaces the native turn without adding a user
 * message. Keep every provider turn since the initiating prompt in one visual
 * response until the replacement turn settles.
 */
function lastResponseBoundaryIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(timelineEntryStartsResponse);
}

function deriveActiveVisualResponseRunIds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  unsettledRunId: RunId | null;
  isWorking: boolean;
}): ReadonlySet<RunId> {
  const runIds = new Set<RunId>();
  if (input.unsettledRunId === null) {
    return runIds;
  }

  runIds.add(input.unsettledRunId);
  if (!input.isWorking) {
    return runIds;
  }

  const latestResponseBoundaryIndex = lastResponseBoundaryIndex(input.timelineEntries);
  for (
    let index = latestResponseBoundaryIndex + 1;
    index < input.timelineEntries.length;
    index += 1
  ) {
    const runId = timelineEntryRunId(input.timelineEntries[index]!);
    if (runId !== null) {
      runIds.add(runId);
    }
  }
  return runIds;
}

function timelineEntryFailedItem(entry: TimelineEntry) {
  const item = entry.kind === "event" ? entry.projectedItem : entry.kind === "work" ? entry.entry.projectedItem : null;
  return item?.type === "error" && item.status === "failed" ? item : null;
}

function failedTimelineRunIds(
  entries: ReadonlyArray<TimelineEntry>,
  latestRun: TimelineLatestRun | null,
) {
  const failed = new Set<RunId>();
  if (latestRun?.status === "failed") failed.add(latestRun.runId);
  for (const entry of entries) {
    const runId = timelineEntryFailedItem(entry)?.runId;
    if (runId) failed.add(runId);
  }
  return failed;
}

function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestRun: TimelineLatestRun | null;
  runsById: ReadonlyMap<RunId, Pick<Run, "status" | "startedAt" | "completedAt">>;
  unfoldedRunIds: ReadonlySet<RunId>;
}): ReadonlyMap<string, TurnFold> {
  const promptIndexByRunId = new Map<RunId, number>();
  for (const [index, entry] of input.timelineEntries.entries()) {
    if (timelineEntryStartsResponse(entry)) {
      const runId = responseBoundaryRunId(entry);
      if (runId !== null && !promptIndexByRunId.has(runId)) promptIndexByRunId.set(runId, index);
    }
  }

  interface TurnGroup {
    entries: Array<TimelineEntry>;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    /**
     * Entry timestamps alone undercount the duration (the first entry appears
     * only once the provider starts producing output), and a turn cut short by
     * a steer may hold a single instantaneous commentary message.
     */
    startBoundary: number | null;
    anchorEntryId: string;
  }
  const groupsByRunId = new Map<RunId, TurnGroup>();
  const runlessFailedKeys = new Set<RunId>();

  // Fold state is keyed by run, so each runless prompt lends its response a
  // stable key of its own.
  let runlessKey: RunId | null = null;
  let responseKey: RunId | null = null;
  let pendingBoundary: { createdAt: number; anchorEntryId: string } | null = null;
  for (const [index, entry] of input.timelineEntries.entries()) {
    if (timelineEntryStartsResponse(entry)) {
      const nextEntry = input.timelineEntries[index + 1];
      pendingBoundary = nextEntry
        ? { createdAt: entry.createdAt, anchorEntryId: nextEntry.id }
        : null;
      const boundaryRunId = responseBoundaryRunId(entry);
      runlessKey = boundaryRunId == null ? `runless:${entry.id}` : null;
      responseKey = boundaryRunId ?? runlessKey;
      continue;
    }
    const ownRunId = timelineEntryFoldRunId(entry, runlessKey);
    if (!ownRunId) {
      continue;
    }
    const runId =
      responseKey !== null && (promptIndexByRunId.get(ownRunId) ?? -1) > index
        ? responseKey
        : ownRunId;
    if (runId === runlessKey && timelineEntryFailedItem(entry) !== null) {
      runlessFailedKeys.add(runId);
    }
    let group = groupsByRunId.get(runId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        startBoundary: pendingBoundary?.createdAt ?? null,
        anchorEntryId: pendingBoundary?.anchorEntryId ?? entry.id,
      };
      pendingBoundary = null;
      groupsByRunId.set(runId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) {
        group.hasStreamingMessage = true;
      }
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [runId, group] of groupsByRunId) {
    if (input.unfoldedRunIds.has(runId) || runlessFailedKeys.has(runId)) {
      continue;
    }
    if (group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    const terminalEntryIndex = group.terminalEntry
      ? group.entries.findIndex((entry) => entry.id === group.terminalEntry?.id)
      : group.entries.length;
    for (const [index, entry] of group.entries.entries()) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      const isFoldableTrailingActivity =
        entry.kind === "work" &&
        entry.entry.toolLifecycleStatus !== "inProgress" &&
        !workEntryDisplayIndicatesToolFailure(entry.entry);
      if (index > terminalEntryIndex && !isFoldableTrailingActivity) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) {
      continue;
    }

    const isLatestInterruptedTurn =
      input.latestRun?.runId === runId && input.latestRun.status === "interrupted";
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    // Sightr: every run carries its own start and end, not only the latest.
    const run = input.runsById.get(runId);
    const elapsedMs =
      run?.completedAt != null
        ? computeElapsedMs(run.startedAt, run.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxTimestamp(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
              lastEntryEnd,
          );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    foldsByAnchorEntryId.set(group.anchorEntryId, {
      runId,
      anchorEntryId: group.anchorEntryId,
      createdAt: group.startBoundary ?? firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return foldsByAnchorEntryId;
}

function attachTrailingToolGroupsToAssistant(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MessagesTimelineRow[] {
  const messageRowsWithoutMeta = new Set<string>();
  const metaRowsAfterIndex = new Map<
    number,
    Extract<MessagesTimelineRow, { kind: "assistant-meta" }>
  >();

  for (const [messageIndex, row] of rows.entries()) {
    const runId = row.kind === "message" ? (row.message.runId ?? null) : null;
    if (
      row.kind !== "message" ||
      row.message.role !== "assistant" ||
      !row.showAssistantMeta ||
      runId === null
    ) {
      continue;
    }

    let lastTrailingWorkIndex = -1;
    let hasTrailingToolGroup = false;
    for (let index = messageIndex + 1; index < rows.length; index += 1) {
      const candidate = rows[index];
      if (!candidate || candidate.kind === "message") {
        break;
      }
      if (candidate.kind === "work-toggle" && candidate.runId === runId) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "work" &&
        candidate.groupedEntries.some((entry) => entry.runId === runId)
      ) {
        if (
          !candidate.isExpandedToolGroup &&
          candidate.groupedEntries.some(
            (entry) =>
              workLogEntryIsToolLike(entry) ||
              (entry.projectedItem?.type === "error" && entry.projectedItem.status === "failed"),
          )
        ) {
          hasTrailingToolGroup = true;
        }
        if (hasTrailingToolGroup) {
          lastTrailingWorkIndex = index;
        }
      }
    }

    if (lastTrailingWorkIndex < 0) {
      continue;
    }

    messageRowsWithoutMeta.add(row.id);
    metaRowsAfterIndex.set(lastTrailingWorkIndex, {
      kind: "assistant-meta",
      id: `assistant-meta:${row.message.id}`,
      ...(row.projectedItem === undefined ? {} : { projectedItem: row.projectedItem }),
      createdAt: rows[lastTrailingWorkIndex]?.createdAt ?? row.message.updatedAt,
      message: row.message,
      showAssistantCopyButton: row.showAssistantCopyButton,
      assistantCopyStreaming: row.assistantCopyStreaming,
    });
  }

  const result: MessagesTimelineRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && messageRowsWithoutMeta.has(row.id)) {
      result.push({ ...row, showAssistantMeta: false, showAssistantCopyButton: false });
    } else {
      result.push(row);
    }
    const metaRow = metaRowsAfterIndex.get(index);
    if (metaRow) {
      result.push(metaRow);
    }
  }
  return result;
}

const supersededReasoningEntries = new WeakMap<TimelineEntry, TimelineEntry>();

/** A steer or subsequent activity ends thinking even if the provider omits its completion. */
function settleSupersededReasoning(entries: ReadonlyArray<TimelineEntry>) {
  return entries.map((entry, index) => {
    if (
      index === entries.length - 1 ||
      entry.kind !== "work" ||
      entry.entry.itemType !== "reasoning" ||
      entry.entry.toolLifecycleStatus !== "inProgress"
    ) {
      return entry;
    }
    let settled = supersededReasoningEntries.get(entry);
    if (!settled) {
      settled = { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "completed" } };
      supersededReasoningEntries.set(entry, settled);
    }
    return settled;
  });
}

export interface MessagesTimelineRowsInput {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun?: TimelineLatestRun | null;
  runningRunId?: RunId | null;
  /** Sightr: every run in the window, for fold durations. */
  runs?: ReadonlyArray<Run>;
  expandedRunIds?: ReadonlySet<RunId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt?: number | null;
  /** Sightr: "now" for day dividers; omit to leave them out. */
  now?: number;
}

export function deriveMessagesTimelineRows(input: MessagesTimelineRowsInput): MessagesTimelineRow[] {
  const timelineEntries = settleSupersededReasoning(input.timelineEntries);
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(timelineEntries);
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const failedRunIds = failedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries: timelineEntries,
    unsettledRunId,
    isWorking: input.isWorking,
  });
  const runsById = new Map((input.runs ?? []).map((run) => [run.id, run] as const));
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: timelineEntries,
    terminalAssistantMessageIds,
    latestRun: input.latestRun ?? null,
    runsById,
    unfoldedRunIds: new Set([...activeVisualResponseRunIds, ...failedRunIds]),
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedRunIds?.has(fold.runId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }
  const runIdIsActiveResponse = (runId: RunId | null | undefined) =>
    runId == null ? false : activeVisualResponseRunIds.has(runId);
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    input.isWorking &&
    entry.toolLifecycleStatus === "inProgress" &&
    entry.runId != null &&
    entry.runId === unsettledRunId;

  const activeTurnHeaderIndex = input.isWorking
    ? lastResponseBoundaryIndex(timelineEntries) + 1
    : timelineEntries.length;

  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  if (input.isWorking && unsettledRunId !== null) {
    for (let index = timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
      const entry = timelineEntries[index]!;
      if (
        entry.kind !== "work" ||
        entry.entry.tone === "error" ||
        entry.entry.sourceActivityKind === "runtime.error" ||
        entry.entry.itemType === "system_notice" ||
        !runIdIsActiveResponse(entry.entry.runId) ||
        collapsedEntryIds.has(entry.id) ||
        foldsByAnchorEntryId.has(entry.id)
      ) {
        break;
      }
      activeToolEntries.push(entry);
    }
  }
  activeToolEntries.reverse();
  const visibleActiveToolEntries = activeToolEntries.filter((entry) =>
    workEntryIsVisibleInGroup(entry.entry, true),
  );
  const activeWorkAnchor = activeToolEntries[0];
  const latestVisibleToolEntry = visibleActiveToolEntries.at(-1);
  const latestRunningToolEntry = visibleActiveToolEntries.findLast((entry) =>
    workEntryIsActiveTurnActivity(entry.entry),
  );
  const latestToolKeepsActivityLive =
    latestRunningToolEntry !== undefined ||
    (latestVisibleToolEntry !== undefined &&
      workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry));
  const latestToolFailed =
    latestRunningToolEntry === undefined &&
    latestVisibleToolEntry !== undefined &&
    latestVisibleToolEntry.entry.toolLifecycleStatus !== "declined" &&
    workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry);

  const latestThoughtEntry = visibleActiveToolEntries.findLast(
    (entry) => entry.entry.itemType === "reasoning" && (entry.entry.detail?.trim() ?? "") !== "",
  );
  const activeWorkPlacementEntryId = latestVisibleToolEntry?.id;
  const activeWorkRow =
    activeWorkAnchor && latestVisibleToolEntry && !latestToolFailed
      ? (() => {
          const groupId = workGroupId(activeWorkAnchor.id);
          return {
            kind: "work-live" as const,
            id: latestToolKeepsActivityLive
              ? LIVE_ACTIVITY_ROW_ID
              : `work-live:${activeWorkAnchor.id}`,
            createdAt: activeWorkAnchor.createdAt,
            entry: (latestRunningToolEntry ?? latestVisibleToolEntry).entry,
            groupedEntries: visibleActiveToolEntries.map((entry) => entry.entry),
            groupId,
            expanded: input.expandedWorkGroupIds?.has(groupId) ?? false,
            active: latestToolKeepsActivityLive,
            ...(latestThoughtEntry ? { thought: latestThoughtEntry.entry } : {}),
          };
        })()
      : null;
  const activeWorkEntryIds = new Set(
    activeWorkRow !== null || latestToolFailed ? activeToolEntries.map((entry) => entry.id) : [],
  );
  const appendWorkingRow = () => {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt ?? null,
    });
  };
  let hasActivityRow = false;
  const appendActiveWorkRows = () => {
    if (activeWorkRow === null) return;
    nextRows.push(activeWorkRow);
    hasActivityRow ||= activeWorkRow.active;
    if (!activeWorkRow.expanded) return;
    nextRows.push(
      expandedWorkGroupRow(
        activeWorkRow.groupId,
        activeWorkRow.createdAt,
        activeWorkRow.groupedEntries,
      ),
    );
  };

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (input.isWorking && index === activeTurnHeaderIndex) {
      appendWorkingRow();
    }

    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.runId}`,
        createdAt: turnFold.createdAt,
        runId: turnFold.runId,
        label: turnFold.label,
        expanded: input.expandedRunIds?.has(turnFold.runId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (
        (timelineEntry.entry.runId != null && failedRunIds.has(timelineEntry.entry.runId)) ||
        (timelineEntry.entry.itemType === "error" &&
          timelineEntry.entry.toolLifecycleStatus === "failed") ||
        timelineEntry.entry.tone === "error" ||
        timelineEntry.entry.sourceActivityKind === "runtime.error" ||
        timelineEntry.entry.itemType === "system_notice"
      ) {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
          isExpandedToolGroup: false,
        });
        continue;
      }
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.tone === "error" ||
          nextEntry.entry.sourceActivityKind === "runtime.error" ||
          nextEntry.entry.itemType === "system_notice" ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id) ||
          (nextEntry.entry.runId ?? null) !== (timelineEntry.entry.runId ?? null)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter((entry) =>
        workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry)),
      );
      if (visibleGroupedEntries.length > 0) {
        const activeInProgressToolEntries = visibleGroupedEntries.filter(workEntryIsInActiveRun);
        if (activeInProgressToolEntries.length > 0) {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const latestActiveToolEntry = activeInProgressToolEntries.at(-1)!;
          nextRows.push({
            kind: "work-live",
            id: `work-live:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            entry: latestActiveToolEntry,
            groupedEntries: visibleGroupedEntries,
            groupId,
            expanded,
            active: true,
          });
          hasActivityRow = true;
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries),
            );
          }
        } else if (
          visibleGroupedEntries.length === 1 &&
          workLogEntryIsToolLike(visibleGroupedEntries[0]!)
        ) {
          const singleEntry = visibleGroupedEntries[0]!;
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
            isExpandedToolGroup: false,
            displayLabel:
              toolGroupAction(singleEntry) === "edit"
                ? summarizeToolGroup(visibleGroupedEntries).summary
                : singleToolCallLabel(singleEntry),
          });
        } else {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const summaryKind = toolGroupSummaryKind(visibleGroupedEntries);
          const latestToolEntry = visibleGroupedEntries.findLast(workLogEntryIsToolLike);
          const singleEntry =
            visibleGroupedEntries.length === 1 ? (visibleGroupedEntries[0] ?? null) : null;
          const usesSingleToolCallLabel =
            singleEntry !== null &&
            workLogEntryIsToolLike(singleEntry) &&
            toolGroupAction(singleEntry) !== "edit";
          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            runId: timelineEntry.entry.runId ?? null,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            summary: usesSingleToolCallLabel
              ? singleToolCallLabel(singleEntry)
              : singleEntry !== null && !workLogEntryIsToolLike(singleEntry)
                ? singleEntry.label
                : summarizeToolGroup(visibleGroupedEntries).summary,
            summaryKind,
            hasFailure:
              latestToolEntry !== undefined &&
              workEntryDisplayIndicatesToolFailure(latestToolEntry),
          });
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries),
            );
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "event") {
      nextRows.push({
        kind: "event",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        projectedItem: timelineEntry.projectedItem,
        ...(timelineEntry.subagents ? { subagents: timelineEntry.subagents } : {}),
      });
      continue;
    }

    const assistantResponseStillInProgress =
      timelineEntry.message.role === "assistant" &&
      runIdIsActiveResponse(timelineEntry.message.runId);

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantResponseStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      ...(timelineEntry.projectedItem === undefined
        ? {}
        : { projectedItem: timelineEntry.projectedItem }),
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantResponseStillInProgress,
    });
  }

  const hasWorkingRow = nextRows.some((row) => row.kind === "working");
  if (input.isWorking && !hasWorkingRow && activeTurnHeaderIndex === timelineEntries.length) {
    appendWorkingRow();
  }
  if (input.isWorking && (!hasActivityRow || latestToolFailed)) {
    const failedGroupAnchor = latestToolFailed ? activeWorkAnchor : undefined;
    if (failedGroupAnchor) {
      const groupId = workGroupId(failedGroupAnchor.id);
      const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
        groupId,
        expanded,
      });
      if (expanded) {
        nextRows.push(
          expandedWorkGroupRow(
            groupId,
            failedGroupAnchor.createdAt,
            visibleActiveToolEntries.map((entry) => entry.entry),
          ),
        );
      }
    } else {
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
      });
    }
  }

  const result = insertChangedFilesRows(
    attachTrailingToolGroupsToAssistant(nextRows),
    deriveRunChangedFiles(timelineEntries),
    runsById,
  );
  const linked = result.map((row, index) =>
    timelineRowIsWorkLog(row) && timelineRowIsWorkLog(result[index + 1])
      ? { ...row, continuesWorkLog: true }
      : row,
  );
  return input.now === undefined ? linked : insertDayDividers(linked, input.now);
}

/** The run a row belongs to, for placing its changed-files card; null for rows with no run of their own. */
function rowRunId(row: MessagesTimelineRow): RunId | null {
  switch (row.kind) {
    case "work-toggle":
    case "turn-fold":
      return row.runId ?? null;
    case "work":
      return row.groupedEntries.find((entry) => entry.runId != null)?.runId ?? null;
    case "work-live":
      return row.entry.runId ?? null;
    default:
      return null;
  }
}

/**
 * T24: a `changed-files` row for each run that has a summary. It follows the run's last assistant
 * message row (and its `assistant-meta` when trailing tool groups moved the meta); a run with no
 * assistant message gets it after its last work row, or its `turn-fold` row when everything is folded.
 * The id is the run's, so the list keeps the row's identity as counts change and as a newer message
 * moves it down.
 */
function insertChangedFilesRows(
  rows: MessagesTimelineRow[],
  journalSummaries: ReadonlyMap<RunId, RunChangedFiles>,
  runsById: ReadonlyMap<RunId, Run>,
): MessagesTimelineRow[] {
  // T31: a run with a `ready` checkpoint that lists files (or could not show some) gets a card even when the journal saw
  // no edit (a change made by a shell command). A `ready` run with nothing net and no journal edit draws none.
  const summaries = new Map<RunId, RunChangedFiles | null>(journalSummaries);
  for (const run of runsById.values()) {
    if (summaries.has(run.id) || run.checkpoint?.status !== "ready") continue;
    if (hasRunChanges(resolveRunChanges({ run, journalFiles: null, now: 0 }))) summaries.set(run.id, null);
  }
  if (summaries.size === 0) return rows;
  const lastMessageIndex = new Map<RunId, number>();
  const lastWorkIndex = new Map<RunId, number>();
  const indexById = new Map<string, number>();
  rows.forEach((row, index) => {
    indexById.set(row.id, index);
    if (row.kind === "message" && row.message.role === "assistant" && row.message.runId != null) {
      lastMessageIndex.set(row.message.runId, index);
      return;
    }
    const runId = rowRunId(row);
    if (runId !== null) lastWorkIndex.set(runId, index);
  });

  const after = new Map<number, MessagesTimelineRow[]>();
  for (const [runId, summary] of summaries) {
    let anchor = lastMessageIndex.get(runId);
    if (anchor !== undefined) {
      const messageRow = rows[anchor] as Extract<MessagesTimelineRow, { kind: "message" }>;
      const metaIndex = indexById.get(`assistant-meta:${messageRow.message.id}`);
      if (metaIndex !== undefined && metaIndex > anchor) anchor = metaIndex;
    } else {
      anchor = lastWorkIndex.get(runId);
    }
    if (anchor === undefined) continue;
    const row: MessagesTimelineRow = {
      kind: "changed-files",
      id: `changed-files:${runId}`,
      createdAt: rows[anchor]!.createdAt ?? 0,
      runId,
      summary,
      ...(runsById.has(runId) ? { run: runsById.get(runId)! } : {}),
    };
    const list = after.get(anchor);
    if (list) list.push(row);
    else after.set(anchor, [row]);
  }
  if (after.size === 0) return rows;
  return rows.flatMap((row, index) => {
    const added = after.get(index);
    return added ? [row, ...added] : [row];
  });
}

function timelineRowIsWorkLog(row: MessagesTimelineRow | undefined): boolean {
  return (
    row !== undefined &&
    (row.kind === "work" ||
      row.kind === "work-toggle" ||
      row.kind === "work-live" ||
      row.kind === "thinking")
  );
}

// ── Day dividers (Sightr) ───────────────────────────────────────────────────────────────────────

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "Today", "Yesterday", or a short date ("Mon 14 Oct", with the year when it is not this year's). */
export function dayLabel(ms: number, now: number): string {
  const key = localDayKey(ms);
  if (key === localDayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDayKey(yesterday.getTime())) return "Yesterday";
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * A `day` row before the first row of each new calendar day (the idea of v1's fold "divider"). Rows
 * with no time of their own (the working header) never start a day. The divider's id is the day, so it
 * stays put as rows arrive. Only a step forward starts a day: a row whose clock is behind the one
 * before it (journal time against the bridge's, a run header stamped now) adds nothing, so a day's id
 * can never repeat (a repeated LegendList key drops rows).
 */
export function insertDayDividers(rows: MessagesTimelineRow[], now: number): MessagesTimelineRow[] {
  const out: MessagesTimelineRow[] = [];
  let currentDay: string | null = null;
  for (const row of rows) {
    const at = row.createdAt;
    if (typeof at === "number" && Number.isFinite(at) && at > 0 && row.kind !== "assistant-meta" && row.kind !== "changed-files") {
      const day = localDayKey(at);
      // `YYYY-MM-DD` keys order as strings.
      if (currentDay === null || day > currentDay) {
        if (currentDay !== null) out.push({ kind: "day", id: `day:${day}`, createdAt: at, label: dayLabel(at, now) });
        currentDay = day;
      }
    }
    out.push(row);
  }
  return out;
}

// ── Stable rows ─────────────────────────────────────────────────────────────────────────────────

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Upstream uses Effect's structural `Equal.equals`; entries here are rebuilt per item, so compare items. */
function sameEntries(a: ReadonlyArray<WorkLogEntry>, b: ReadonlyArray<WorkLogEntry>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((entry, index) => sameEntry(entry, b[index]!));
}

function sameEntry(a: WorkLogEntry, b: WorkLogEntry): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.projectedItem === b.projectedItem &&
      a.toolLifecycleStatus === b.toolLifecycleStatus &&
      a.reasoningTime === b.reasoningTime &&
      a.label === b.label)
  );
}

function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id || a.continuesWorkLog !== b.continuesWorkLog) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;
    case "thinking": {
      const bt = b as typeof a;
      return a.createdAt === bt.createdAt && a.groupId === bt.groupId && a.expanded === bt.expanded;
    }
    case "day": {
      const bd = b as typeof a;
      return a.label === bd.label;
    }
    case "assistant-meta": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.projectedItem === bm.projectedItem &&
        a.message.text === bm.message.text &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming
      );
    }
    case "turn-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }
    case "event":
      return a.projectedItem === (b as typeof a).projectedItem && sameSubagents(a.subagents, (b as typeof a).subagents);
    case "changed-files": {
      const bc = b as typeof a;
      return (
        a.runId === bc.runId &&
        (a.summary === null ? bc.summary === null : bc.summary !== null && changedFilesSignature(a.summary) === changedFilesSignature(bc.summary)) &&
        a.run?.status === bc.run?.status &&
        a.run?.completedAt === bc.run?.completedAt &&
        checkpointSignature(a.run?.checkpoint) === checkpointSignature(bc.run?.checkpoint)
      );
    }
    case "work": {
      const bw = b as typeof a;
      return (
        a.isExpandedToolGroup === bw.isExpandedToolGroup &&
        a.displayLabel === bw.displayLabel &&
        sameEntries(a.groupedEntries, bw.groupedEntries)
      );
    }
    case "work-live": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.expanded === bw.expanded &&
        a.active === bw.active &&
        sameEntry(a.entry, bw.entry) &&
        sameEntries(a.groupedEntries, bw.groupedEntries)
      );
    }
    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.runId === bw.runId &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.summary === bw.summary &&
        a.summaryKind === bw.summaryKind &&
        a.hasFailure === bw.hasFailure
      );
    }
    case "message": {
      const bm = b as typeof a;
      return (
        a.projectedItem === bm.projectedItem &&
        a.message.text === bm.message.text &&
        a.message.streaming === bm.message.streaming &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming
      );
    }
  }
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)/g;

function visibleUserMessageText(text: string): string {
  return text.replace(MARKDOWN_LINK, "$1");
}

export function shouldCollapseUserMessage(text: string): boolean {
  const visible = visibleUserMessageText(text);
  if (visible.trim().length === 0) {
    return false;
  }

  return (
    visible.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    visible.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}
