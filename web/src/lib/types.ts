// Public browser types. The HTTP shapes live in shared/ so bridge and web cannot drift.
export type {
  AgentStatus, PaneSssfRun, WorkspaceView, WorkspaceWorktree, ClosedWorktree, TabView, BridgeStatus,
  DeviceAuth, FileEntry, FilesResponse,
  FileSearchResponse, FolderGitResponse, SnapshotResponse, PaneHistoryResponse,
  TranscriptPart, TranscriptEntry, ActionResponse, UploadResponse, CreateResponse,
  OperatorCommand, OperatorKeyRow, OperatorWheelRow, BridgeConfig, LockStatus, NotifyPrefs, BridgeSettings,
  SaveFileResponse,
} from "@shared/wire";
export { STATUS_RANK } from "@shared/wire";

import type { WirePane, DeviceAuth, PaneReadResponse as SharedPaneReadResponse } from "@shared/wire";

/** A pane as the browser sees it: the wire pane plus what the browser itself derived. */
export type AgentView = WirePane & {
  /** A parsed ask card (prompt-select / wizard / preview-select / multi-select / menu) was on this
   *  pane's screen at Sightr's last read, and Herdr's status hasn't moved since. Browser-derived
   *  (lib/dialog-presence.ts). Never sent by the bridge. */
  dialogPresent?: boolean;
};
export type PaneReadResponse = SharedPaneReadResponse & { notModified?: boolean };

export function paneDisplayName(pane: WirePane): string {
  if (pane.paneLabel) return pane.paneLabel;
  if (pane.agentName) return pane.agentName;
  if (pane.sessionName) return pane.sessionName;
  if (pane.summary) return pane.summary;
  if (pane.terminalTitle) return pane.terminalTitle;
  return pane.kind === "shell" ? "shell" : pane.agent;
}

export function isReadOnly(device: DeviceAuth | undefined): boolean {
  return !!device && device.enforced && !device.authorized;
}

export const STATUS_LABEL: Record<import("@shared/wire").AgentStatus, string> = {
  blocked: "needs you", working: "working", idle: "idle", done: "done", unknown: "unknown",
};
