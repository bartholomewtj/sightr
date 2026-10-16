// Thread order for thread.previous / thread.next (T13): the sidebar's screen order of the threads it
// shows open (pinned, then active, per project row), as T3's thread traversal walks its sidebar.
import type { Project, Thread } from "@shared/v2/contracts";

import { buildProjectTree, flattenProjectTree, resolveAdjacentThreadId } from "@/components/Sidebar.logic";

export function sidebarThreadOrder(projects: Iterable<Project>, threads: Iterable<Thread>): string[] {
  const out: string[] = [];
  for (const node of flattenProjectTree(buildProjectTree(projects, threads))) {
    for (const t of node.shelves.pinned) out.push(t.id);
    for (const t of node.shelves.active) out.push(t.id);
  }
  return out;
}

/** The thread before or after `current` in sidebar order (the first or last when none is open). */
export function adjacentThread(
  projects: Iterable<Project>,
  threads: Iterable<Thread>,
  current: string | null,
  direction: "previous" | "next",
): string | null {
  const order = sidebarThreadOrder(projects, threads);
  const from = current !== null && order.includes(current) ? current : null;
  const next = resolveAdjacentThreadId({ threadIds: order, currentThreadId: from, direction });
  return next === current ? null : next;
}
