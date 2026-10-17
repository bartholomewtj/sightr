import { createFileRoute } from "@tanstack/react-router";
import { CommandIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { ChatComposer } from "~/components/chat/ChatComposer";
import { MessagesTimeline } from "~/components/chat/MessagesTimeline";
import { TimelineFind } from "~/components/chat/ThreadFindBar";
import { openThreadFind } from "~/components/chat/useThreadFind";
import { openCommandPalette } from "@/commandPaletteBus";
import { RenderErrorBoundary } from "@/components/RenderErrorBoundary";
import { ErrorFallback } from "@/components/shell/ErrorFallback";
import { BackToThreads } from "@/components/shell/BackToThreads";
import { useShortcutHandler } from "@/shortcutHandlers";
import { Button } from "~/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { RightPanelSheet } from "@/components/RightPanelSheet";
import { RIGHT_PANEL_ICON, RightPanelSurface } from "@/components/RightPanelTabs";
import { TerminalPanel } from "@/components/right-panel/TerminalPanel";
import { useLayout } from "@/hooks/useLayout";
import { useThreadStream } from "@/hooks/useThreadStream";
import { canUnarchive } from "@/lib/archived";
import { noteOpenThread } from "@/state/draft-thread";
import { performThreadCommand, useSidebarThread } from "@/state/sidebar";
import { RIGHT_PANEL_KINDS, RIGHT_PANEL_LABEL, useRightPanelStore } from "@/rightPanelStore";
import { useThread, useThreadStore } from "@/stream/stores";
import { useThreadView, useThreadViewStore, type ThreadView } from "@/threadViewStore";

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
  const shellThread = useSidebarThread(threadId);
  const state = useThread(threadId);
  const missing = useThreadStore((s) => s.missing === threadId);
  const title = shellThread?.title ?? state?.thread?.title ?? "Thread";
  const synchronized = state !== null && !state.syncing;
  useMarkReadOnOpen(threadId, synchronized, shellThread?.unreadDone ?? state?.thread?.unreadDone);
  const archived = (shellThread ?? state?.thread)?.shelf === "archived";
  const archiveReason = (shellThread ?? state?.thread)?.archiveReason;
  // A thread with no transcript opens on its terminal (the CLI); the toggle flips it to the timeline.
  const { view, cliFirst } = useThreadView(threadId);
  const cli = view === "cli";
  // T19: mod+f (`chat.find`, not while the terminal has the keys) opens find over the timeline. The CLI
  // has its own find (the mirror takes mod+f while focused).
  useShortcutHandler("chat.find", () => {
    if (missing || cli) return false;
    openThreadFind(threadId);
  });

  return (
    <section aria-label={title} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        {!desktop && <BackToThreads />}
        <h1 className="min-w-0 flex-1 truncate font-semibold">{title}</h1>
        {state?.syncing && !cli && <span className="text-xs text-muted-foreground">Syncing…</span>}
        {cliFirst && !missing ? <ThreadViewToggle threadId={threadId} view={view} /> : null}
        {!missing && !cli ? (
          <Button size="icon-sm" variant="ghost-muted" aria-label="Find in thread" onClick={() => openThreadFind(threadId)}>
            <SearchIcon />
          </Button>
        ) : null}
        {/* Phone: the palette is the way to New thread, Settings and this thread's actions (rename, snooze, pin ...). */}
        {!desktop ? (
          <Button size="icon-sm" variant="ghost-muted" aria-label="Command palette" onClick={() => openCommandPalette()}>
            <CommandIcon />
          </Button>
        ) : null}
        {!desktop && !missing ? <PhonePanelButtons cli={cli} /> : null}
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
            <div data-region="timeline" className="relative min-h-0 flex-1">
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

/**
 * Phone: Terminal, Files and Git open as one full-height sheet at a time (T13). With the CLI as the main
 * view the Terminal button would only repeat it, so it goes.
 */
function PhonePanelButtons({ cli }: { cli: boolean }) {
  const sheet = useRightPanelStore((s) => s.sheet);
  const openSheet = useRightPanelStore((s) => s.openSheet);
  const kinds = cli ? RIGHT_PANEL_KINDS.filter((kind) => kind !== "terminal") : RIGHT_PANEL_KINDS;
  return (
    <div className="-mr-1 flex items-center" role="group" aria-label="Thread tools">
      {kinds.map((kind) => {
        const Icon = RIGHT_PANEL_ICON[kind];
        return (
          <Button key={kind} size="icon-sm" variant="ghost-muted" aria-label={RIGHT_PANEL_LABEL[kind]} aria-pressed={sheet === kind} onClick={() => openSheet(kind)}>
            <Icon />
          </Button>
        );
      })}
    </div>
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
