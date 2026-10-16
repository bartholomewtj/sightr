// Adapted from T3 Code apps/web/src/components/Sidebar.logic.ts @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Kept from T3: the section model (`resolveSidebarThreadSection`), the drop verbs
// (`resolveSidebarDropVerb`), the pinned-reorder plan (`planPinnedReorder`, from
// packages/client-runtime/src/state/threadSort.ts, on numbers instead of string keys) and
// `resolveSidebarRowAccessibility`. Sightr's: shelves come from the bridge's `shelf` field, projects are
// herdr workspaces with worktree nesting, and every change is one `Command`.
import {
  THREAD_STATUS_RANK,
  worstStatus,
  type Command,
  type Project,
  type Shelf,
  type Thread,
  type ThreadStatus,
} from "@shared/v2/contracts";

// ── Sections ────────────────────────────────────────────────────────────────────────────────────

/** T3 has a `working` section too (beta); Sightr's Active list already sorts working threads up. */
export type SidebarSection = "pinned" | "active" | "snoozed" | "settled";
export const SIDEBAR_SECTIONS: readonly SidebarSection[] = ["pinned", "active", "snoozed", "settled"];

export function resolveSidebarThreadSection(thread: Pick<Thread, "shelf">): SidebarSection | null {
  return thread.shelf === "archived" ? null : thread.shelf;
}

/**
 * The status the sidebar shows. The bridge's `done` means "finished and unread"; `unreadDone` is the
 * operator's flag (`thread.markRead|markUnread`). Reading the flag here makes a mark-read or mark-unread
 * show at once, before the herd ingest recomputes the status.
 */
export function effectiveStatus(thread: Pick<Thread, "status" | "unreadDone">): ThreadStatus {
  if (thread.status === "done" && !thread.unreadDone) return "idle";
  if (thread.status === "idle" && thread.unreadDone) return "done";
  return thread.status;
}

const STATUS_LABELS: Record<ThreadStatus, string> = {
  approval: "Needs approval",
  input: "Needs input",
  failed: "Failed",
  working: "Working",
  done: "Done",
  idle: "Idle",
  starting: "Starting",
};

/** The accessible name of a status dot: "Needs approval", "Working, 2:14", "Idle". */
export function statusLabel(status: ThreadStatus, elapsedText?: string | null): string {
  const base = STATUS_LABELS[status];
  return status === "working" && elapsedText ? `${base}, ${elapsedText}` : base;
}

/** T3: one accessible name per row (title, status, project). */
export function resolveSidebarRowAccessibility(input: {
  readonly title: string;
  readonly statusLabel: string | null;
  readonly projectDisplayName: string | null;
  readonly isActive: boolean;
}): { readonly label: string; readonly current: "page" | undefined } {
  return {
    label: [input.title, input.statusLabel, input.projectDisplayName].filter(Boolean).join(", "),
    current: input.isActive ? "page" : undefined,
  };
}

// ── Sorting and shelves ─────────────────────────────────────────────────────────────────────────

const byId = (a: Thread, b: Thread) => a.id.localeCompare(b.id);

export function comparePinned(a: Thread, b: Thread): number {
  const ao = a.pinOrder ?? Number.POSITIVE_INFINITY;
  const bo = b.pinOrder ?? Number.POSITIVE_INFINITY;
  return ao === bo ? (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0) || byId(a, b) : ao < bo ? -1 : 1;
}

/** Status rank (worst first), then newest activity. */
export function compareActive(a: Thread, b: Thread): number {
  return (
    THREAD_STATUS_RANK[effectiveStatus(a)] - THREAD_STATUS_RANK[effectiveStatus(b)] ||
    b.lastActivityAt - a.lastActivityAt ||
    byId(a, b)
  );
}

/** Soonest wake first. */
export function compareSnoozed(a: Thread, b: Thread): number {
  return (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0) || byId(a, b);
}

/** Most recently settled first. */
export function compareSettled(a: Thread, b: Thread): number {
  return (b.settledAt ?? 0) - (a.settledAt ?? 0) || b.lastActivityAt - a.lastActivityAt || byId(a, b);
}

export type SidebarShelves = Record<SidebarSection, Thread[]>;

const COMPARE: Record<SidebarSection, (a: Thread, b: Thread) => number> = {
  pinned: comparePinned,
  active: compareActive,
  snoozed: compareSnoozed,
  settled: compareSettled,
};

/** Non-archived threads into the four shelves, each sorted. */
export function partitionShelves(threads: Iterable<Thread>): SidebarShelves {
  const shelves: SidebarShelves = { pinned: [], active: [], snoozed: [], settled: [] };
  for (const thread of threads) {
    const section = resolveSidebarThreadSection(thread);
    if (section) shelves[section].push(thread);
  }
  for (const section of SIDEBAR_SECTIONS) shelves[section].sort(COMPARE[section]);
  return shelves;
}

/** The roll-up dot: the worst effective status among non-archived threads (rank from contracts.ts). */
export function rollUpStatus(threads: Iterable<Thread>): ThreadStatus | null {
  const statuses: ThreadStatus[] = [];
  for (const thread of threads) if (thread.shelf !== "archived") statuses.push(effectiveStatus(thread));
  return statuses.length === 0 ? null : worstStatus(statuses);
}

// ── Projects and worktree nesting ───────────────────────────────────────────────────────────────

export interface SidebarProjectNode {
  project: Project;
  /** This project's own non-archived threads, by shelf. */
  shelves: SidebarShelves;
  /** Linked worktrees of this primary checkout (always empty on a worktree row). */
  worktrees: SidebarProjectNode[];
  /** Worst status of this row's threads and its worktrees' threads; null when there are none. */
  rollUp: ThreadStatus | null;
  /** Non-archived threads on this row (worktrees not included). */
  count: number;
  /** Shown nested under a primary checkout. */
  nested: boolean;
}

const compareProjects = (a: Project, b: Project) => a.order - b.order || a.number - b.number || a.id.localeCompare(b.id);

/**
 * Projects in `order`, with linked worktrees (`worktreeOf`) nested under the open primary checkout of
 * the same repo (`repoKey`, no `worktreeOf`). A worktree whose primary is not open stands at top level,
 * in its own place. Closed projects (only archived threads point at them) are left out.
 */
export function buildProjectTree(projects: Iterable<Project>, threads: Iterable<Thread>): SidebarProjectNode[] {
  const open = [...projects].filter((p) => p.closedAt === undefined).sort(compareProjects);
  const byProject = new Map<string, Thread[]>();
  for (const thread of threads) {
    if (thread.shelf === "archived") continue;
    const list = byProject.get(thread.projectId);
    if (list) list.push(thread);
    else byProject.set(thread.projectId, [thread]);
  }

  const primaryByRepo = new Map<string, string>();
  for (const p of open) {
    if (p.repoKey !== undefined && p.worktreeOf === undefined && !primaryByRepo.has(p.repoKey)) primaryByRepo.set(p.repoKey, p.id);
  }

  const node = (project: Project, nested: boolean): SidebarProjectNode => {
    const own = byProject.get(project.id) ?? [];
    return { project, shelves: partitionShelves(own), worktrees: [], rollUp: rollUpStatus(own), count: own.length, nested };
  };

  const nodes = new Map<string, SidebarProjectNode>();
  const top: SidebarProjectNode[] = [];
  for (const p of open) {
    const primaryId = p.worktreeOf !== undefined ? primaryByRepo.get(p.worktreeOf) : undefined;
    if (primaryId === undefined || primaryId === p.id) {
      const n = node(p, false);
      nodes.set(p.id, n);
      top.push(n);
    }
  }
  for (const p of open) {
    const primaryId = p.worktreeOf !== undefined ? primaryByRepo.get(p.worktreeOf) : undefined;
    if (primaryId === undefined || primaryId === p.id) continue;
    nodes.get(primaryId)?.worktrees.push(node(p, true));
  }
  for (const n of top) {
    if (n.worktrees.length === 0) continue;
    const statuses = [n.rollUp, ...n.worktrees.map((w) => w.rollUp)].filter((s): s is ThreadStatus => s !== null);
    n.rollUp = statuses.length === 0 ? null : worstStatus(statuses);
  }
  return top;
}

/** The project rows in screen order (primaries, each followed by its worktrees). */
export function flattenProjectTree(tree: readonly SidebarProjectNode[]): SidebarProjectNode[] {
  return tree.flatMap((n) => [n, ...n.worktrees]);
}

// ── Filters ─────────────────────────────────────────────────────────────────────────────────────

export type SidebarFilter = "all" | "needs-you";

/** Approval, input, failed, or done-and-unread; never settled or archived. */
export function isNeedsYou(thread: Thread): boolean {
  if (thread.shelf === "settled" || thread.shelf === "archived") return false;
  const status = effectiveStatus(thread);
  return status === "approval" || status === "input" || status === "failed" || (status === "done" && thread.unreadDone);
}

/** The Needs-you list: flat, across projects and shelves, worst first. */
export function needsYouThreads(threads: Iterable<Thread>): Thread[] {
  return [...threads].filter(isNeedsYou).sort(compareActive);
}

/**
 * Search: case-insensitive substring of the title, the project label or the harness. Archived threads
 * are left out; the result is one flat list, worst first.
 */
export function searchSidebarThreads(
  threads: Iterable<Thread>,
  projects: Readonly<Record<string, Project>>,
  query: string,
): Thread[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return [...threads]
    .filter((t) => {
      if (t.shelf === "archived") return false;
      const label = projects[t.projectId]?.label ?? "";
      return t.title.toLowerCase().includes(q) || label.toLowerCase().includes(q) || t.harness.toLowerCase().includes(q);
    })
    .sort(compareActive);
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The sidebar's commands, before the command client adds a `commandId`. */
export type ShelfCommand = DistributiveOmit<
  Extract<
    Command,
    {
      type:
        | "thread.rename"
        | "thread.pin"
        | "thread.unpin"
        | "thread.snooze"
        | "thread.unsnooze"
        | "thread.settle"
        | "thread.unsettle"
        | "thread.archive"
        | "thread.unarchive"
        | "thread.markRead"
        | "thread.markUnread";
    }
  >,
  "commandId"
>;

/**
 * What the bridge will make of `command` (bridge/threads/decide.ts), applied to `thread` ahead of the
 * event: the optimistic view. `maxPinOrder` is the highest pin order the client knows, for a pin with
 * no `pinOrder`.
 */
export function applyShelfCommand(thread: Thread, command: ShelfCommand, at: number, maxPinOrder: number): Thread {
  const shelf = (next: Exclude<Shelf, "archived">, extra: Partial<Thread> = {}): Thread => {
    const t: Thread = { ...thread, shelf: next, updatedAt: at };
    delete t.snoozedUntil;
    delete t.pinnedAt;
    delete t.pinOrder;
    delete t.settledAt;
    delete t.archivedAt;
    delete t.archiveReason;
    return { ...t, ...extra };
  };
  const archived = thread.shelf === "archived";
  switch (command.type) {
    case "thread.rename": {
      const title = command.title.trim();
      return title && !archived ? { ...thread, title, titleSource: "user", updatedAt: at } : thread;
    }
    case "thread.pin": {
      if (archived) return thread;
      if (thread.shelf === "pinned" && (command.pinOrder === undefined || command.pinOrder === thread.pinOrder)) return thread;
      return shelf("pinned", { pinnedAt: at, pinOrder: command.pinOrder ?? maxPinOrder + 1 });
    }
    case "thread.unpin":
      return thread.shelf === "pinned" ? shelf("active") : thread;
    case "thread.snooze":
      return archived || command.until <= at ? thread : shelf("snoozed", { snoozedUntil: command.until });
    case "thread.unsnooze":
      return thread.shelf === "snoozed" ? shelf("active") : thread;
    case "thread.settle":
      return archived || thread.shelf === "settled" ? thread : shelf("settled", { settledAt: at });
    case "thread.unsettle":
      return thread.shelf === "settled" ? shelf("active") : thread;
    case "thread.archive": {
      if (archived) return thread;
      const t = shelf("active");
      return { ...t, shelf: "archived", archivedAt: at, archiveReason: "user" };
    }
    case "thread.unarchive":
      return archived ? shelf("active") : thread;
    case "thread.markRead":
      return thread.unreadDone ? { ...thread, unreadDone: false, updatedAt: at } : thread;
    case "thread.markUnread":
      return thread.unreadDone ? thread : { ...thread, unreadDone: true, updatedAt: at };
  }
}

/** Where a thread sat before an undoable change: enough to put it back, not just flip a flag. */
export interface ShelfPlace {
  shelf: Shelf;
  pinOrder?: number;
  snoozedUntil?: number;
}

export function shelfPlace(thread: Thread): ShelfPlace {
  return {
    shelf: thread.shelf,
    ...(thread.pinOrder !== undefined ? { pinOrder: thread.pinOrder } : {}),
    ...(thread.snoozedUntil !== undefined ? { snoozedUntil: thread.snoozedUntil } : {}),
  };
}

/**
 * The commands that take a thread now on `current` back to `previous`, in order. Unarchive first (it
 * lands on Active), then one command to the old shelf. A snooze whose wake time has passed restores to
 * Active, as the bridge would have woken it by now.
 */
export function restoreShelfCommands(threadId: string, current: Shelf, previous: ShelfPlace, now: number): ShelfCommand[] {
  const out: ShelfCommand[] = [];
  let at = current;
  if (at === "archived" && previous.shelf !== "archived") {
    out.push({ type: "thread.unarchive", threadId });
    at = "active";
  }
  const toActive = (): ShelfCommand | null =>
    at === "pinned"
      ? { type: "thread.unpin", threadId }
      : at === "settled"
        ? { type: "thread.unsettle", threadId }
        : at === "snoozed"
          ? { type: "thread.unsnooze", threadId }
          : null;
  switch (previous.shelf) {
    case "archived":
      if (at !== "archived") out.push({ type: "thread.archive", threadId });
      break;
    case "pinned":
      out.push({ type: "thread.pin", threadId, ...(previous.pinOrder !== undefined ? { pinOrder: previous.pinOrder } : {}) });
      break;
    case "settled":
      if (at !== "settled") out.push({ type: "thread.settle", threadId });
      break;
    case "snoozed":
      if (previous.snoozedUntil !== undefined && previous.snoozedUntil > now) {
        out.push({ type: "thread.snooze", threadId, until: previous.snoozedUntil });
      } else {
        const cmd = toActive();
        if (cmd) out.push(cmd);
      }
      break;
    case "active": {
      const cmd = toActive();
      if (cmd) out.push(cmd);
      break;
    }
  }
  return out;
}

// ── Drag and drop ───────────────────────────────────────────────────────────────────────────────

export type SidebarDropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";

/** T3: the verb a drop from one section into another means; null when it means nothing. */
export function resolveSidebarDropVerb(from: SidebarSection, to: SidebarSection | null): SidebarDropVerb | null {
  if (to === null || to === from || to === "snoozed") return null;
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

/**
 * T3's `planPinnedReorder` on numbers: the `pinOrder` that puts `movedId` where it sits in `orderedIds`,
 * halfway between its neighbours. Undefined means "after the last pin" (the bridge's default), used when
 * the moved thread is last or there is no usable gap.
 */
export function planPinnedReorder(input: {
  readonly orderedIds: readonly string[];
  readonly ordersById: ReadonlyMap<string, number | undefined>;
  readonly movedId: string;
}): number | undefined {
  const { orderedIds, ordersById, movedId } = input;
  const index = orderedIds.indexOf(movedId);
  if (index === -1) return undefined;
  const before = index > 0 ? ordersById.get(orderedIds[index - 1]!) : undefined;
  const after = index < orderedIds.length - 1 ? ordersById.get(orderedIds[index + 1]!) : undefined;
  if (after === undefined) return before === undefined ? undefined : before + 1;
  if (before === undefined) return index === 0 ? after - 1 : undefined;
  const mid = (before + after) / 2;
  return mid > before && mid < after ? mid : undefined;
}

export type SidebarDropPlan =
  | { kind: "none" }
  /** Dropping onto Snoozed: snoozing needs a time, so the header shakes and a toast explains. */
  | { kind: "refused-snooze" }
  | { kind: "command"; verb: SidebarDropVerb | "reorder"; command: ShelfCommand };

/**
 * One drop: the moved thread, where it was, where it lands, and (for Pinned) the pinned ids in their new
 * order with the moved one in place. Active, Snoozed and Settled have no manual order.
 */
export function planSidebarDrop(input: {
  readonly thread: Thread;
  readonly from: SidebarSection;
  readonly to: SidebarSection;
  readonly pinnedOrderAfterDrop?: readonly string[];
  readonly pinOrders?: ReadonlyMap<string, number | undefined>;
}): SidebarDropPlan {
  const { thread, from, to } = input;
  const threadId = thread.id;
  if (to === "snoozed") return from === "snoozed" ? { kind: "none" } : { kind: "refused-snooze" };
  if (to === "pinned") {
    const order = input.pinnedOrderAfterDrop ?? [];
    const pinOrder = planPinnedReorder({ orderedIds: order, ordersById: input.pinOrders ?? new Map(), movedId: threadId });
    if (from === "pinned") {
      if (pinOrder === undefined || pinOrder === thread.pinOrder) return { kind: "none" };
      return { kind: "command", verb: "reorder", command: { type: "thread.pin", threadId, pinOrder } };
    }
    return { kind: "command", verb: "pin", command: { type: "thread.pin", threadId, ...(pinOrder !== undefined ? { pinOrder } : {}) } };
  }
  const verb = resolveSidebarDropVerb(from, to);
  switch (verb) {
    case "settle":
      return { kind: "command", verb, command: { type: "thread.settle", threadId } };
    case "unpin":
      return { kind: "command", verb, command: { type: "thread.unpin", threadId } };
    case "unsettle":
      return { kind: "command", verb, command: { type: "thread.unsettle", threadId } };
    case "wake":
      return { kind: "command", verb, command: { type: "thread.unsnooze", threadId } };
    default:
      return { kind: "none" };
  }
}

// ── Keyboard ────────────────────────────────────────────────────────────────────────────────────

/** T3: the next or previous id in screen order, clamped at the ends. */
export function resolveAdjacentThreadId<T>(input: {
  readonly threadIds: readonly T[];
  readonly currentThreadId: T | null;
  readonly direction: "previous" | "next";
}): T | null {
  const { threadIds, currentThreadId, direction } = input;
  if (threadIds.length === 0) return null;
  if (currentThreadId === null) return direction === "previous" ? threadIds.at(-1)! : threadIds[0]!;
  const index = threadIds.indexOf(currentThreadId);
  if (index === -1) return null;
  const next = direction === "previous" ? index - 1 : index + 1;
  return threadIds[Math.min(Math.max(next, 0), threadIds.length - 1)] ?? null;
}

/** The needs-you count in the tab title (desktop), as v1 does. */
export function documentTitle(needsYou: number): string {
  return needsYou > 0 ? `(${needsYou}) Sightr` : "Sightr";
}
