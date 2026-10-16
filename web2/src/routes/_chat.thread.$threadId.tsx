import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useEffect, useRef } from "react";

import { ChatComposer } from "~/components/chat/ChatComposer";
import { MessagesTimeline } from "~/components/chat/MessagesTimeline";
import { Button } from "~/components/ui/button";
import { useLayout } from "@/hooks/useLayout";
import { useThreadStream } from "@/hooks/useThreadStream";
import { canUnarchive } from "@/lib/archived";
import { performThreadCommand, useSidebarThread } from "@/state/sidebar";
import { useThread, useThreadStore } from "@/stream/stores";

export const Route = createFileRoute("/_chat/thread/$threadId")({
  component: ThreadRouteView,
});

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
  const desktop = useLayout() === "desktop";
  const shellThread = useSidebarThread(threadId);
  const state = useThread(threadId);
  const missing = useThreadStore((s) => s.missing === threadId);
  const title = shellThread?.title ?? state?.thread?.title ?? "Thread";
  const synchronized = state !== null && !state.syncing;
  useMarkReadOnOpen(threadId, synchronized, shellThread?.unreadDone ?? state?.thread?.unreadDone);
  const archived = (shellThread ?? state?.thread)?.shelf === "archived";
  const archiveReason = (shellThread ?? state?.thread)?.archiveReason;

  return (
    <section aria-label={title} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        {!desktop && (
          <Link to="/" aria-label="Back to threads" className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent">
            <ChevronLeft className="size-5" />
          </Link>
        )}
        <h1 className="min-w-0 flex-1 truncate font-semibold">{title}</h1>
        {state?.syncing && <span className="text-xs text-muted-foreground">Syncing…</span>}
      </header>
      {missing ? (
        <p className="p-4 text-sm text-muted-foreground">This thread no longer exists on the bridge.</p>
      ) : (
        <>
          <div data-region="timeline" className="relative min-h-0 flex-1">
            <MessagesTimeline threadId={threadId} />
          </div>
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
