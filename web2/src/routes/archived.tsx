import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import type { ArchiveReason } from "@shared/v2/contracts";
import { timeAgo } from "@v1/lib/format";

import { Button } from "~/components/ui/button";
import { AgentIcon } from "@/components/AgentIcon";
import { ARCHIVED_PAGE, archivedThreads, canUnarchive } from "@/lib/archived";
import { performThreadCommand, useSidebarThreads } from "@/state/sidebar";
import { useShell } from "@/stream/stores";

export const Route = createFileRoute("/archived")({
  component: Archived,
});

const REASON: Record<ArchiveReason, string> = {
  user: "Archived",
  "pane-closed": "Pane closed",
  "terminal-replaced": "Terminal replaced",
  "closed-while-down": "Closed while the bridge was down",
  "spawn-failed": "Spawn failed",
};

// T10: the archived list. Read-only threads; Unarchive only while the pane still exists. Paged
// client-side, 50 at a time.
function Archived() {
  const threads = useSidebarThreads();
  const projects = useShell((s) => s.projects);
  const list = useMemo(() => archivedThreads(Object.values(threads)), [threads]);
  const [shown, setShown] = useState(ARCHIVED_PAGE);
  const page = list.slice(0, shown);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3 overflow-y-auto p-4">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        Back to threads
      </Link>
      <h1 className="text-xl font-semibold">Archived</h1>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No archived threads.</p>
      ) : (
        <ul aria-label="Archived threads" className="divide-y rounded-lg border">
          {page.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-2">
              <AgentIcon agent={t.harness} className="size-5" />
              <Link to="/thread/$threadId" params={{ threadId: t.id }} className="min-w-0 flex-1 hover:underline">
                <span className="block truncate text-sm">{t.title}</span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {[projects[t.projectId]?.label, t.archiveReason ? REASON[t.archiveReason] : null, t.archivedAt ? timeAgo(t.archivedAt) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </Link>
              {canUnarchive(t.archiveReason) ? (
                <Button size="xs" variant="outline" onClick={() => void performThreadCommand({ type: "thread.unarchive", threadId: t.id })}>
                  Unarchive
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {list.length > shown ? (
        <Button variant="ghost" onClick={() => setShown((n) => n + ARCHIVED_PAGE)}>
          Show more ({list.length - shown})
        </Button>
      ) : null}
    </div>
  );
}
