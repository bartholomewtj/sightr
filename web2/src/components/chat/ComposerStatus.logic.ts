/**
 * What the composer's status pieces read from a thread's runs and items: the error that ended the
 * latest run (ThreadErrorBanner / UsageLimitRecoveryBanner), the task list the agent keeps
 * (ComposerTasksBadge). Pure, so the rules are tested without rendering.
 */
import type { PlanStep, Run, TurnItem } from "@shared/v2/contracts";

export type ErrorItem = Extract<TurnItem, { type: "error" }>;
export type TodoListItem = Extract<TurnItem, { type: "todo_list" }>;

interface RunsAndItems {
  readonly runs: Readonly<Record<string, Run>>;
  readonly items: Readonly<Record<string, TurnItem>>;
}

/** The newest run (highest ordinal), or null. */
export function latestRunOf(runs: Readonly<Record<string, Run>>): Run | null {
  let latest: Run | null = null;
  for (const run of Object.values(runs)) if (!latest || run.ordinal > latest.ordinal) latest = run;
  return latest;
}

/**
 * The `error` item the latest run ended on: only when that run is over and failed, and the item is
 * its own (an error from an older run says nothing about the thread now). The newest one wins.
 */
export function latestRunError(state: RunsAndItems | null | undefined): ErrorItem | null {
  if (!state) return null;
  const run = latestRunOf(state.runs);
  if (!run || run.status !== "failed") return null;
  let found: ErrorItem | null = null;
  for (const item of Object.values(state.items)) {
    if (item.type !== "error" || item.runId !== run.id) continue;
    if (!found || item.ordinal > found.ordinal) found = item;
  }
  return found;
}

// ── Tasks (T3's ComposerTasksBadge shapes) ──────────────────────────────────────────────────────

export interface ComposerTasksProgress {
  readonly step: string;
  readonly completedSteps: number;
  readonly totalSteps: number;
}

export interface ComposerTaskStep {
  readonly durationMs?: number;
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

export interface ComposerTasks {
  readonly itemId: string;
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}

const STEP_STATUS: Record<PlanStep["status"], ComposerTaskStep["status"]> = {
  pending: "pending",
  running: "inProgress",
  completed: "completed",
};

/** Sightr's `PlanStep`s as T3's task rows, with the progress line: the running step, else the next one. */
export function composerTasksFrom(item: TodoListItem): ComposerTasks {
  const steps = item.steps.map(
    (s): ComposerTaskStep => ({ step: s.text, status: STEP_STATUS[s.status], ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}) }),
  );
  const completedSteps = steps.filter((s) => s.status === "completed").length;
  const current =
    steps.find((s) => s.status === "inProgress") ?? steps.find((s) => s.status === "pending") ?? steps.at(-1);
  return { itemId: item.id, steps, progress: { step: current?.step ?? "", completedSteps, totalSteps: steps.length } };
}

/**
 * The thread's task list for the badge: the newest `todo_list` item. A finished list stays while its
 * run is still going and goes once that run is over; an unfinished one stays until the agent updates
 * it (Pi often carries one list across several messages).
 */
export function activeComposerTasks(state: RunsAndItems | null | undefined): ComposerTasks | null {
  if (!state) return null;
  let newest: TodoListItem | null = null;
  for (const item of Object.values(state.items)) {
    if (item.type !== "todo_list" || item.steps.length === 0) continue;
    if (!newest || item.ordinal > newest.ordinal) newest = item;
  }
  if (!newest) return null;
  const tasks = composerTasksFrom(newest);
  const done = tasks.progress.completedSteps >= tasks.progress.totalSteps;
  if (done) {
    const run = newest.runId ? state.runs[newest.runId] : undefined;
    if (run?.status !== "running") return null;
  }
  return tasks;
}
