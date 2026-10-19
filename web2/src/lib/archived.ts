import type { Project, Thread } from "@shared/v2/contracts";
import { defaultCommandDeps, sendCommand, V2CommandError, type CommandDeps } from "@/stream/commands";

/** Archived threads shown per page on /archived (paged client-side). */
export const ARCHIVED_PAGE = 50;

/** "Clear older than" starts here (days). */
export const DEFAULT_CLEAR_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** One project's archived threads (T3's ArchivedThreadsPanel groups by project). */
export interface ArchivedGroup {
  projectId: string;
  label: string;
  threads: Thread[];
}

/**
 * `list` (already newest first) grouped by project, in order of each group's newest thread. A thread
 * whose project is gone keeps a group of its own, labelled by the project id.
 */
export function groupArchived(list: readonly Thread[], projects: Readonly<Record<string, Project>>): ArchivedGroup[] {
  const groups = new Map<string, ArchivedGroup>();
  for (const t of list) {
    let g = groups.get(t.projectId);
    if (!g) {
      g = { projectId: t.projectId, label: projects[t.projectId]?.label ?? t.projectId, threads: [] };
      groups.set(t.projectId, g);
    }
    g.threads.push(t);
  }
  return [...groups.values()];
}

/** The threads whose title, project label or harness contains every word of `query` (any case). */
export function searchArchived(list: readonly Thread[], query: string, projects: Readonly<Record<string, Project>>): Thread[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  return list.filter((t) => {
    const hay = `${t.title} ${projects[t.projectId]?.label ?? ""} ${t.harness}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The threads archived more than `days` days before `now` (a thread with no `archivedAt` never is). */
export function archivedOlderThan(list: readonly Thread[], days: number, now: number): Thread[] {
  if (!Number.isFinite(days) || days < 0) return [];
  const before = now - days * DAY_MS;
  return list.filter((t) => t.archivedAt !== undefined && t.archivedAt < before);
}

/** What one `thread.delete` came to. `gone`: the bridge no longer has it (a retry, or another device). */
export type DeleteOutcome = { kind: "deleted" } | { kind: "gone" } | { kind: "refused"; reason: string };

let commandDeps: () => CommandDeps = defaultCommandDeps;

/** Test seam: the command client's fetch and id source. */
export function __setArchivedDeps(deps: () => CommandDeps): void {
  commandDeps = deps;
}

/** Forget one archived thread on the bridge. Never throws. */
export async function deleteArchivedThread(threadId: string): Promise<DeleteOutcome> {
  try {
    await sendCommand("thread.delete", { threadId }, commandDeps());
    return { kind: "deleted" };
  } catch (err) {
    if (err instanceof V2CommandError && err.status === 404) return { kind: "gone" };
    if (err instanceof V2CommandError) return { kind: "refused", reason: err.body?.error ?? err.code };
    return { kind: "refused", reason: "the bridge did not answer" };
  }
}

/** The operator's words for a refused delete. */
export function deleteRefusalText(reason: string): string {
  if (reason === "pane-open") return "Its pane is still open. Close the pane, or unarchive the thread.";
  if (reason === "not-archived") return "It is no longer archived.";
  return `Could not delete: ${reason}`;
}

/** Threads whose Herdr pane is still listed (archived or not). */
export function paneOpenThreads(threads: Iterable<Thread>): Thread[] {
  return [...threads].filter((t) => t.paneAlive === true);
}

/** What one `thread.pane.close` came to. `gone`: the bridge no longer has the thread. */
export type CloseOutcome = { kind: "closed" } | { kind: "gone" } | { kind: "refused"; reason: string };

/** Close a thread's Herdr pane on the bridge (an active thread is archived as `pane-closed`). Never throws. */
export async function closeThreadPane(threadId: string): Promise<CloseOutcome> {
  try {
    await sendCommand("thread.pane.close", { threadId }, commandDeps());
    return { kind: "closed" };
  } catch (err) {
    if (err instanceof V2CommandError && err.status === 404) return { kind: "gone" };
    if (err instanceof V2CommandError) return { kind: "refused", reason: err.body?.error ?? err.code };
    return { kind: "refused", reason: "the bridge did not answer" };
  }
}
