import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

import { useLayout } from "@/hooks/useLayout";
import { useThreadStream } from "@/hooks/useThreadStream";
import { useShell, useThread, useThreadStore } from "@/stream/stores";

export const Route = createFileRoute("/_chat/thread/$threadId")({
  component: ThreadRouteView,
});

function ThreadRouteView() {
  const { threadId } = Route.useParams();
  useThreadStream(threadId);
  const desktop = useLayout() === "desktop";
  const shellThread = useShell((s) => s.threads[threadId]);
  const state = useThread(threadId);
  const missing = useThreadStore((s) => s.missing === threadId);
  const title = state?.thread?.title ?? shellThread?.title ?? "Thread";

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
        // T11 (timeline) and T12 (composer) fill this region.
        <div data-region="timeline" className="min-h-0 flex-1 overflow-y-auto" />
      )}
    </section>
  );
}
