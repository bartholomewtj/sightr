import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import type { Project, Thread } from "@shared/v2/contracts";
import { useShell } from "@/stream/stores";

/**
 * The sidebar slot. T10 builds the real one (shelves, status dots, archived list, undo); this is the
 * plainest list that makes the shell usable meanwhile: live threads grouped by project.
 */
export function Sidebar() {
  const loaded = useShell((s) => s.loaded);
  const projects = useShell(useShallow((s) => Object.values(s.projects)));
  const threads = useShell(useShallow((s) => Object.values(s.threads)));
  const groups = useMemo(() => groupThreads(projects, threads), [projects, threads]);

  return (
    <nav aria-label="Threads" className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="font-semibold">Sightr</span>
        <span className="flex gap-3 text-sm">
          <Link to="/archived" className="text-muted-foreground hover:text-foreground">
            Archived
          </Link>
          <Link to="/settings" className="text-muted-foreground hover:text-foreground">
            Settings
          </Link>
        </span>
      </div>
      {!loaded && <p className="px-4 text-sm text-muted-foreground">Loading threads…</p>}
      {loaded && groups.length === 0 && <p className="px-4 text-sm text-muted-foreground">No threads.</p>}
      {groups.map(({ project, threads: list }) => (
        <section key={project.id} className="pb-2">
          <h2 className="px-4 py-1 text-xs font-medium text-muted-foreground">{project.label}</h2>
          <ul>
            {list.map((thread) => (
              <li key={thread.id}>
                <Link
                  to="/thread/$threadId"
                  params={{ threadId: thread.id }}
                  className="flex items-center justify-between gap-2 px-4 py-1.5 text-sm hover:bg-sidebar-row-hover data-[status=active]:bg-sidebar-row-active"
                >
                  <span className="truncate">{thread.title}</span>
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">{thread.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

/** Projects in their herd order, each with its non-archived threads (pinned first, then newest activity). */
export function groupThreads(projects: Project[], threads: Thread[]): { project: Project; threads: Thread[] }[] {
  const byProject = new Map<string, Thread[]>();
  for (const thread of threads) {
    if (thread.shelf === "archived") continue;
    const list = byProject.get(thread.projectId) ?? [];
    list.push(thread);
    byProject.set(thread.projectId, list);
  }
  return [...projects]
    .sort((a, b) => a.order - b.order)
    .filter((p) => byProject.has(p.id))
    .map((project) => ({
      project,
      threads: (byProject.get(project.id) ?? []).sort(
        (a, b) => Number(b.shelf === "pinned") - Number(a.shelf === "pinned") || b.lastActivityAt - a.lastActivityAt,
      ),
    }));
}
