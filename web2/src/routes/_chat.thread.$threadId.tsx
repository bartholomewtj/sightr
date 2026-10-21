import { createFileRoute } from "@tanstack/react-router";
import { CommandIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { ChatComposer } from "~/components/chat/ChatComposer";
import { ChatHeader } from "~/components/chat/ChatHeader";
import { ThreadSubagentsButton } from "~/components/chat/ThreadSubagentsButton";
import { MessagesTimeline } from "~/components/chat/MessagesTimeline";
import { TimelineFind } from "~/components/chat/ThreadFindBar";
import { openThreadFind } from "~/components/chat/useThreadFind";
import { openCommandPalette } from "@/commandPaletteBus";
import { RenderErrorBoundary } from "@/components/RenderErrorBoundary";
import { ErrorFallback } from "@/components/shell/ErrorFallback";
import { BackToThreads } from "@/components/shell/BackToThreads";
import { SidebarToggle } from "@/components/shell/SidebarToggle";
import { PanelToolbar } from "@/components/shell/PanelToolbar";
import type { ThreadMenuAction } from "@/components/sidebar/ThreadRowMenu";
import { useShortcutHandler } from "@/shortcutHandlers";
import { Button } from "~/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { RightPanelSheet } from "@/components/RightPanelSheet";
import { RightPanelSurface } from "@/components/RightPanelTabs";
import { TerminalPanel } from "@/components/right-panel/TerminalPanel";
import { useLayout } from "@/hooks/useLayout";
import { useThreadStream } from "@/hooks/useThreadStream";
import { canUnarchive } from "@/lib/archived";
import { noteOpenThread } from "@/state/draft-thread";
import { performThreadCommand, useSidebarThread } from "@/state/sidebar";
import { RIGHT_PANEL_LABEL, useRightPanelStore } from "@/rightPanelStore";
import { useBridgeInfo, useThread, useThreadStore } from "@/stream/stores";
import { useThreadView, useThreadViewStore, type ThreadView } from "@/threadViewStore";
import { useUiState } from "@/uiStateStore";

export const Route = createFileRoute("/_chat/thread/$threadId")({
  component: ThreadRoute,
});

/** One bad item must not blank the app: a render error shows the thread fallback; another thread resets it. */
function ThreadRoute() {
  const { threadId } = Route.useParams();
  return (
    <RenderErrorBoundary resetKeys={[threadId]} fallback={<ErrorFallback title="Something went wrong in this thread" />}>
      <ThreadRouteView />
    </RenderErrorBoundary>
  );
}

/**
 * Opening a thread marks it read (T10), once per visit and only after the thread stream says
 * `synchronized`, so a thread that finished while the stream was catching up is not cleared unseen.
 */
function useMarkReadOnOpen(threadId: string, synchronized: boolean, unreadDone: boolean | undefined): void {
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!synchronized || unreadDone === undefined || sent.current === threadId) return;
    sent.current = threadId;
    if (unreadDone) void performThreadCommand({ type: "thread.markRead", threadId });
  }, [threadId, synchronized, unreadDone]);
}

function ThreadRouteView() {
  const { threadId } = Route.useParams();
  useThreadStream(threadId);
  // T14: the new-thread draft offers a split next to the thread that was open.
  useEffect(() => noteOpenThread(threadId), [threadId]);
  const desktop = useLayout() === "desktop";
  const sidebarOpen = useUiState((s) => s.sidebarOpen);
  const shellThread = useSidebarThread(threadId);
  const state = useThread(threadId);
  const missing = useThreadStore((s) => s.missing === threadId);
  const title = shellThread?.title ?? state?.thread?.title ?? "Thread";
  const synchronized = state !== null && !state.syncing;
  useMarkReadOnOpen(threadId, synchronized, shellThread?.unreadDone ?? state?.thread?.unreadDone);
  const archived = (shellThread ?? state?.thread)?.shelf === "archived";
  const archiveReason = (shellThread ?? state?.thread)?.archiveReason;
  const readOnly = useBridgeInfo((s) => s.readOnly);
  // A thread with no transcript opens on its terminal (the CLI); the toggle flips it to the timeline.
  const { view, cliFirst } = useThreadView(threadId);
  const cli = view === "cli";
  // Phone: the palette is the way to New thread and Settings, so it is always in the title's menu.
  const phoneHeaderActions = useMemo<ThreadMenuAction[]>(
    () => [
      ...(!missing && !cli
        ? [{ id: "find", label: "Find in thread", icon: SearchIcon, onSelect: () => openThreadFind(threadId) }]
        : []),
      { id: "palette", label: "Command palette", icon: CommandIcon, onSelect: () => openCommandPalette() },
    ],
    [missing, cli, threadId],
  );
  // T19: mod+f (`chat.find`, not while the terminal has the keys) opens find over the timeline. The CLI
  // has its own find (the mirror takes mod+f while focused).
  useShortcutHandler("chat.find", () => {
    if (missing || cli) return false;
    openThreadFind(threadId);
  });

  return (
    <section aria-label={title} className="flex min-h-0 flex-1 flex-col">
      <header className="relative flex items-center gap-2 border-b px-3 py-2">
        {!desktop ? <BackToThreads /> : !sidebarOpen ? <SidebarToggle /> : null}
        {/* The title opens this thread's menu (rename, pin, snooze, settle, archive, mark unread). On a
            phone Find and the Command palette lead that menu instead of taking header buttons: at 360 px
            back, title, find, palette and three panel buttons left the title ~10 characters. */}
        <ChatHeader
          title={title}
          thread={shellThread ?? state?.thread ?? null}
          canOperate={!missing && !readOnly}
          leadingActions={desktop ? undefined : phoneHeaderActions}
        />
        {cliFirst && !missing ? <ThreadViewToggle threadId={threadId} view={view} /> : null}
        {desktop && !missing && !cli ? (
          <Button size="icon-sm" variant="ghost-muted" aria-label="Find in thread" onClick={() => openThreadFind(threadId)}>
            <SearchIcon />
          </Button>
        ) : null}
        {!missing ? <ThreadSubagentsButton threadId={threadId} /> : null}
        {!missing ? <PanelToolbar cli={cli} /> : null}
        {/* Syncing is a thin line on the header's bottom edge, not a word in the title row: at 360 px a
            word there squeezed the title to a few letters. */}
        {state?.syncing && !cli ? (
          <span
            role="status"
            data-syncing=""
            className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 animate-pulse bg-primary/60"
          >
            <span className="sr-only">Syncing…</span>
          </span>
        ) : null}
      </header>
      {!desktop ? <PhonePanelSheet threadId={threadId} /> : null}
      {missing ? (
        <p className="p-4 text-sm text-muted-foreground">This thread no longer exists on the bridge.</p>
      ) : (
        <>
          {cli ? (
            <div data-region="cli" className="flex min-h-0 flex-1 flex-col">
              <TerminalPanel threadId={threadId} />
            </div>
          ) : (
            <div data-region="timeline" className="relative min-h-0 flex-1 overflow-hidden">
              <MessagesTimeline threadId={threadId} />
              <TimelineFind threadId={threadId} />
            </div>
          )}
          {archived ? (
            // Read-only: the composer (T12) is replaced.
            <div data-region="composer" className="flex items-center gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
              <span className="flex-1">
                {canUnarchive(archiveReason) ? "This thread is archived." : "This thread's pane was closed."}
              </span>
              {canUnarchive(archiveReason) ? (
                <Button size="sm" variant="outline" onClick={() => void performThreadCommand({ type: "thread.unarchive", threadId })}>
                  Unarchive
                </Button>
              ) : null}
            </div>
          ) : (
            <ChatComposer key={threadId} threadId={threadId} />
          )}
        </>
      )}
    </section>
  );
}

/** Thread or CLI as the main view, for a thread with no transcript. */
function ThreadViewToggle({ threadId, view }: { threadId: string; view: ThreadView }) {
  const setView = useThreadViewStore((s) => s.setView);
  return (
    <ToggleGroup
      aria-label="Main view"
      value={[view]}
      onValueChange={(next: unknown[]) => {
        const picked = next[0];
        if (picked === "thread" || picked === "cli") setView(threadId, picked);
      }}
    >
      <ToggleGroupItem value="cli">CLI</ToggleGroupItem>
      <ToggleGroupItem value="thread">Thread</ToggleGroupItem>
    </ToggleGroup>
  );
}

function PhonePanelSheet({ threadId }: { threadId: string }) {
  const sheet = useRightPanelStore((s) => s.sheet);
  const closeSheet = useRightPanelStore((s) => s.closeSheet);
  // Leaving the thread closes its sheet.
  useEffect(() => () => useRightPanelStore.getState().closeSheet(), [threadId]);
  return (
    <RightPanelSheet open={sheet !== null} title={sheet ? RIGHT_PANEL_LABEL[sheet] : ""} onClose={closeSheet}>
      {sheet ? <RightPanelSurface key={`${sheet}:${threadId}`} kind={sheet} threadId={threadId} /> : null}
    </RightPanelSheet>
  );
}
