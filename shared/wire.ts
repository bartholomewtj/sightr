/** The HTTP contract shared by the Bun bridge and the browser client. */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Fields common to the bridge's internal pane view and the browser's wire view. */
export interface PaneCommon {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  workspaceNumber: number;
  tabId: string;
  agent: string;
  status: AgentStatus;
  cwd: string;
  focused: boolean;
  kind?: "agent" | "shell";
  paneLabel?: string;
  /** Herdr live agent name (`agent.start` / `agent.rename`), from snapshot `agents[]`. */
  agentName?: string;
  sessionName?: string;
  /** Display-only summary token (or metadata title) from snapshot `agents[]`. */
  summary?: string;
  readableLines?: number;
  tabLabel?: string;
  terminalTitle?: string;
  runningCommand?: boolean;
  lastActiveAt?: number;
  lastSeenAt?: number;
  /**
   * The bridge read this pane's screen and found a dialog waiting on the operator, so it publishes
   * `blocked` over Herdr's resting status (Cursor CLI and Antigravity only; see
   * bridge/state-engine.ts, sniffDialogs). Absent otherwise.
   */
  dialogDetected?: boolean;
}

/** A pane sent to the browser. `hasSession` is only a capability flag, never a session ref. */
export interface WirePane extends PaneCommon {
  /** This is a FLAG indicating history may exist; the session reference remains server-side. */
  hasSession?: boolean;
}

/** Git checkout provenance on a workspace (Herdr `workspace.worktree`). */
export interface WorkspaceWorktree {
  repoKey: string;
  repoName: string;
  repoRoot: string;
  checkoutPath: string;
  isLinkedWorktree: boolean;
  branch?: string | null;
}
/** A linked checkout that is not currently a Herdr workspace. */
export interface ClosedWorktree {
  path: string;
  label: string;
  branch: string | null;
  isDetached: boolean;
}
export interface WorkspaceView {
  workspaceId: string; number: number; label: string; focused: boolean; activeTabId: string;
  tabCount: number; paneCount: number;
  worktree?: WorkspaceWorktree;
  closedWorktrees?: ClosedWorktree[];
}
export interface TabView { tabId: string; workspaceId: string; number: number; label: string; focused: boolean; paneCount: number; }
export type BridgeStatus = "connected" | "disconnected";
export interface DeviceAuth { enforced: boolean; device: string | null; authorized: boolean; }
export interface FileEntry { name: string; kind: "dir" | "file"; size?: number; mtimeMs: number; repo?: boolean; }
export interface FileSearchResult { path: string; name: string; kind: "dir" | "file"; }
export type FilesResponse =
  | { kind: "dir"; path: string; entries: FileEntry[]; truncated: boolean }
  | { kind: "file"; path: string; name: string; size: number; mtimeMs: number; binary: boolean; text?: string; truncated?: boolean; openInBrowser?: boolean; embed?: "image" | "video" | "audio" };
export interface FileSearchResponse { q: string; results: FileSearchResult[]; truncated: boolean; }
export interface FolderGitEntry { path: string; x: string; y: string; }
/** Where a pane's working folder sits in the Files root: `""` is the root; null when it is outside it, or Files is off. */
export interface PaneFolderResponse { path: string | null; }
export type FolderGitUnavailable = "outside-root" | "not-a-repo" | "git-unavailable" | "timeout";
/** One recent commit on HEAD. Counts skip files the Files refusal list hides. `ahead`: not on `base` yet. */
export interface FolderGitCommit { sha: string; short: string; subject: string; author: string; time: number; parents: number; files: number; added: number; removed: number; ahead?: boolean; }
/** Per-file line counts (`binary` files count no lines). */
export interface FolderGitFileStat { path: string; added: number; removed: number; binary?: boolean; }
export type FolderGitResponse =
  | { available: false; reason: FolderGitUnavailable }
  | {
      available: true; repo: string; rel: string; branch?: string; detached?: boolean; noCommits?: boolean; clean: boolean; entries: FolderGitEntry[]; hidden: number; statusTruncated: boolean; diff: string; diffTruncated: boolean; panes: string[];
      /** The repo's root as a Files rel path (`""` is the Files root), so a changed file can be opened in Files. */
      rootPath?: string;
      /** The branch's upstream (`origin/main`), from `git status`. */
      upstream?: string;
      /** What the branch range compares with: the upstream, else origin's default branch, main or master. */
      base?: string;
      ahead?: number; behind?: number;
      /** The last commits on HEAD, newest first. */
      commits?: FolderGitCommit[];
    };
/** `/api/files/git/diff`: one commit (`scope=commit&sha=`) or the branch range `base...HEAD` (`scope=branch`), read-only. */
export type FolderGitDiffResponse =
  | { available: false; reason: FolderGitUnavailable | "no-base" | "bad-commit" }
  | { available: true; scope: "commit" | "branch"; commit?: FolderGitCommit; base?: string; files: FolderGitFileStat[]; hidden: number; filesTruncated: boolean; diff: string; diffTruncated: boolean };
/** `/api/files/resolve`: an absolute or pane-relative path as a Files rel path, or why not. */
export type FileResolveResponse =
  | { path: string; kind: "file" | "dir" }
  | { path: null; reason: "outside-root" | "hidden" | "not-found" | "no-folder" | "bad-path" };

/** One option of a pending Grok `ask_user_question`. Caps live in the journal parser. */
export interface TranscriptAskOption {
  label: string;
  description?: string;
}
/** One question of a pending Grok `ask_user_question`. `multi` is the tool's `multi_select` flag. */
export interface TranscriptAskQuestion {
  question: string;
  multi: boolean;
  options: TranscriptAskOption[];
}
/**
 * The full question card, kept only while the tool has no result yet. The screen paints a couple of
 * rows; this is how the phone shows the rest. Dropped once the tool_result lands.
 */
export interface TranscriptAsk {
  id: string;
  questions: TranscriptAskQuestion[];
}

/**
 * A provider failure the harness logged (Claude `isApiErrorMessage`, Pi `stopReason: "error"`), in
 * the shape of T3's `OrchestrationV2ProviderFailure`. `resetAt` is epoch ms.
 */
export interface TranscriptError {
  class: "usage_limit" | "provider_error" | "transport_error" | "permission_error" | "validation_error" | "unknown";
  message: string;
  code: string | null;
  retryable: boolean | null;
  resetAt?: number | null;
}

/** One step of a harness task list (Claude TodoWrite, Pi `todo`). */
export interface TranscriptTodoStep {
  id: string;
  text: string;
  status: "pending" | "running" | "completed";
}

/**
 * The structured payload a tool call keeps beside its one-line summary (journal/structured.ts caps
 * it). Every field is optional data the harness wrote; an old bridge's entries simply have none.
 */
export type TranscriptToolDetail =
  | {
      kind: "diff";
      fileName: string;
      /** A unified diff (`---`/`+++`/`@@` hunks). */
      diff?: string;
      additions?: number;
      deletions?: number;
      oldStr?: string;
      newStr?: string;
      truncated?: boolean;
    }
  | { kind: "todo"; steps: TranscriptTodoStep[]; truncated?: boolean }
  | { kind: "plan"; markdown: string; truncated?: boolean }
  | {
      kind: "subagent";
      agentId?: string;
      title?: string;
      prompt?: string;
      status?: string;
      model?: string;
      durationMs?: number;
      tokens?: string;
      toolUses?: number;
      truncated?: boolean;
    };

/** Token use an assistant entry reported (T3's `ThreadTokenUsageSnapshot` subset). */
export interface TranscriptUsage {
  /** What the context holds after this message: input (cached or not) plus output. */
  usedTokens: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  maxTokens?: number;
  cost?: number;
}

/**
 * An image the harness logged (a pasted image, a Read of a PNG, a screenshot), kept as a REFERENCE to
 * the log row that holds its bytes, never as the bytes (journal/images.ts). The v2 attachment route
 * reads it back from the log on demand.
 */
export interface TranscriptImage {
  mimeType: string;
  /** Decoded size, from the base64 length. */
  sizeBytes: number;
  /** A short label for alt text and the viewer (`shot.png`, "Pasted image 1"). */
  name: string;
  /** Byte offset of the row's line in the log. Absent when the parse was not given one (v1 history). */
  at?: number;
  /** The row's own id (Claude `uuid`, pi `id`), checked when the bytes are read back. */
  row: string;
  /** Which image of the row, 0-based, in `rowImages` order. */
  n: number;
}

export type TranscriptPart =
  | {
      kind: "text";
      text: string;
      truncated?: boolean;
      /** Images that came with this text (a user's pasted image). */
      images?: TranscriptImage[];
      /** The text is a provider failure the harness logged, not speech. */
      error?: TranscriptError;
      /** The text is a lifecycle marker: the operator interrupted the run. */
      notice?: "interrupted";
    }
  | { kind: "thinking"; text: string; truncated?: boolean }
  | {
      kind: "tool";
      name: string;
      summary: string;
      result?: { text: string; truncated?: boolean; isError?: boolean; exitCode?: number };
      /** The harness never records tool output (Cursor): the call is complete, with no body to open. */
      unrecorded?: true;
      /** Pending Grok `ask_user_question` arguments. Absent once the call has a result. */
      ask?: TranscriptAsk;
      /** The call's own arguments, capped (journal/structured.ts). */
      input?: unknown;
      inputTruncated?: boolean;
      /** Structured data from the call or its result (a diff, a task list, a plan, a subagent). */
      detail?: TranscriptToolDetail;
      /** Images in the call's result (a Read of an image, a screenshot). */
      images?: TranscriptImage[];
    };
export interface TranscriptEntry {
  uuid: string;
  ts: string;
  role: "user" | "assistant" | "summary" | "note";
  parts: TranscriptPart[];
  /** Token use, on the assistant entries that report it. */
  usage?: TranscriptUsage;
}

export interface SnapshotResponse {
  bridge: BridgeStatus; device?: DeviceAuth; agents: WirePane[]; shellPanes: WirePane[];
  workspaces: WorkspaceView[]; tabs: TabView[];
  files?: boolean; ts: number;
}
export interface PaneReadResponse { paneId: string; text: string; truncated: boolean; revision: number; }
export type PaneHistoryResponse =
  | { paneId: string; available: false; reason: "disabled" | "no-session" | "no-log" }
  | { paneId: string; available: true; entries: TranscriptEntry[]; hasMore: boolean; total: number; fileTruncated: boolean };
export type ActionResponse = { ok: true } | { ok: false; error: string; textDelivered?: boolean; code?: string };
export interface DecisionOption { keyLabel?: string; keys?: string[]; label: string; }
export interface DecisionReplyRequest {
  option: DecisionOption;
  decision?: { thread: string; run: string };
  cardText?: string;
  text?: string;
  signature?: string;
  question?: string;
  notes?: string;
}
export type UploadResponse = { ok: true; path: string } | { ok: false; error: string };
export interface CreatedPane { paneId: string; workspaceId: string; workspaceLabel: string; tabId: string; cwd: string; }
export type CreateResponse = { ok: true; pane: CreatedPane } | { ok: false; error: string };
export interface OperatorCommand { agent?: string; command: string; description: string; takesArg: boolean; argHint: string; confirm?: boolean; }
export interface OperatorKeyRow { agent?: string; label: string; keys: string[]; danger?: boolean; }
/** One gesture-wheel slice from the operator's keys.toml. Either `keys` or `action`, never both. */
export interface OperatorWheelRow { label: string; keys?: string[]; action?: "type"; }
export interface BridgeConfig { push: boolean; vapidPublicKey: string; build?: string; operatorCommands?: OperatorCommand[]; operatorKeys?: OperatorKeyRow[]; operatorWheel?: OperatorWheelRow[]; }
export interface LockCredential { id: string; name: string; addedAt: number; }
export interface LockStatus { enabled: boolean; corrupt?: boolean; unlocked: boolean; webauthn?: boolean; credentials?: LockCredential[]; allowCredentials?: string[]; }
export interface NotifyPrefs { blocked: boolean; done: boolean; }
export interface BridgeSettings {
  deviceAllowlist: string[]; notifyDelayMs: number; submitKeys: string[]; readLines: number;
  /** v2: settle an active thread idle this many days (0 = off). Absent from an older bridge. */
  autoSettleDays?: number;
}
export type BridgeSettingKey = keyof BridgeSettings;
/** GET/POST /api/settings: effective values, which ones Settings overrides, and the `.env` values
 *  beneath. `overridden`/`defaults` are optional so an older bridge still parses. */
export interface BridgeSettingsView extends BridgeSettings { overridden?: BridgeSettingKey[]; defaults?: BridgeSettings; }
export type SaveFileResponse = { ok: true; mtimeMs: number; size: number } | { ok: false; error: string };

export const STATUS_RANK: Record<AgentStatus, number> = { blocked: 0, working: 1, unknown: 2, idle: 3, done: 4 };
