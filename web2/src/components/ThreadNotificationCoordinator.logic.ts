// Pure rules for ThreadNotificationCoordinator (adapted from T3 Code's coordinator @ db5919d87): which
// status changes on which threads raise an in-app alert. Nothing here touches React or the DOM.
import { effectiveStatus, isNeedsYou } from "@/components/Sidebar.logic";
import type { Thread } from "@shared/v2/contracts";

export type AlertStatus = "approval" | "input" | "failed" | "done";

/**
 * The status that deserves an alert, or null. `done` counts only when the bridge itself says the thread
 * finished unread (`status`), not when the operator marked an idle thread unread. Settled, archived and
 * snoozed threads stay quiet: the operator put them away.
 */
export function alertStatus(thread: Thread): AlertStatus | null {
  if (thread.shelf === "settled" || thread.shelf === "archived" || thread.shelf === "snoozed") return null;
  const status = effectiveStatus(thread);
  if (status === "approval" || status === "input" || status === "failed") return status;
  if (status === "done" && thread.status === "done" && thread.unreadDone) return "done";
  return null;
}

export interface ThreadAlert {
  threadId: string;
  title: string;
  status: AlertStatus;
  /** One per thread and status. */
  key: string;
}

export interface AlertPlan {
  /** Pass back in as `previous` on the next call. */
  next: Map<string, AlertStatus | null>;
  /** Pass back in as `raised` on the next call. */
  raised: Set<string>;
  alerts: ThreadAlert[];
}

/**
 * Compare the threads now with the statuses seen last time.
 * - `previous === null` is the first look (or the first after a reload): record, never alert.
 * - A thread not seen before is new to us (just spawned, or just unarchived): record, never alert.
 * - Alert on a change into an alerting status, once per thread+status until the thread leaves it.
 * - Never for `openThreadId`: the operator is looking at it.
 */
export function planThreadAlerts(input: {
  previous: ReadonlyMap<string, AlertStatus | null> | null;
  raised: ReadonlySet<string>;
  threads: Iterable<Thread>;
  openThreadId: string | null;
}): AlertPlan {
  const next = new Map<string, AlertStatus | null>();
  const raised = new Set<string>();
  const alerts: ThreadAlert[] = [];
  for (const thread of input.threads) {
    const status = alertStatus(thread);
    next.set(thread.id, status);
    if (status === null) continue;
    const key = `${thread.id}:${status}`;
    // Still in an episode we already raised: stay quiet until it ends.
    if (input.raised.has(key)) raised.add(key);
    if (input.previous === null || !input.previous.has(thread.id)) continue;
    if (input.previous.get(thread.id) === status || input.raised.has(key)) continue;
    raised.add(key);
    if (thread.id === input.openThreadId) continue;
    alerts.push({ threadId: thread.id, title: thread.title, status, key });
  }
  return { next, raised, alerts };
}

const MAX_TITLE = 60;

/** "Fix the build needs you" / "Fix the build failed" / "Fix the build finished". */
export function alertText(alert: Pick<ThreadAlert, "title" | "status">): string {
  const title = alert.title.length > MAX_TITLE ? `${alert.title.slice(0, MAX_TITLE - 1)}…` : alert.title;
  if (alert.status === "done") return `${title} finished`;
  if (alert.status === "failed") return `${title} failed`;
  return `${title} needs you`;
}

/** The threads under "Needs you": what the app badge counts. */
export function needsYouCount(threads: Iterable<Thread>): number {
  let n = 0;
  for (const thread of threads) if (isNeedsYou(thread)) n += 1;
  return n;
}

/** The OS app badge, where the browser has one (installed PWAs). Never throws. */
export function setAppBadge(count: number): void {
  try {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (count > 0) void nav.setAppBadge?.(count)?.catch(() => {});
    else if (nav.clearAppBadge) void nav.clearAppBadge().catch(() => {});
    else void nav.setAppBadge?.(0)?.catch(() => {});
  } catch {
    // No badge API, or the browser refused it.
  }
}
