import type { Thread } from "@shared/v2/contracts";

/** Archived threads shown per page on /archived (paged client-side). */
export const ARCHIVED_PAGE = 50;

/** A pane that still exists can come back from Archived; only a user archive leaves the pane open. */
export function canUnarchive(reason: string | undefined): boolean {
  return reason === "user";
}

/** Archived threads, newest `archivedAt` first. */
export function archivedThreads(threads: Iterable<Thread>): Thread[] {
  return [...threads]
    .filter((t) => t.shelf === "archived")
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0) || a.id.localeCompare(b.id));
}
