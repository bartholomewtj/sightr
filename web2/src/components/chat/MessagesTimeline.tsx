// Adapted from T3 Code apps/web/src/components/chat/MessagesTimeline.tsx @ db5919d87 (MIT, see THIRD_PARTY.md).
// Upstream's list and row components on Sightr's thread store: a `LegendList` of the rows
// `MessagesTimeline.logic.ts` derives, one memoised `TimelineRowContent` per row, T3's row components
// (user bubble, assistant markdown + meta, turn fold, working header, thinking tail, live tool row,
// tool group header, tool entry rows) and the `WorkLog*` primitives.
// Changes from upstream:
// - Reads `useThread(threadId)` (T09) instead of ChatView props; runs, items and the queue come from
//   the thread stream, the expanded folds and groups from `state/timeline.ts`.
// - Follow mode is Sightr's (T11): stick while within 80 px of the end, a "Jump to latest" pill with
//   a count of new rows, and this client's own send re-follows (`followTimeline()`).
// - Older history pages load when the top comes into view (`onStartReached`), with T3's history
//   control as the header (loading, retry, "Start of thread").
// - An expanded tool group is a plain bounded list, not a nested LegendList; a tool's detail is
//   `ToolItemDetail` (the job of T3's V2ItemInspector) and is only mounted while open.
// - No shimmer: the house look allows one motion, the working pulse (`animate-status-pulse`).
// - Settings → Display → Show thinking off (T18) drops `reasoning` items before the rows are derived.
// - Phone pass: an opened tool entry stays open when the list unmounts and remounts its row (T3 keeps
//   this in its work-group view state; here a map held while the timeline is mounted); LegendList pins
//   at any distance while following (threshold 1, as upstream) so the follow decision is ours alone;
//   raw buttons get a 44 px coarse-pointer height; an expanded thought follows its live text.
// - Event rows also draw T3's lifecycle rows (`V2LifecycleRow`: interrupt divider, compaction,
//   subagent) and the proposed-plan card (`ProposedPlanCard`); a file-change row carries T3's
//   `DiffStatLabel` in its trailing slot, and a task-list row a list icon.
// - Phone pass 2: a file-change or read row leads with the file name, its folder dim and cut from the
//   start (`FilePathLabel`); a page-fetch group reads "Fetched <host>"; paths in tool details and in
//   messages open the Files tab (`OpenFileThreadContext`); the thread details sheet
//   (`ThreadDetailsPanel`) is mounted beside the list.
// - Left out: minimap, citations, forks, revert, checkpoint diffs, attachment previews, worktree
//   setup, MCP apps, HTML renders.
import { LegendList, type LegendListRef, type MaintainScrollAtEndOptions } from "@legendapp/list/react";
import { descriptorFor } from "@shared/agents";
import type { Run } from "@shared/v2/contracts";
import {
  ArrowDownIcon,
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  ListTodoIcon,
  MessageCircleIcon,
  PaperclipIcon,
  RotateCcwIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "~/components/ui/tooltip";
import ChatMarkdown from "~/components/ChatMarkdown";
import {
  deriveTimelineEntries,
  formatDuration,
  formatThinkDuration,
  orderedItems,
  reasoningLabel,
  workEntryDisplayIndicatesToolFailure,
  workEntrySignalsSevereFailure,
  workLogEntryIsToolLike,
  type WorkLogEntry,
} from "~/session-logic";
import { liveThoughtLine } from "@t3tools/client-runtime/work-log/presentation";
import { useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useThread } from "@/stream/stores";
import {
  loadOlderHistory,
  toggleTurnFold,
  toggleWorkGroup,
  useHistoryState,
  useThreadTimelineUi,
  useTimelineStore,
} from "@/state/timeline";

import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  liveWorkEntryIsRunningCommand,
  liveWorkEntryLabel,
  resolveAssistantMessageCopyState,
  shouldCollapseUserMessage,
  toolGroupAction,
  workEntryDisplayLabel,
  workEntryIsVisibleInGroup,
  type MessagesTimelineRow,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";
import { DiffStatLabel } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { OpenFileThreadContext } from "../right-panel/OpenFileLink";
import { ScreenTimelineRow } from "./ScreenTimelineRow";
import { ThreadDetailsSheet } from "./ThreadDetailsPanel";
import { isV2LifecycleItem, V2LifecycleRow } from "./V2LifecycleRow";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { ToolItemDetail, toolItemHasDetail } from "./ToolItemDetail";
import { useTimelineFollow } from "./useTimelineFollow";
import { EverythingSet } from "./threadFind";
import { useThreadFind } from "./useThreadFind";
import { useThreadFindNavigation } from "./useThreadFindNavigation";
import { WorkLogBlock, WorkLogButton, WorkLogDetails, WorkLogList, WorkLogRow } from "./WorkLog";

type TimelineRow = MessagesTimelineRow;

interface TimelineRowSharedState {
  threadId: string;
  harness: string;
  onToggleTurnFold: (runId: string) => void;
  onToggleWorkGroup: (groupId: string) => void;
  /** The operator's open/closed choice per tool entry, kept while the list unmounts its row. */
  entryDisclosure: Map<string, boolean>;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  awaitingUser: boolean;
  queuedCount: number;
  runningRunId: string | null;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);

const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: { dataChange: true, footerLayout: false, itemLayout: true, layout: true },
} as const satisfies MaintainScrollAtEndOptions;

const MAINTAIN_VISIBLE_CONTENT_POSITION = { data: true, size: true } as const;

const MESSAGE_HEADING_LEVEL = 3;

export interface MessagesTimelineProps {
  threadId: string;
}

export function MessagesTimeline({ threadId }: MessagesTimelineProps) {
  // Paths in tool rows and in messages open in this thread's Files tab; the details sheet rides along.
  return (
    <OpenFileThreadContext value={threadId}>
      <MessagesTimelineBody threadId={threadId} />
      <ThreadDetailsSheet threadId={threadId} />
    </OpenFileThreadContext>
  );
}

function MessagesTimelineBody({ threadId }: MessagesTimelineProps) {
  const state = useThread(threadId);
  const ui = useThreadTimelineUi(threadId);
  const history = useHistoryState(threadId);
  const followRequest = useTimelineStore((s) => s.followRequest);

  // Settings → Display → Show thinking (T18): off drops the thought rows; the run banner still times the work.
  const { showThinking } = useDisplayPrefs();
  const items = useMemo(() => {
    const all = state ? orderedItems(state.items) : [];
    return showThinking ? all : all.filter((item) => item.type !== "reasoning");
  }, [state?.items, showThinking]);
  const runs = useMemo(
    () => (state ? Object.values(state.runs).sort((a, b) => a.ordinal - b.ordinal) : ([] as Run[])),
    [state?.runs],
  );
  const entries = useMemo(() => deriveTimelineEntries({ items, runs }), [items, runs]);
  const thread = state?.thread ?? null;
  const latest = runs.at(-1) ?? null;
  const runningRun = runs.findLast((run) => run.status === "running") ?? null;
  const isWorking = runningRun !== null || thread?.status === "working";
  const awaitingUser = thread?.status === "approval" || thread?.status === "input";

  const derivedRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries: entries,
        latestRun: latest
          ? { runId: latest.id, status: latest.status, startedAt: latest.startedAt, completedAt: latest.completedAt }
          : null,
        runningRunId: runningRun?.id ?? null,
        runs,
        expandedRunIds: ui.expandedRunIds,
        expandedWorkGroupIds: ui.expandedWorkGroupIds,
        isWorking,
        activeTurnStartedAt: runningRun?.startedAt ?? null,
        now: Date.now(),
      }),
    [entries, latest, runningRun, runs, ui.expandedRunIds, ui.expandedWorkGroupIds, isWorking],
  );
  const stable = useRef<StableMessagesTimelineRowsState>({ byId: new Map(), result: [] });
  const rows = useMemo(() => {
    stable.current = computeStableMessagesTimelineRows(derivedRows, stable.current);
    return stable.current.result;
  }, [derivedRows]);

  // T3's `workGroupViewState.expandedEntries`: the operator's tool-entry toggles, for as long as this
  // thread's timeline is mounted, so a row the list unmounts off-screen comes back as it was left.
  const entryDisclosure = useMemo(() => new Map<string, boolean>(), [threadId]);
  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      threadId,
      harness: thread?.harness ?? "",
      onToggleTurnFold: (runId) => toggleTurnFold(threadId, runId),
      onToggleWorkGroup: (groupId) => toggleWorkGroup(threadId, groupId),
      entryDisclosure,
    }),
    [threadId, thread?.harness, entryDisclosure],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({ isWorking, awaitingUser, queuedCount: state?.queue.length ?? 0, runningRunId: runningRun?.id ?? null }),
    [isWorking, awaitingUser, state?.queue.length, runningRun?.id],
  );

  // ── Follow mode ──────────────────────────────────────────────────────────────────────────────
  const listRef = useRef<LegendListRef | null>(null);
  const readEndState = useCallback(() => listRef.current?.getState?.(), []);
  const scrollToEnd = useCallback(() => void listRef.current?.scrollToEnd({ animated: false }), []);
  const find = useThreadFind(threadId);
  const [timelineEl, setTimelineEl] = useState<HTMLDivElement | null>(null);
  const { following, unseenCount, onScroll: handleScroll, jumpToLatest } = useTimelineFollow({
    rows,
    readEndState,
    scrollToEnd,
    followRequest,
    container: timelineEl,
    // Find scrolls the list to its hit itself; that scroll leaves follow mode.
    anyScrollLeaves: find.isOpen,
  });

  // ── Find (T19): reveal and highlight the focused hit; the bar itself is the thread route's ──
  useThreadFindNavigation({
    threadId,
    container: timelineEl,
    query: find.isOpen ? find.query : "",
    match: find.match,
    navigationId: find.navigationId,
    rows,
    deriveAllOpenRows: () =>
      deriveMessagesTimelineRows({
        timelineEntries: entries,
        latestRun: latest
          ? { runId: latest.id, status: latest.status, startedAt: latest.startedAt, completedAt: latest.completedAt }
          : null,
        runningRunId: runningRun?.id ?? null,
        runs,
        expandedRunIds: new EverythingSet(),
        expandedWorkGroupIds: new EverythingSet(),
        isWorking,
        activeTurnStartedAt: runningRun?.startedAt ?? null,
      }),
    listRef,
  });

  // ── History ──────────────────────────────────────────────────────────────────────────────────
  const historyCursor = state?.historyCursor ?? null;
  const synchronized = state !== null && !state.syncing;
  const onStartReached = useCallback(() => {
    if (historyCursor !== null && history.status === "idle") void loadOlderHistory(threadId);
  }, [historyCursor, history.status, threadId]);

  const listHeader = useMemo(
    () => (
      <TimelineHistoryControl
        hasMoreHistory={historyCursor !== null}
        atStart={historyCursor === null && synchronized && rows.length > 0}
        loading={history.status === "loading"}
        error={history.error}
        onLoadEarlier={() => void loadOlderHistory(threadId)}
      />
    ),
    [historyCursor, synchronized, rows.length, history.status, history.error, threadId],
  );

  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="messages-timeline-row-frame px-3 sm:px-4">
        <div className="chat-content-lane overflow-x-clip" data-timeline-root="true">
          <TimelineRowContent row={item} />
        </div>
      </div>
    ),
    [],
  );

  if (state === null || (state.syncing && items.length === 0)) {
    return <TimelineSkeleton />;
  }
  // With older pages still on the bridge an empty window is not an empty thread: keep the list, whose
  // header offers "Load earlier messages" (T3 shows its placeholder only without history controls).
  if (rows.length === 0 && historyCursor === null) {
    const noJournal = thread !== null && !thread.capabilities.hasJournal;
    return (
      <div className="flex h-full items-center justify-center px-6" data-timeline-empty="true">
        <p className="text-center text-sm text-muted-foreground">
          {noJournal ? "This harness has no transcript. Switch to CLI to see the terminal." : "No messages yet. Type below to start."}
        </p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <TooltipScrollDismissArea ref={setTimelineEl} className="relative h-full min-h-0" data-timeline="true">
          <LegendList<MessagesTimelineRow>
            ref={listRef}
            data={rows}
            extraData={activityState}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            renderItem={renderItem}
            estimatedItemSize={90}
            recycleItems={false}
            initialScrollAtEnd
            maintainScrollAtEnd={following && !find.isOpen ? TIMELINE_MAINTAIN_SCROLL_AT_END : false}
            // `following` decides; a fraction of the viewport would disagree with the 80 px follow
            // band on a short (keyboard-open) phone viewport and leave new rows unpinned with no pill.
            maintainScrollAtEndThreshold={1}
            maintainVisibleContentPosition={MAINTAIN_VISIBLE_CONTENT_POSITION}
            onScroll={handleScroll}
            onStartReached={onStartReached}
            onStartReachedThreshold={0.2}
            className="messages-timeline-scroll h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]"
            ListHeaderComponent={listHeader}
            ListFooterComponent={TIMELINE_LIST_FOOTER}
          />
          {!following ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <Button
                size="sm"
                variant="outline"
                className="pointer-events-auto rounded-full shadow-sm"
                onClick={jumpToLatest}
                data-jump-to-latest="true"
              >
                <ArrowDownIcon className="size-3.5" />
                Jump to latest
                {unseenCount > 0 ? <span className="font-mono tabular-nums">· {unseenCount} new</span> : null}
              </Button>
            </div>
          ) : null}
        </TooltipScrollDismissArea>
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
}

const TIMELINE_LIST_FOOTER = <div aria-hidden className="h-3 sm:h-4" />;

function TimelineSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-4 py-4" data-timeline-skeleton="true" aria-busy="true" aria-label="Loading messages">
      <div className="ms-auto h-10 w-2/3 rounded-2xl bg-muted" />
      <div className="h-4 w-5/6 rounded bg-muted" />
      <div className="h-4 w-3/4 rounded bg-muted" />
      <div className="h-4 w-1/2 rounded bg-muted" />
    </div>
  );
}

function TimelineHistoryControl(props: {
  hasMoreHistory: boolean;
  atStart: boolean;
  loading: boolean;
  error: string | null;
  onLoadEarlier: () => void;
}) {
  if (!props.hasMoreHistory) {
    return props.atStart ? (
      <div className="messages-timeline-row-frame px-3 pt-3 sm:px-4">
        <div className="chat-content-lane">
          <TimelineSystemDivider label="Start of thread" />
        </div>
      </div>
    ) : (
      <div className="h-3 sm:h-4" />
    );
  }
  return (
    <div className="messages-timeline-row-frame px-3 pt-2 sm:px-4">
      <div className="chat-content-lane flex flex-col items-center gap-1.5 pb-2">
        {props.error !== null ? (
          <div className="flex items-center gap-2 text-xs" data-history-retry="true">
            <span role="status" className="text-warning">
              {props.error}
            </span>
            <Button size="xs" variant="outline" onClick={props.onLoadEarlier}>
              <RotateCcwIcon className="size-3" />
              Retry
            </Button>
          </div>
        ) : (
          <button
            type="button"
            disabled={props.loading}
            aria-label="Load earlier messages"
            onClick={props.onLoadEarlier}
            className="w-full py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:cursor-default pointer-coarse:min-h-11"
          >
            {props.loading ? "Loading earlier messages…" : "Load earlier messages"}
          </button>
        )}
      </div>
    </div>
  );
}

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function getItemType(item: MessagesTimelineRow) {
  return item.kind === "message" ? `message:${item.message.role}` : item.kind;
}

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const isExpandedToolGroup = row.kind === "work" && row.isExpandedToolGroup;
  const isWorkLogRow =
    row.kind === "work" || row.kind === "work-live" || row.kind === "work-toggle" || row.kind === "thinking";
  const isExpandedToolGroupHeader =
    (row.kind === "work-toggle" || row.kind === "work-live" || row.kind === "thinking") && row.expanded === true;

  return (
    <div
      className={cn(
        isWorkLogRow
          ? undefined
          : row.kind === "turn-fold" || row.kind === "working"
            ? "pb-1.5"
            : (row.kind === "message" && row.message.role === "assistant" && !row.showAssistantMeta) ||
                row.kind === "event" ||
                row.kind === "day"
              ? "pb-2"
              : "pb-4",
        (row.kind === "message" && row.message.role === "assistant") || row.kind === "assistant-meta"
          ? "group/assistant"
          : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {isWorkLogRow ? (
        <WorkLogBlock
          continues={row.continuesWorkLog}
          layout={isExpandedToolGroup ? "group-content" : isExpandedToolGroupHeader ? "group-header" : "standalone"}
        >
          {row.kind === "work" ? (
            <WorkGroupSection
              groupedEntries={row.groupedEntries}
              isExpandedToolGroup={row.isExpandedToolGroup}
              displayLabel={row.displayLabel}
            />
          ) : null}
          {row.kind === "work-live" ? <LiveWorkEntryTimelineRow row={row} /> : null}
          {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
          {row.kind === "thinking" ? <ThinkingTimelineRow row={row} /> : null}
        </WorkLogBlock>
      ) : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role !== "user" ? <AssistantTimelineRow row={row} /> : null}
      {row.kind === "assistant-meta" ? <AssistantMetaTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "event" ? <EventTimelineRow row={row} /> : null}
      {row.kind === "day" ? <TimelineSystemDivider label={row.label} /> : null}
    </div>
  );
});

// ── Time ──────────────────────────────────────────────────────────────────────────────────────────

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatFull(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TimelineRowTimestamp({
  createdAt,
  className,
  alwaysVisible = false,
}: {
  createdAt: number;
  className?: string;
  alwaysVisible?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-thread-find-ignore=""
            className={cn(
              "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md font-mono text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
              alwaysVisible && "pointer-events-auto static opacity-100",
              className,
            )}
          />
        }
      >
        {formatClock(createdAt)}
      </TooltipTrigger>
      <TooltipPopup>{formatFull(createdAt)}</TooltipPopup>
    </Tooltip>
  );
}

function formatWorkingTimer(startMs: number, endMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  return formatDuration(elapsedSeconds * 1_000);
}

/** Ticks once a second without re-rendering the row (T3's WorkingTimer). */
export function WorkingTimer({ since, format = formatWorkingTimer }: { since: number; format?: (start: number, end: number) => string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const update = () => {
      if (textRef.current) textRef.current.textContent = format(since, Date.now());
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [since, format]);
  return (
    <span ref={textRef} className="font-mono tabular-nums">
      {format(since, Date.now())}
    </span>
  );
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────────

function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>;
}

const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;
  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          style={isCollapsed ? { WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK, maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK } : undefined}
        >
          <ChatMarkdown text={props.text} className="text-foreground" lineBreaks headingLevelOffset={MESSAGE_HEADING_LEVEL} />
        </div>
      ) : null}
      {canCollapse ? (
        <div className="mt-1.5 flex items-center justify-end gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="-ml-1"
          >
            {expanded ? "Show less" : "Show full message"}
          </Button>
        </div>
      ) : null}
    </div>
  );
});

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const attachments = row.message.attachments ?? [];
  const status = row.projectedItem?.status;
  return (
    <div className="group flex flex-col items-end gap-1">
      {row.message.inputIntent === "steer" ? (
        <p className="me-1 text-2xs text-muted-foreground">Steered the run</p>
      ) : null}
      <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
        <MessageAuthorHeading>You</MessageAuthorHeading>
        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <span
                key={attachment.path}
                title={attachment.path}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/60 px-1.5 py-0.5 text-xs"
              >
                <PaperclipIcon className="size-3 shrink-0" />
                <span className="truncate">{attachment.name}</span>
              </span>
            ))}
          </div>
        ) : null}
        <CollapsibleUserMessageBody text={row.message.text} />
      </div>
      {status && status !== "completed" && status !== "pending" && status !== "waiting" ? (
        <div className="me-1 flex items-center gap-1.5">
          <span className="rounded-full border border-destructive/25 bg-destructive/8 px-1.5 py-0.5 text-3xs font-medium text-destructive">
            {status}
          </span>
        </div>
      ) : null}
      <div data-thread-find-ignore="" className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<p className="font-mono text-muted-foreground text-xs tabular-nums" />}>
              {formatClock(row.message.createdAt)}
            </TooltipTrigger>
            <TooltipPopup>{formatFull(row.message.createdAt)}</TooltipPopup>
          </Tooltip>
          {row.message.text ? <MessageCopyButton text={row.message.text} variant="ghost" /> : null}
        </div>
      </div>
    </div>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  return (
    <div className="group/timeline-row relative flex items-center gap-1 border-b border-border/60 pb-2 pe-0.5 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        onClick={() => ctx.onToggleTurnFold(row.runId)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 pointer-coarse:min-h-11"
      >
        <span>{row.label}</span>
        {row.expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
      </button>
      <TimelineRowTimestamp createdAt={row.createdAt} className="ms-auto" />
    </div>
  );
}

function harnessLabel(harness: string): string {
  return descriptorFor(harness)?.label ?? (harness ? harness.charAt(0).toUpperCase() + harness.slice(1) : "Agent");
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
  return (
    <div className="relative min-w-0 px-1 py-0.5">
      <MessageAuthorHeading>{harnessLabel(ctx.harness)}</MessageAuthorHeading>
      {/* Sightr divergence from T3 (which keeps line breaks only for "★ Insight" blocks): every assistant
          message keeps its single newlines, as the harness's own terminal shows them. A list typed one
          item per line must not collapse into one line. */}
      <ChatMarkdown text={messageText} isStreaming={row.message.streaming} headingLevelOffset={MESSAGE_HEADING_LEVEL} lineBreaks />
      {row.projectedItem?.truncated ? (
        <p className="mt-1 text-2xs text-muted-foreground">The journal cut this message short.</p>
      ) : null}
      {row.showAssistantMeta ? (
        <AssistantMessageMeta
          className="mt-1.5"
          row={row}
          showCopyButton={row.showAssistantCopyButton}
          copyStreaming={row.assistantCopyStreaming}
        />
      ) : null}
    </div>
  );
}

function AssistantMetaTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "assistant-meta" }> }) {
  return (
    <div className="px-1">
      <AssistantMessageMeta
        className="mt-0.5"
        row={row}
        showCopyButton={row.showAssistantCopyButton}
        copyStreaming={row.assistantCopyStreaming}
        alwaysVisible
      />
    </div>
  );
}

function AssistantMessageMeta({
  className,
  row,
  showCopyButton,
  copyStreaming,
  alwaysVisible = false,
}: {
  className?: string;
  row: Extract<TimelineRow, { kind: "message" } | { kind: "assistant-meta" }>;
  showCopyButton: boolean;
  copyStreaming: boolean;
  alwaysVisible?: boolean;
}) {
  const copy = resolveAssistantMessageCopyState({ text: row.message.text ?? null, showCopyButton, streaming: copyStreaming });
  const status = row.projectedItem?.status;
  return (
    <div
      data-thread-find-ignore=""
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",
        alwaysVisible
          ? "opacity-100"
          : "opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
        className,
      )}
    >
      {status && status !== "completed" ? (
        <span className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">{status}</span>
      ) : null}
      {copy.visible ? <MessageCopyButton text={copy.text ?? ""} variant="ghost" /> : null}
      {!row.message.streaming ? (
        <Tooltip>
          <TooltipTrigger render={<p className="font-mono text-muted-foreground text-xs tabular-nums" />}>
            {formatClock(row.message.updatedAt)}
          </TooltipTrigger>
          <TooltipPopup>{formatFull(row.message.updatedAt)}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

function EventTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "event" }> }) {
  const ctx = use(TimelineRowCtx);
  const item = row.projectedItem;
  if (item.type === "session") {
    return (
      <TimelineSystemDivider
        label={item.from === null ? "Session" : "New session"}
        detail={`${harnessLabel(ctx.harness)} · ${formatClock(row.createdAt)}`}
      />
    );
  }
  if (item.type === "screen") {
    return <ScreenTimelineRow text={item.text} capturedAt={item.capturedAt} />;
  }
  if (item.type === "proposed_plan") {
    return <ProposedPlanCard planMarkdown={item.markdown} truncated={item.truncated === true} />;
  }
  if (isV2LifecycleItem(item)) return <V2LifecycleRow item={item} createdAt={row.createdAt} />;
  return null;
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { awaitingUser, queuedCount } = use(TimelineRowActivityCtx);
  return (
    <div className="border-b border-border/60 pb-2 pt-1" data-run-banner="true" data-thread-find-ignore="">
      <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span
          aria-hidden
          className={cn(
            "inline-block size-1.5 shrink-0 self-center rounded-full",
            awaitingUser ? "bg-you" : "bg-ok motion-safe:animate-status-pulse",
          )}
        />
        <span className="relative shrink-0 overflow-hidden whitespace-nowrap">
          {awaitingUser ? (
            "Waiting for you"
          ) : row.createdAt ? (
            <>
              Working for <WorkingTimer since={row.createdAt} />
            </>
          ) : (
            "Working…"
          )}
          {queuedCount > 0 ? <span> · {queuedCount} queued</span> : null}
        </span>
      </div>
    </div>
  );
}

function ThinkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "thinking" }> }) {
  const ctx = use(TimelineRowCtx);
  const { awaitingUser } = use(TimelineRowActivityCtx);
  if (awaitingUser) return <WorkLogRow label="" />;
  const activity = <LiveActivityRow label="Thinking" iconName="brain" active />;
  const { groupId } = row;
  if (groupId === undefined) return activity;
  return (
    <button
      type="button"
      className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 pointer-coarse:min-h-11"
      aria-expanded={row.expanded === true}
      onClick={() => ctx.onToggleWorkGroup(groupId)}
    >
      {activity}
    </button>
  );
}

function LiveActivityRow({
  label,
  iconName,
  failed = false,
  active = false,
}: {
  label: ReactNode;
  iconName?: WorkEntryIconName;
  failed?: boolean;
  active?: boolean;
}) {
  const showTrailingFailureMark = failed && iconName !== undefined;
  return (
    <div className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed">
      <WorkLogRow
        icon={
          iconName ? (
            <span
              className={cn(
                "flex size-4 items-center justify-center",
                failed ? failedToolIconClassName : "text-icon-muted",
                active && !failed && "motion-safe:animate-status-pulse",
              )}
              role={failed ? "img" : undefined}
              aria-label={failed ? "Tool call failed" : undefined}
            >
              <WorkEntryIcon name={iconName} className="block size-4 shrink-0 stroke-2" />
            </span>
          ) : null
        }
        label={<span className="block truncate">{label}</span>}
        trailing={showTrailingFailureMark ? <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} /> : null}
      />
    </div>
  );
}

function LiveWorkEntryTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "work-live" }> }) {
  const ctx = use(TimelineRowCtx);
  const isLiveThought = row.entry.itemType === "reasoning" && row.active;
  const label = liveWorkEntryLabel(row.entry, undefined, row.active);
  const runningCommand = liveWorkEntryIsRunningCommand(row.entry, row.active);
  const failed = workEntryDisplayIndicatesToolFailure(row.entry);
  const thoughtLine = row.thought && !row.expanded && !isLiveThought ? liveThoughtLine(row.thought.detail ?? "") : "";
  return (
    <button
      type="button"
      className={cn(
        "group/live-work flex w-full max-w-full cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        thoughtLine ? "flex-col items-start" : "min-h-6 items-center pointer-coarse:min-h-11",
      )}
      aria-label={failed ? `${label}, tool call failed` : undefined}
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId)}
    >
      {thoughtLine ? (
        <WorkLogRow
          icon={
            <span className="flex size-4 items-center justify-center text-icon-muted">
              <BrainIcon className="block size-4 shrink-0 stroke-2" />
            </span>
          }
          label={<span className="line-clamp-4">{thoughtLine}</span>}
          wrapLabel
        />
      ) : null}
      <LiveActivityRow
        label={
          isLiveThought ? (
            <>
              Thinking… <WorkingTimer since={row.entry.createdAt} format={formatThinkingTimer} />
            </>
          ) : runningCommand ? (
            // The command's start, then how long it has run; the time never truncates.
            <span className="flex min-w-0 items-baseline gap-1.5" data-running-command="">
              <span className="min-w-0 truncate">{label}</span>
              <span className="shrink-0 text-muted-foreground">
                <WorkingTimer since={row.entry.createdAt} />
              </span>
            </span>
          ) : (
            label
          )
        }
        iconName={workEntryIconName(row.entry)}
        failed={failed}
        active={row.active}
      />
    </button>
  );
}

function formatThinkingTimer(start: number, end: number): string {
  return formatThinkDuration(Math.max(0, end - start));
}

function toolGroupSummaryIconName(kind: Extract<TimelineRow, { kind: "work-toggle" }>["summaryKind"]): WorkEntryIconName {
  switch (kind) {
    case "read":
      return "eye";
    case "edit":
      return "square-pen";
    case "command":
      return "terminal";
    case "search":
    case "fetch":
      return "globe";
    case "code-search":
      return "search";
    case "other":
      return "wrench";
    case "dynamic-tool":
      return "hammer";
    case "reasoning":
      return "brain";
    case "agent-tool":
      return "bot";
    case "tone-tool":
      return "zap";
    case "update":
    case "mixed":
      return "hammer";
  }
}

function WorkGroupToggleTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "work-toggle" }> }) {
  const ctx = use(TimelineRowCtx);
  return (
    <WorkGroupHeader
      label={row.summary}
      iconName={toolGroupSummaryIconName(row.summaryKind)}
      failed={row.hasFailure}
      expanded={row.expanded}
      createdAt={row.createdAt}
      onToggle={() => ctx.onToggleWorkGroup(row.groupId)}
    />
  );
}

function WorkGroupHeader(props: {
  label: string;
  iconName: WorkEntryIconName;
  failed?: boolean | undefined;
  expanded: boolean;
  createdAt: number;
  onToggle: () => void;
}) {
  return (
    <WorkLogButton
      aria-label={props.failed ? `${props.label}, tool call failed` : props.label}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
      icon={
        <WorkEntryIcon
          name={props.iconName}
          className={cn("size-4 shrink-0 stroke-2", props.failed ? "text-warning" : "text-icon-muted")}
        />
      }
      label={<span className={cn("block truncate", props.failed && "text-warning")}>{props.label}</span>}
      trailing={
        <>
          <TimelineRowTimestamp createdAt={props.createdAt} />
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200 motion-reduce:transition-none", props.expanded && "rotate-90")}
          />
        </>
      }
    />
  );
}

const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
  isExpandedToolGroup,
  displayLabel,
}: {
  groupedEntries: WorkLogEntry[];
  isExpandedToolGroup: boolean;
  displayLabel?: string | undefined;
}) {
  const nonEmptyEntries = useMemo(
    () => groupedEntries.filter((entry) => workEntryIsVisibleInGroup(entry, isExpandedToolGroup)),
    [groupedEntries, isExpandedToolGroup],
  );
  if (nonEmptyEntries.length === 0) return null;
  if (isExpandedToolGroup) {
    return (
      <WorkLogList>
        <div
          role="region"
          aria-label="Tool calls"
          className="max-h-[min(24rem,60dvh)] overflow-y-auto overflow-x-hidden rounded-md"
          data-tool-group-scroll
        >
          {nonEmptyEntries.map((entry) => (
            <WorkEntryLogRow key={entry.id} workEntry={entry} />
          ))}
        </div>
      </WorkLogList>
    );
  }
  return (
    <section aria-label="Activity">
      {nonEmptyEntries.map((entry) => (
        <WorkEntryLogRow key={entry.id} workEntry={entry} displayLabel={displayLabel} />
      ))}
    </section>
  );
});

// ── Tool entry rows ───────────────────────────────────────────────────────────────────────────────

type WorkEntryIconName =
  | "bot"
  | "brain"
  | "check"
  | "circle-alert"
  | "eye"
  | "globe"
  | "hammer"
  | "list-todo"
  | "message-circle"
  | "search"
  | "square-pen"
  | "terminal"
  | "wrench"
  | "x"
  | "zap";

function WorkEntryIcon({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "brain":
      return <BrainIcon className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "list-todo":
      return <ListTodoIcon className={className} aria-hidden />;
    case "search":
      return <SearchIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

function workToneIcon(tone: WorkLogEntry["tone"]): { iconName: WorkEntryIconName; className: string } {
  if (tone === "error") return { iconName: "circle-alert", className: "text-foreground/92" };
  if (tone === "thinking") return { iconName: "brain", className: "text-icon-muted" };
  if (tone === "info") return { iconName: "check", className: "text-muted-foreground" };
  return { iconName: "zap", className: "text-foreground/92" };
}

function workEntryIconName(workEntry: WorkLogEntry): WorkEntryIconName {
  if (workEntry.itemType === "user_input_request" || workEntry.itemType === "approval_request") {
    return "message-circle";
  }
  if (workEntry.itemType === "todo_list") return "list-todo";
  const action = toolGroupAction(workEntry);
  if (action !== "other") return toolGroupSummaryIconName(action);
  if (workEntry.itemType === "dynamic_tool") return "wrench";
  return workToneIcon(workEntry.tone).iconName;
}

const failedToolIconClassName = "text-warning";

/** `docs/sub/notes.md` → `{ name: "notes.md", dir: "docs/sub" }` (either slash). */
export function splitFilePath(path: string): { name: string; dir: string } {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut < 0 ? { name: trimmed, dir: "" } : { name: trimmed.slice(cut + 1), dir: trimmed.slice(0, cut) };
}

/**
 * A file-change or read row whose label is a single path: its verb ("Read", or none) and the path, so
 * the row can lead with the file name. Null for every other row.
 */
export function workEntryRowPath(entry: WorkLogEntry, label: string): { verb: string | null; path: string } | null {
  const item = entry.projectedItem;
  if (item?.type === "file_change" && entry.changedFiles?.length === 1) {
    const path = item.fileName.trim();
    return path && label.replaceAll("\\", "/").endsWith(splitFilePath(path).name) ? { verb: null, path } : null;
  }
  if (item?.type === "dynamic_tool" && toolGroupAction(entry) === "read" && label.startsWith("Read ") && !/ \+\d+ more$/.test(label)) {
    const path = label.slice("Read ".length).trim();
    return path ? { verb: "Read", path } : null;
  }
  return null;
}

/**
 * Sightr phone pass: a path in a narrow row leads with the file name; the folder follows, dim and cut
 * from its start (T3's StartTruncatedPath), so the name is never the part that gets clipped.
 */
function FilePathLabel({ verb, path, className }: { verb: string | null; path: string; className?: string }) {
  const { name, dir } = splitFilePath(path);
  return (
    <span className={cn("flex min-w-0 items-baseline gap-1.5", className)} title={path} data-file-path-label="">
      {verb ? <span className="shrink-0">{verb}</span> : null}
      <span className="min-w-0 max-w-full shrink-0 truncate">{name || path}</span>
      {dir ? (
        <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground/70" dir="rtl">
          <bdi>{dir}</bdi>
        </span>
      ) : null}
    </span>
  );
}

/** "Usage limit reached." with T3's "Retry after <time>." when the failure carries `resetAt`. */
function usageLimitLabel(resetAt: number | null | undefined, now = Date.now()): string {
  if (!resetAt || !Number.isFinite(resetAt) || resetAt <= now) return "Usage limit reached.";
  const sameDay = new Date(resetAt).toDateString() === new Date(now).toDateString();
  return `Usage limit reached. Retry after ${sameDay ? formatClock(resetAt) : formatFull(resetAt)}.`;
}

function WorkEntryLogRow({ workEntry, displayLabel }: { workEntry: WorkLogEntry; displayLabel?: string | undefined }) {
  const { entryDisclosure } = use(TimelineRowCtx);
  const item = workEntry.projectedItem;
  const isReasoning = workEntry.itemType === "reasoning";
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const showFailedIndicator = !showWarningIndicator && workEntryDisplayIndicatesToolFailure(workEntry);
  const previewText = isReasoning
    ? reasoningLabel(workEntry.reasoningTime)
    : (displayLabel ?? workEntryDisplayLabel(workEntry, undefined));
  const canExpand = isReasoning
    ? Boolean(workEntry.detail?.trim())
    : item !== undefined && toolItemHasDetail(item, previewText);
  // A failed tool opens on its own (T11); the operator's toggle wins after that, also when the list
  // unmounts the row off-screen and mounts it again.
  const [expanded, setExpanded] = useState(() => entryDisclosure.get(workEntry.id) ?? (showFailedIndicator && canExpand));

  if (item?.type === "error" && item.status === "failed") {
    const warning = item.failure.class === "usage_limit";
    return (
      <WorkLogRow
        data-item-type="error"
        wrapLabel
        icon={<CircleAlertIcon className="size-4 text-warning" />}
        label={<span className="text-sm font-medium text-warning">{warning ? usageLimitLabel(item.failure.resetAt) : workEntry.label}</span>}
        trailing={<TimelineRowTimestamp createdAt={workEntry.createdAt} alwaysVisible />}
      >
        {!warning ? (
          <p className="ms-7 whitespace-pre-wrap break-words py-1 text-sm leading-relaxed text-foreground/80">
            {item.failure.message}
          </p>
        ) : null}
      </WorkLogRow>
    );
  }

  const showDestructiveRowStyle =
    !showWarningIndicator && showFailedIndicator && (workEntrySignalsSevereFailure(workEntry) || !workLogEntryIsToolLike(workEntry));
  const iconConfig = workToneIcon(workEntry.tone);
  const entryIconName = showWarningIndicator || showDestructiveRowStyle ? "circle-alert" : workEntryIconName(workEntry);
  const iconWrapperClass = cn(
    "flex size-4 items-center justify-center",
    showWarningIndicator || showDestructiveRowStyle || showFailedIndicator
      ? "text-warning"
      : workEntry.tone === "tool"
        ? "text-icon-muted"
        : iconConfig.className,
  );
  const headingClass = showWarningIndicator || showDestructiveRowStyle
    ? "font-medium text-warning"
    : workLogEntryIsToolLike(workEntry)
      ? showFailedIndicator
        ? "text-warning"
        : "text-secondary-label"
      : "text-foreground/80";
  const thoughtPreview = isReasoning && !expanded ? liveThoughtLine(workEntry.detail ?? "") : "";
  const rowPath = isReasoning ? null : workEntryRowPath(workEntry, previewText);
  const accessibleText = showFailedIndicator ? `${previewText}, tool call failed` : previewText;
  const toggle = () => {
    entryDisclosure.set(workEntry.id, !expanded);
    setExpanded(!expanded);
  };
  const thoughtStreaming = item?.type === "reasoning" && item.streaming;
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": accessibleText,
        "aria-expanded": expanded,
        onClick: toggle,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        },
      }
    : {};

  return (
    <WorkLogRow
      data-item-type={workEntry.itemType}
      data-tool-failed={showFailedIndicator ? "true" : undefined}
      {...rowToggleProps}
      icon={
        <span className={iconWrapperClass} role={showFailedIndicator ? "img" : undefined} aria-label={showFailedIndicator ? "Tool call failed" : undefined}>
          <WorkEntryIcon name={entryIconName} className="block size-4 shrink-0 stroke-2" />
        </span>
      }
      label={
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed">
            {rowPath ? (
              <FilePathLabel verb={rowPath.verb} path={rowPath.path} className={cn("flex-1", headingClass)} />
            ) : (
              <span className={cn("min-w-0 truncate", !thoughtPreview && "flex-1", headingClass, workEntry.command && !isReasoning && "font-mono text-xs")}>
                {previewText}
              </span>
            )}
            {thoughtPreview ? <span className="min-w-0 flex-1 truncate text-muted-foreground">{thoughtPreview}</span> : null}
          </p>
        </div>
      }
      trailing={
        <>
          {item?.type === "file_change" && (item.additions !== undefined || item.deletions !== undefined) ? (
            <DiffStatLabel additions={item.additions ?? 0} deletions={item.deletions ?? 0} layout="inline" className="shrink-0 text-xs" />
          ) : null}
          {showFailedIndicator && !showDestructiveRowStyle ? (
            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
          ) : null}
          <TimelineRowTimestamp createdAt={workEntry.createdAt} />
          <span className={cn("flex size-4 shrink-0 items-center justify-center", !canExpand && "invisible")} aria-hidden>
            <ChevronRightIcon
              className={cn("size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200 motion-reduce:transition-none", expanded && "rotate-90")}
            />
          </span>
        </>
      }
    >
      {expanded && isReasoning ? (
        // T3's ReasoningTraceContent: a thought still being written keeps its newest text in view.
        <WorkLogDetails followLive={thoughtStreaming}>
          <ChatMarkdown
            className="text-foreground"
            text={workEntry.detail ?? ""}
            isStreaming={thoughtStreaming}
            headingLevelOffset={MESSAGE_HEADING_LEVEL}
            lineBreaks
          />
        </WorkLogDetails>
      ) : null}
      {expanded && !isReasoning && item ? (
        <WorkLogDetails kind="panel">
          <div className="ms-7">
            <ToolItemDetail item={item} />
          </div>
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  );
}
