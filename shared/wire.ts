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
export type FolderGitResponse =
  | { available: false; reason: "outside-root" | "not-a-repo" | "git-unavailable" | "timeout" }
  | { available: true; repo: string; rel: string; branch?: string; detached?: boolean; noCommits?: boolean; clean: boolean; entries: FolderGitEntry[]; hidden: number; statusTruncated: boolean; diff: string; diffTruncated: boolean; panes: string[] };

export type TranscriptPart =
  | { kind: "text"; text: string; truncated?: boolean }
  | { kind: "thinking"; text: string; truncated?: boolean }
  | { kind: "tool"; name: string; summary: string; result?: { text: string; truncated?: boolean; isError?: boolean } };
export interface TranscriptEntry { uuid: string; ts: string; role: "user" | "assistant" | "summary" | "note"; parts: TranscriptPart[]; }

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
export interface BridgeSettings { deviceAllowlist: string[]; notifyDelayMs: number; submitKeys: string[]; readLines: number; }
export type SaveFileResponse = { ok: true; mtimeMs: number; size: number } | { ok: false; error: string };

export const STATUS_RANK: Record<AgentStatus, number> = { blocked: 0, working: 1, unknown: 2, idle: 3, done: 4 };
