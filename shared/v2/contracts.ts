/**
 * Sightr v2 contracts: the domain, the commands and the events the bridge and `web2/` share.
 *
 * Turn-item and thread shapes mirror T3 Code's OrchestrationV2 contracts (upstream commit e3b35d1b)
 * so T3 UI components can be adapted; keep names aligned when T3 changes.
 *
 * Differences from T3 that are on purpose:
 * - Times are epoch milliseconds (numbers), as everywhere else in Sightr. T3 sends ISO date strings.
 * - A thread is a herdr pane, not an app-owned conversation, so the provider/model/worktree/lineage
 *   fields of T3's `OrchestrationV2AppThread` have no counterpart here.
 * - Only the turn-item kinds a terminal harness can produce are listed. `session` and `screen` are
 *   Sightr extensions (marked below).
 *
 * Types only, plus tiny pure helpers. No Node or Bun API and no import from outside `shared/`, so the
 * browser and the bridge both load it, and the root typecheck passes before `web2/` is installed.
 */

// ── Status and shelves ───────────────────────────────────────────────────────────────────────────

/** Worst first. `starting` is T07's status for a pane it is spawning; it never outranks a real one. */
export type ThreadStatus = "approval" | "input" | "failed" | "working" | "done" | "idle" | "starting";

export const THREAD_STATUS_RANK: Record<ThreadStatus, number> = {
  approval: 0,
  input: 1,
  failed: 2,
  working: 3,
  done: 4,
  idle: 5,
  starting: 6,
};

/** The worst status in `list` (lowest rank). An empty list rolls up to `idle`. */
export function worstStatus(list: Iterable<ThreadStatus>): ThreadStatus {
  let worst: ThreadStatus = "idle";
  let seen = false;
  for (const status of list) {
    if (!seen || THREAD_STATUS_RANK[status] < THREAD_STATUS_RANK[worst]) worst = status;
    seen = true;
  }
  return worst;
}

export type Shelf = "active" | "pinned" | "snoozed" | "settled" | "archived";

/** Why a thread left the live list. `user` is the `thread.archive` command. */
export type ArchiveReason = "pane-closed" | "terminal-replaced" | "closed-while-down" | "spawn-failed" | "user";

// ── Capabilities ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a thread's harness can do. The UI reads these flags, never the harness name.
 * There is no steer flag: steer needs `canInterrupt && canQueueDrain`.
 */
export interface ThreadCapabilities {
  hasJournal: boolean;
  canQueueDrain: boolean;
  canInterrupt: boolean;
  interruptKeys?: string[];
  canSwitchPermissionMode: boolean;
  permissionModes?: string[];
  canSwitchModel: boolean;
  /** The slash command that switches the model, e.g. `/model`. */
  modelCommand?: string;
  canSetEffortLive: boolean;
  effortCommand?: string;
  resumeBySession: boolean;
  launchModes: boolean;
}

export const NO_CAPABILITIES: ThreadCapabilities = {
  hasJournal: false,
  canQueueDrain: false,
  canInterrupt: false,
  canSwitchPermissionMode: false,
  canSwitchModel: false,
  canSetEffortLive: false,
  resumeBySession: false,
  launchModes: false,
};

// ── Domain ───────────────────────────────────────────────────────────────────────────────────────

/** A herdr workspace. */
export interface Project {
  /** The herdr workspace id. */
  id: string;
  label: string;
  /** `user` after `project.rename`; the herd ingest then leaves the label alone. */
  labelSource: "herd" | "user";
  number: number;
  worktreeOf?: string;
  order: number;
  /** Roll-up of its active and pinned threads (`worstStatus`). */
  status: ThreadStatus;
  /** Set when the workspace closed while archived threads still point at it. */
  closedAt?: number;
}

/** A session ref as clients see it. A path ref stays on the bridge. */
export interface WireSessionRef {
  kind: "id";
  value: string;
}

/**
 * A herdr pane (`paneId`, `terminalId`). Shelf and time fields use T3's `OrchestrationV2AppThread`
 * names (`snoozedUntil`, `pinnedAt`, `settledAt`, `archivedAt`, `updatedAt`); `shelf` and `pinOrder`
 * are Sightr's (T3 derives the shelf and orders pins by a fractional string key).
 */
export interface Thread {
  id: string;
  paneId: string;
  /** Empty while T07 is spawning the pane and herdr has not reported a terminal yet. */
  terminalId: string;
  projectId: string;
  title: string;
  titleSource: "herd" | "user";
  harness: string;
  status: ThreadStatus;
  shelf: Shelf;
  snoozedUntil?: number;
  pinnedAt?: number;
  pinOrder?: number;
  settledAt?: number;
  unreadDone: boolean;
  lastActivityAt: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  archiveReason?: ArchiveReason;
  sessionRef?: WireSessionRef;
  capabilities: ThreadCapabilities;
  /** Last confirmed value (T08). */
  permissionMode?: string;
  model?: string;
}

/** T3's `OrchestrationV2RunStatus`, cut to the four a status-watched pane can produce. */
export type RunStatus = "running" | "completed" | "interrupted" | "failed";

/** One user message to the agent's return to rest. T3 field names (`completedAt`, not `endedAt`). */
export interface Run {
  id: string;
  threadId: string;
  ordinal: number;
  /** The `user_message` turn item that opened the run, once T03 has matched one. */
  userItemId?: string;
  status: RunStatus;
  startedAt: number;
  completedAt?: number;
}

// ── Turn items (mirror of T3's OrchestrationV2TurnItem) ─────────────────────────────────────────

/** T3's `OrchestrationV2TurnItemStatus`. Tool items use it for running / completed / failed. */
export type TurnItemStatus =
  | "idle"
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** T3's `OrchestrationV2UserMessageInputIntent`. */
export type UserMessageInputIntent = "turn_start" | "queued_turn" | "steer" | "promoted_queued_to_steer";

/**
 * T3's `ChatAttachment`, loosened: Sightr's attachments are files uploaded to the bridge and named by
 * the path the agent reads (T12), so `path` is required and the size/mime fields are optional.
 */
export interface ChatAttachment {
  type?: "image" | "file";
  id?: string;
  name: string;
  path: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** T3's `OrchestrationV2FileSearchResult`. */
export interface FileSearchResult {
  fileName: string;
  line?: number;
  column?: number;
  preview?: string;
}

/** T3's `OrchestrationV2WebSearchResult`. */
export interface WebSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
}

/** T3's `ProviderRequestKind`. */
export type ProviderRequestKind = "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission";
/** T3's `ProviderApprovalDecision`. */
export type ProviderApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";

/** T3's `ProviderApprovalOption`; `decision` is optional because a terminal menu row may not map to one. */
export interface ApprovalOption {
  label: string;
  decision?: ProviderApprovalDecision;
  warning?: string;
}

/** T3's `OrchestrationV2UserInputQuestion`; option `description` is optional (terminal menus often have none). */
export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description?: string; value?: string }[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
  initialAnswer?: string;
  required?: boolean;
}

/** T3's `OrchestrationV2ProviderFailureClass`. */
export type ProviderFailureClass =
  | "usage_limit"
  | "provider_error"
  | "transport_error"
  | "permission_error"
  | "validation_error"
  | "unknown";

/** T3's `OrchestrationV2ProviderFailure` (`resetAt` is epoch ms here). */
export interface ProviderFailure {
  class: ProviderFailureClass;
  message: string;
  code: string | null;
  retryable: boolean | null;
  resetAt?: number | null;
}

/** T3's `OrchestrationV2ProviderRetry`. */
export interface ProviderRetry {
  attempt: number;
  maxAttempts: number | null;
  retryDelayMs: number | null;
}

/**
 * T3's `OrchestrationV2TurnItemBaseFields`, minus the provider/node bookkeeping a pane has no use for.
 * `ordinal` is the item's position in the thread; the store assigns it to a new item.
 */
export interface TurnItemBase {
  id: string;
  threadId: string;
  runId: string | null;
  ordinal: number;
  status: TurnItemStatus;
  title: string | null;
  startedAt: number | null;
  completedAt: number | null;
  /** Sightr: when the entry was written (the journal timestamp). */
  createdAt: number;
  updatedAt: number;
  /** Sightr: the journal adapter cut this item's text. */
  truncated?: boolean;
}

export type TurnItem =
  | (TurnItemBase & {
      type: "user_message";
      messageId: string;
      text: string;
      attachments: ChatAttachment[];
      inputIntent?: UserMessageInputIntent;
    })
  | (TurnItemBase & {
      type: "assistant_message";
      messageId: string;
      text: string;
      attachments?: ChatAttachment[];
      streaming: boolean;
    })
  | (TurnItemBase & { type: "reasoning"; text: string; streaming: boolean })
  | (TurnItemBase & {
      type: "command_execution";
      input: string;
      output?: string;
      outputOmitted?: boolean;
      outputIndicatesFailure?: boolean;
      exitCode?: number;
    })
  | (TurnItemBase & {
      type: "file_change";
      fileName: string;
      additions?: number;
      deletions?: number;
      diffStr?: string;
      oldStr?: string;
      newStr?: string;
    })
  | (TurnItemBase & { type: "file_search"; pattern?: string; results?: FileSearchResult[] })
  | (TurnItemBase & { type: "web_search"; patterns?: string[]; results?: WebSearchResult[] })
  | (TurnItemBase & {
      type: "dynamic_tool";
      toolName: string | null;
      input: unknown;
      output?: unknown;
      outputOmitted?: boolean;
    })
  | (TurnItemBase & {
      type: "approval_request";
      requestId: string;
      requestKind: ProviderRequestKind | RuntimeRequestKind;
      prompt?: string;
      options?: ApprovalOption[];
    })
  | (TurnItemBase & { type: "user_input_request"; requestId: string; questions: UserInputQuestion[] })
  | (TurnItemBase & { type: "system_notice"; message: string })
  | (TurnItemBase & { type: "error"; failure: ProviderFailure; retry?: ProviderRetry })
  // ── Sightr extensions (no T3 counterpart) ──
  /** Sightr: the harness session inside the pane changed (relaunch, `/clear`, `/new`). */
  | (TurnItemBase & { type: "session"; from: string | null; to: string })
  /** Sightr: a captured screen tail, for harnesses with no journal. */
  | (TurnItemBase & { type: "screen"; text: string; capturedAt: number });

export type TurnItemType = TurnItem["type"];

// ── Runtime requests and the queue ───────────────────────────────────────────────────────────────

export type RuntimeRequestKind = "permission" | "question" | "menu" | "trust" | "password";

export interface RuntimeRequestOption {
  label: string;
  keys: string[];
  destructive?: boolean;
  /** T17. */
  description?: string;
}

/** A dialog on the pane's screen, bound to the text it was read from (`bindingHash`). */
export interface RuntimeRequest {
  id: string;
  threadId: string;
  kind: RuntimeRequestKind;
  prompt: string;
  options: RuntimeRequestOption[];
  status: "pending" | "resolved" | "expired";
  bindingHash: string;
  createdAt: number;
  updatedAt: number;
  /** The run that was open when the dialog appeared; its `approval_request` / `user_input_request` item belongs to it. */
  runId?: string;
  /** The chosen option, once resolved from Sightr (T04, T17). */
  optionIndex?: number;
  optionIndices?: number[];
  /** T04: a whistlr-marked operator decision. */
  via?: "whistlr";
  decision?: { thread: string; run: string };
  /** T17: wizard steps, preview text, multi-select and answers. Shapes owned by T17. */
  steps?: { prompt: string; options: RuntimeRequestOption[] }[];
  preview?: string;
  multiSelect?: boolean;
  answers?: string[];
}

/** What the shell snapshot carries per request: no options. */
export type RuntimeRequestSummary = Omit<RuntimeRequest, "options" | "steps">;

export type QueuedMessageState = "queued" | "sending" | "held";

export interface QueuedMessage {
  id: string;
  threadId: string;
  text: string;
  attachments: ChatAttachment[];
  position: number;
  mode: "queue" | "steer";
  state: QueuedMessageState;
  heldReason?: string;
  createdAt: number;
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

interface CommandBase {
  /** Client-made, unique per intent. Makes the command idempotent (a receipt row). */
  commandId: string;
}

export type DispatchMode = "start" | "queue" | "steer";

export type Command =
  | (CommandBase & {
      type: "thread.create";
      projectId?: string;
      newProject?: { cwd: string; label?: string };
      harness: string;
      model?: string;
      permissionMode?: string;
      effort?: string;
      placement: "tab" | "split";
      splitFrom?: string;
      direction?: "right" | "down";
      name?: string;
      confirmBypass?: boolean;
    })
  | (CommandBase & { type: "thread.rename"; threadId: string; title: string })
  | (CommandBase & { type: "thread.pin"; threadId: string })
  | (CommandBase & { type: "thread.unpin"; threadId: string })
  | (CommandBase & { type: "thread.snooze"; threadId: string; until: number })
  | (CommandBase & { type: "thread.settle"; threadId: string })
  | (CommandBase & { type: "thread.unsettle"; threadId: string })
  | (CommandBase & { type: "thread.archive"; threadId: string })
  | (CommandBase & { type: "thread.unarchive"; threadId: string })
  | (CommandBase & { type: "thread.markRead"; threadId: string })
  | (CommandBase & { type: "thread.markUnread"; threadId: string })
  | (CommandBase & {
      type: "message.dispatch";
      threadId: string;
      text: string;
      attachments?: ChatAttachment[];
      mode: DispatchMode;
    })
  | (CommandBase & { type: "queued.reorder"; threadId: string; ids: string[] })
  | (CommandBase & { type: "queued.edit"; id: string; text: string })
  | (CommandBase & { type: "queued.cancel"; id: string })
  | (CommandBase & { type: "queue.resume"; threadId: string })
  | (CommandBase & { type: "run.interrupt"; threadId: string })
  | (CommandBase & {
      type: "runtime-request.respond";
      requestId: string;
      optionIndex?: number;
      optionIndices?: number[];
    })
  | (CommandBase & { type: "thread.permissionMode.set"; threadId: string; mode: string; confirmBypass?: boolean })
  | (CommandBase & { type: "thread.model.set"; threadId: string; model: string })
  | (CommandBase & { type: "project.create"; cwd: string; label?: string })
  | (CommandBase & { type: "project.rename"; projectId: string; label: string });

export type CommandType = Command["type"];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;

/** Every command name, in one list (an exhaustiveness check pins it to the union). */
export const COMMAND_TYPES = [
  "thread.create",
  "thread.rename",
  "thread.pin",
  "thread.unpin",
  "thread.snooze",
  "thread.settle",
  "thread.unsettle",
  "thread.archive",
  "thread.unarchive",
  "thread.markRead",
  "thread.markUnread",
  "message.dispatch",
  "queued.reorder",
  "queued.edit",
  "queued.cancel",
  "queue.resume",
  "run.interrupt",
  "runtime-request.respond",
  "thread.permissionMode.set",
  "thread.model.set",
  "project.create",
  "project.rename",
] as const satisfies readonly CommandType[];

// ── Events ───────────────────────────────────────────────────────────────────────────────────────

/** The thread fields a `thread.updated` patch may carry. */
export type ThreadPatch = Partial<
  Pick<
    Thread,
    | "title"
    | "titleSource"
    | "harness"
    | "status"
    | "unreadDone"
    | "lastActivityAt"
    | "capabilities"
    | "terminalId"
    | "permissionMode"
    | "model"
  >
> & {
  /** `null` clears it. */
  sessionRef?: WireSessionRef | null;
};

export type QueueChange = "added" | "sent" | "held" | "resumed" | "reordered" | "edited" | "cancelled";

/** One payload per event type, as clients receive it. */
export interface EventPayloads {
  "project.upserted": { project: Project };
  "project.closed": { projectId: string; closedAt: number };
  "thread.created": { thread: Thread };
  "thread.updated": { patch: ThreadPatch; at: number };
  "thread.shelf-changed": { shelf: Exclude<Shelf, "archived">; snoozedUntil?: number; pinOrder?: number; at: number };
  "thread.archived": { reason: ArchiveReason; at: number };
  "run.started": { run: Run };
  "run.ended": { runId: string; status: Exclude<RunStatus, "running">; completedAt: number };
  /** The whole run after a change that is not its end (T03 sets `userItemId` once the message is read). T3's name. */
  "run.updated": { run: Run };
  /** Upsert by `item.id`. A new item gets the next `ordinal` when it comes without one. */
  "turn-item.updated": { item: TurnItem };
  "runtime-request.updated": { request: RuntimeRequest };
  /** The thread's whole queue after the change. */
  "queue.updated": { messages: QueuedMessage[]; change?: QueueChange; reason?: string };
  "command.rejected": { reason: string; code?: string; shown?: string };
  /**
   * A dispatched message was not sent (T06). `reason`: `blocked` | `stalled` | `error` (the send
   * guard's outcome), `pane-gone`, `busy`, `interrupt-failed` or `interrupt-timeout`; `message` is the
   * guard's own words for the operator. `queuedId`: the queue row it concerns, which is kept (held)
   * unless `textDelivered` (the text is in the box, unsubmitted; the row is gone).
   */
  "dispatch.failed": { reason: string; message?: string; textDelivered?: boolean; queuedId?: string };
  "thread.create.failed": { threadId: string; stage: "pane" | "prompt" | "agent"; message: string };
}

export type ThreadEventType = keyof EventPayloads;

/** Every event name, in one list (an exhaustiveness check pins it to the union). */
export const THREAD_EVENT_TYPES = [
  "project.upserted",
  "project.closed",
  "thread.created",
  "thread.updated",
  "thread.shelf-changed",
  "thread.archived",
  "run.started",
  "run.ended",
  "run.updated",
  "turn-item.updated",
  "runtime-request.updated",
  "queue.updated",
  "command.rejected",
  "dispatch.failed",
  "thread.create.failed",
] as const satisfies readonly ThreadEventType[];

export type ThreadEventOf<T extends ThreadEventType> = {
  /** Global and strictly increasing; gaps are allowed. */
  sequence: number;
  threadId?: string;
  commandId?: string;
  type: T;
  payload: EventPayloads[T];
  ts: number;
};

export type ThreadEvent = { [K in ThreadEventType]: ThreadEventOf<K> }[ThreadEventType];

// ── The v2 API envelopes (T05) ───────────────────────────────────────────────────────────────────
//
// What `bridge/threads/v2-routes.ts` sends and `web2/src/stream/*` reads. Every stream frame is an SSE
// message: `id: <sequence>` (except heartbeats), `event: <name>`, `data: <json>`.

export const V2_SHELL_PATH = "/api/v2/shell";
export const V2_COMMAND_PATH = "/api/v2/command";
export const v2ThreadPath = (threadId: string): string => `/api/v2/thread/${encodeURIComponent(threadId)}`;
export const v2HistoryPath = (threadId: string): string => `${v2ThreadPath(threadId)}/history`;

/** A resume longer than this many events gets a snapshot instead of a replay. */
export const V2_REPLAY_LIMIT = 128;

/**
 * The events the shell stream carries: what the sidebar shows (projects, threads, request summaries)
 * plus the notices a client may toast anywhere. Runs, turn items and queues go to thread streams only.
 */
export const SHELL_EVENT_TYPES = [
  "project.upserted",
  "project.closed",
  "thread.created",
  "thread.updated",
  "thread.shelf-changed",
  "thread.archived",
  "runtime-request.updated",
  "command.rejected",
  "dispatch.failed",
  "thread.create.failed",
] as const satisfies readonly ThreadEventType[];

/** `event: snapshot` on the shell stream. `requests` are the pending ones, without options. */
export interface ShellSnapshot {
  sequence: number;
  projects: Project[];
  threads: Thread[];
  requests: RuntimeRequestSummary[];
}

/** `event: snapshot` on a thread stream (the cursor was too old, too far behind, or absent). */
export interface ThreadSnapshot {
  sequence: number;
  thread: Thread;
  /** The last 10 runs, oldest first. */
  runs: Run[];
  /** Every item from the first item of those runs on (loose items in that range too), by ordinal. */
  items: TurnItem[];
  /** Pending requests, with options. */
  requests: RuntimeRequest[];
  queue: QueuedMessage[];
  /** The `before` cursor for `GET /api/v2/thread/:id/history`; null when nothing is older. */
  historyCursor: string | null;
}

/** `event: synchronized` (the catch-up is over) and `event: ping` (heartbeat). */
export interface SequenceFrame {
  sequence: number;
}

/** The frame names a v2 stream sends. `event` carries one `ThreadEvent`; `build` the UI build id; `reset` precedes a close. */
export type V2StreamFrame = "snapshot" | "event" | "synchronized" | "ping" | "build" | "reset";

/** `POST /api/v2/command` success: the intent committed (not that the work finished). */
export interface CommandReply {
  ok: true;
  sequence: number;
}

/**
 * Every code a `/api/v2/*` refusal carries. `herdr-too-old`, `v2-disabled` and `v2-starting` come on a
 * 503 from any v2 route; the rest from the command endpoint (`not_found` also from the thread routes).
 */
export type V2ErrorCode =
  | "herdr-too-old"
  | "v2-disabled"
  | "v2-starting"
  | "not_found"
  | "invalid"
  | "conflict"
  | "prompt-changed"
  | "unsupported"
  | "busy"
  | "failed";

/** Any `/api/v2/*` refusal. `have`/`need` come with `herdr-too-old`. Clients must tolerate unknown codes. */
export interface V2ErrorBody {
  ok: false;
  code: string;
  error?: string;
  have?: string;
  need?: string;
}

/** `GET /api/v2/thread/:id/history?before=&limit=`: older runs, oldest first. */
export interface HistoryPage {
  runs: { run: Run; items: TurnItem[] }[];
  /** Items with no run in the page's ordinal range. */
  loose: TurnItem[];
  nextCursor: string | null;
}

/** The codes that make v2 unusable on this host until something changes there (full-screen state). */
export const BLOCKING_CODES = ["herdr-too-old", "v2-disabled"] as const;
export type BlockingCode = (typeof BLOCKING_CODES)[number];

export function isBlockingCode(code: unknown): code is BlockingCode {
  return typeof code === "string" && (BLOCKING_CODES as readonly string[]).includes(code);
}

export function isV2ErrorBody(value: unknown): value is V2ErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string"
  );
}
