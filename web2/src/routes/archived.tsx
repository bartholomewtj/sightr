import { createFileRoute, Link } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { SearchIcon, Trash2Icon } from "lucide-react";

import type { ArchiveReason, Thread } from "@shared/v2/contracts";
import { timeAgo } from "@v1/lib/format";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { BackToThreads } from "@/components/shell/BackToThreads";
import { AgentIcon } from "@/components/AgentIcon";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import {
  ARCHIVED_PAGE,
  archivedOlderThan,
  archivedThreads,
  canUnarchive,
  DEFAULT_CLEAR_DAYS,
  deleteArchivedThread,
  deleteRefusalText,
  groupArchived,
  searchArchived,
} from "@/lib/archived";
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// T10: the archived list, read-only threads; Unarchive only while the pane still exists. Adapted from
// T3's ArchivedThreadsPanel (pattern): grouped by project, a search box, Delete (thread.delete, a second
// tap confirms) and "Clear older than N days" for the pile pane-closed archives leave. Paged
// client-side, 50 at a time.
function Archived() {
  const threads = useSidebarThreads();
  const projects = useShell((s) => s.projects);
  const all = useMemo(() => archivedThreads(Object.values(threads)), [threads]);
  const [query, setQuery] = useState("");
  const [days, setDays] = useState(String(DEFAULT_CLEAR_DAYS));
  const [shown, setShown] = useState(ARCHIVED_PAGE);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const { pending, confirm } = usePendingConfirm();
  const searchId = useId();
  const daysId = useId();

  const list = useMemo(() => searchArchived(all, query, projects), [all, query, projects]);
  const groups = useMemo(() => groupArchived(list.slice(0, shown), projects), [list, shown, projects]);
  const dayCount = Number.parseInt(days, 10);
  const stale = useMemo(
    () => (Number.isFinite(dayCount) && dayCount >= 0 ? archivedOlderThan(all, dayCount, Date.now()) : []),
    [all, dayCount],
  );

  const remove = async (targets: readonly Thread[]): Promise<{ deleted: number; kept: string[] }> => {
    setBusy((b) => new Set([...b, ...targets.map((t) => t.id)]));
    let deleted = 0;
    const kept: string[] = [];
    try {
      for (const t of targets) {
        const out = await deleteArchivedThread(t.id);
        if (out.kind === "refused") kept.push(out.reason);
        else deleted++;
      }
    } finally {
      setBusy((b) => new Set([...b].filter((id) => !targets.some((t) => t.id === id))));
    }
    return { deleted, kept };
  };

  const deleteOne = async (t: Thread) => {
    if (!confirm(`delete:${t.id}`)) return;
    setStatus(null);
    const { kept } = await remove([t]);
    setStatus(kept.length > 0 ? deleteRefusalText(kept[0]!) : `Deleted ${t.title}.`);
  };

  const clearOlder = async () => {
    if (stale.length === 0 || !confirm("clear")) return;
    setStatus(null);
    const { deleted, kept } = await remove(stale);
    const open = kept.filter((r) => r === "pane-open").length;
    setStatus(
      [`Deleted ${plural(deleted, "thread")}.`, open > 0 ? `${plural(open, "thread")} kept: the pane is still open.` : null]
        .filter(Boolean)
        .join(" "),
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3 overflow-y-auto overscroll-y-contain p-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
      <div className="-mt-1 flex items-center gap-2">
        <BackToThreads />
        <h1 className="text-xl font-semibold">Archived</h1>
        {all.length > 0 ? <span className="text-sm text-muted-foreground tabular-nums">{all.length}</span> : null}
      </div>
      {all.length === 0 ? (
        <p className="text-sm text-muted-foreground">No archived threads.</p>
      ) : (
        <>
          <div className="relative">
            <label htmlFor={searchId} className="sr-only">
              Search archived threads
            </label>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search archived threads"
              className="min-h-11 w-full rounded-lg border border-input bg-background py-2 pr-3 pl-9 text-base text-foreground outline-none focus:border-ring"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm">
            <label htmlFor={daysId}>Clear older than</label>
            <input
              id={daysId}
              type="number"
              inputMode="numeric"
              min={0}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="min-h-11 w-20 rounded-lg border border-input bg-background px-2 text-base text-foreground outline-none focus:border-ring"
            />
            <span>days</span>
            <Button
              size="sm"
              variant={pending === "clear" ? "destructive" : "outline"}
              disabled={stale.length === 0 || busy.size > 0}
              onClick={() => void clearOlder()}
              className="ml-auto pointer-coarse:min-h-11"
            >
              {pending === "clear" ? `Delete ${plural(stale.length, "thread")}? Tap again` : `Clear ${stale.length}`}
            </Button>
          </div>
          {status ? (
            <p role="status" className="text-sm text-muted-foreground">
              {status}
            </p>
          ) : null}
          {list.length === 0 ? <p className="text-sm text-muted-foreground">No archived thread matches.</p> : null}
          {groups.map((g) => (
            <section key={g.projectId} aria-label={g.label} className="flex flex-col">
              <h2 className="sticky top-0 z-10 flex items-center gap-2 bg-background py-1 text-xs font-semibold text-muted-foreground">
                <span className="truncate">{g.label}</span>
                <span className="tabular-nums">{g.threads.length}</span>
              </h2>
              <ul aria-label={`Archived threads in ${g.label}`} className="divide-y rounded-lg border">
                {g.threads.map((t) => {
                  const armed = pending === `delete:${t.id}`;
                  return (
                    <li key={t.id} className="flex items-center gap-3 px-4 py-2 pointer-coarse:min-h-14">
                      <AgentIcon agent={t.harness} className="size-5" />
                      <Link to="/thread/$threadId" params={{ threadId: t.id }} className="min-w-0 flex-1 hover:underline">
                        <span className="block truncate text-sm">{t.title}</span>
                        <span className="block truncate text-2xs text-muted-foreground">
                          {[t.archiveReason ? REASON[t.archiveReason] : null, t.archivedAt ? timeAgo(t.archivedAt) : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </Link>
                      {canUnarchive(t.archiveReason) ? (
                        <Button
                          size="xs"
                          variant="outline"
                          className="pointer-coarse:min-h-11"
                          onClick={() => void performThreadCommand({ type: "thread.unarchive", threadId: t.id })}
                        >
                          Unarchive
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant={armed ? "destructive" : "ghost"}
                        disabled={busy.has(t.id)}
                        aria-label={armed ? `Tap again to delete ${t.title}` : `Delete ${t.title}`}
                        onClick={() => void deleteOne(t)}
                        className={cn("pointer-coarse:min-h-11 pointer-coarse:min-w-11", !armed && "text-muted-foreground")}
                      >
                        <Trash2Icon className="size-3.5" aria-hidden="true" />
                        {armed ? "Tap again" : null}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
      {list.length > shown ? (
        <Button variant="ghost" onClick={() => setShown((n) => n + ARCHIVED_PAGE)}>
          Show more ({list.length - shown})
        </Button>
      ) : null}
    </div>
  );
}
