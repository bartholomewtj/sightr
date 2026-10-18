// Pattern from T3 Code apps/web/src/components/chat/ThreadDetailsPanel.tsx @ db5919d87 (MIT, see THIRD_PARTY.md).
// The same job, thread details at a glance, with Sightr's content and a phone path:
// - T3's panel shows workspace, environment, open-in, scripts, branch and git actions, automations and
//   related threads. A herdr thread has none of those; this shows what the thread record and journal
//   know: harness, model, permission mode, the thread's folder (as a Files path; the bridge never
//   hands the client an absolute cwd, ADR 0026), session id (with Copy), runs, created and last active.
// - T3 floats a card beside the lane (ThreadDetailsCard); here it is a sheet: from the bottom on a
//   phone (the back gesture closes it first, as RightPanelSheet), from the right on a desktop.
// - Opened with `openThreadDetails(threadId)` (palette, header menu); the timeline mounts the sheet.
// - Sections are T3's ThreadDetailsSection (verbatim).
import { FolderOpenIcon, XIcon } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";

import { descriptorFor } from "@shared/agents";
import type { Thread } from "@shared/v2/contracts";

import { useLayout } from "@/hooks/useLayout";
import { useRightPanelStore } from "@/rightPanelStore";
import { useSidebarThread } from "@/state/sidebar";
import { useShell, useThread } from "@/stream/stores";

import { useSheetHistory } from "../RightPanelSheet";
import { usePaneFolder } from "../right-panel/usePaneFolder";
import { Button } from "../ui/button";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { MessageCopyButton } from "./MessageCopyButton";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

// ── Open state ──────────────────────────────────────────────────────────────────────────────────

let openFor: string | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Open the details sheet for `threadId` (shown while that thread's timeline is mounted). */
export function openThreadDetails(threadId: string): void {
  openFor = threadId;
  emit();
}

export function closeThreadDetails(): void {
  if (openFor === null) return;
  openFor = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the details sheet is open for `threadId`. */
export function useThreadDetailsOpen(threadId: string): boolean {
  return useSyncExternalStore(subscribe, () => openFor === threadId, () => false);
}

// ── Content ─────────────────────────────────────────────────────────────────────────────────────

function formatWhen(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function DetailRow({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-9 min-w-0 items-center gap-2 px-1.5 py-1 pointer-coarse:min-h-11" data-thread-detail={label}>
      <dt className="w-28 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm wrap-anywhere text-foreground/90">{children}</dd>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

export function ThreadDetailsContent({ threadId }: { threadId: string }) {
  const state = useThread(threadId);
  const shellThread = useSidebarThread(threadId);
  const thread: Thread | undefined = state?.thread ?? shellThread;
  const project = useShell((s) => (thread ? s.projects[thread.projectId] : undefined));
  const folder = usePaneFolder(thread?.paneId || null);
  if (!thread) return <p className="px-4 py-6 text-sm text-muted-foreground">This thread isn't loaded.</p>;
  const runs = state ? Object.values(state.runs) : [];
  const descriptor = descriptorFor(thread.harness);
  const harness = descriptor?.label ?? thread.harness;
  const modeId = thread.permissionMode?.trim();
  // The launch table's label for the mode (as the composer's chip shows it), else the raw id.
  const mode = modeId ? (descriptor?.launch?.modes?.find((m) => m.id === modeId)?.label ?? modeId) : null;
  const sessionId = thread.sessionRef?.value ?? null;
  const folderPath = folder.path;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]" data-thread-details="">
      <ThreadDetailsSection headingId={`thread-details-agent-${threadId}`} title="Agent" separated={false}>
        <dl>
          <DetailRow label="Harness">{harness}</DetailRow>
          <DetailRow label="Model">{thread.model?.trim() || muted("Harness default")}</DetailRow>
          <DetailRow label="Permission mode">{mode ?? muted("Not reported")}</DetailRow>
          <DetailRow label="Status">{thread.status}</DetailRow>
        </dl>
      </ThreadDetailsSection>
      <ThreadDetailsSection headingId={`thread-details-place-${threadId}`} title="Where">
        <dl>
          {project ? <DetailRow label="Project">{project.label}</DetailRow> : null}
          <DetailRow
            label="Folder"
            action={
              folderPath ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Open the folder in Files"
                  onClick={() => {
                    closeThreadDetails();
                    useRightPanelStore.getState().openFile(threadId, folderPath, "dir");
                  }}
                >
                  <FolderOpenIcon />
                </Button>
              ) : null
            }
          >
            {folderPath === undefined ? (
              muted("Loading…")
            ) : folderPath !== null ? (
              <span className="font-mono text-xs">{folderPath === "" ? "/" : folderPath}</span>
            ) : folder.filesOff ? (
              muted("Files is off on the host")
            ) : (
              muted("Outside the Files root")
            )}
          </DetailRow>
        </dl>
      </ThreadDetailsSection>
      <ThreadDetailsSection headingId={`thread-details-session-${threadId}`} title="Session">
        <dl>
          <DetailRow
            label="Session id"
            action={sessionId ? <MessageCopyButton text={sessionId} label="Copy session id" size="icon-xs" variant="ghost" /> : null}
          >
            {sessionId ? <span className="font-mono text-xs">{sessionId}</span> : muted("Not reported yet")}
          </DetailRow>
          <DetailRow label="Runs">{state ? `${runs.length}${state.historyCursor !== null ? "+ (older not loaded)" : ""}` : muted("—")}</DetailRow>
          <DetailRow label="Created">{formatWhen(thread.createdAt) ?? muted("—")}</DetailRow>
          <DetailRow label="Last active">{formatWhen(thread.lastActivityAt) ?? muted("—")}</DetailRow>
        </dl>
      </ThreadDetailsSection>
    </div>
  );
}

/** The thread details sheet for `threadId`; mounted by the thread's timeline. */
export function ThreadDetailsSheet({ threadId }: { threadId: string }) {
  const open = useThreadDetailsOpen(threadId);
  const layout = useLayout();
  useSheetHistory(open, closeThreadDetails);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) closeThreadDetails();
      }}
    >
      <SheetPopup
        side={layout === "desktop" ? "right" : "bottom"}
        showCloseButton={false}
        className={layout === "desktop" ? undefined : "max-h-[85dvh] rounded-t-2xl"}
        data-thread-details-sheet=""
      >
        <div className="flex items-center gap-1 border-b px-3 py-1">
          <SheetTitle className="min-w-0 flex-1 truncate text-sm font-medium">Thread details</SheetTitle>
          <Button size="icon-sm" variant="ghost" aria-label="Close thread details" onClick={closeThreadDetails}>
            <XIcon />
          </Button>
        </div>
        {open ? <ThreadDetailsContent threadId={threadId} /> : null}
      </SheetPopup>
    </Sheet>
  );
}
