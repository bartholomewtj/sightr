/**
 * The sidebar's state beside the shell stream (T10).
 *
 * - **Optimistic shelf changes.** Every shelf change is a bridge command. `performThreadCommand` applies
 *   it at once as an overlay keyed by its `commandId`, then posts it. The overlay goes when the command
 *   fails (the change rolls back) or once the shell stream has reached the command's sequence (the
 *   stream's state, whatever it says, is the truth from then on). Nothing about shelves is stored on
 *   the device.
 * - **Undo.** Unpin, settle, snooze and archive capture the thread's place (shelf, pin order, snooze
 *   time) at click time and offer "<action> · Undo", which sends the commands that put it back.
 * - **Per-device preferences** in localStorage: collapsed projects, open Snoozed/Settled sections and the
 *   All / Needs-you filter.
 * - **Working since.** The shell carries no run start, so the client notes when it first saw each
 *   thread go `working` (the thread's `updatedAt` at that change).
 */
import { useMemo } from "react";
import { create } from "zustand";

import type { Thread } from "@shared/v2/contracts";
import {
  applyShelfCommand,
  restoreShelfCommands,
  shelfPlace,
  type ShelfCommand,
  type SidebarFilter,
  type SidebarSection,
} from "@/components/Sidebar.logic";
import { showToast } from "@/components/toast";
import { dismissThreadUndoNotice, showThreadUndoNotice, type UndoAction } from "@/hooks/showThreadUndoNotice";
import { defaultCommandDeps, sendCommand, V2CommandError, type CommandDeps } from "@/stream/commands";
import { useShell } from "@/stream/stores";

// ── Optimistic overlay ──────────────────────────────────────────────────────────────────────────

interface PendingCommand {
  commandId: string;
  command: ShelfCommand;
  at: number;
  maxPinOrder: number;
  /** The bridge's reply; the overlay drops once the shell stream reaches it. */
  sequence?: number;
}

interface PendingState {
  pending: PendingCommand[];
}

export const usePendingShelf = create<PendingState>(() => ({ pending: [] }));

/** How long a confirmed overlay may wait for the stream before it is dropped anyway. */
export const CONFIRM_GRACE_MS = 15_000;

function drop(commandId: string): void {
  usePendingShelf.setState((s) =>
    s.pending.some((p) => p.commandId === commandId) ? { pending: s.pending.filter((p) => p.commandId !== commandId) } : s,
  );
}

function pruneConfirmed(sequence: number): void {
  const { pending } = usePendingShelf.getState();
  if (pending.some((p) => p.sequence !== undefined && p.sequence <= sequence)) {
    usePendingShelf.setState({ pending: pending.filter((p) => p.sequence === undefined || p.sequence > sequence) });
  }
}

useShell.subscribe((s, prev) => {
  if (s.sequence !== prev.sequence) pruneConfirmed(s.sequence);
  noteWorking(s.threads, prev.threads);
});

/** The threads the sidebar draws: the shell stream's, with pending commands applied in order. */
export function applyPending(threads: Readonly<Record<string, Thread>>, pending: readonly PendingCommand[]): Record<string, Thread> {
  if (pending.length === 0) return threads as Record<string, Thread>;
  const out: Record<string, Thread> = { ...threads };
  for (const p of pending) {
    const thread = out[p.command.threadId];
    if (thread) out[thread.id] = applyShelfCommand(thread, p.command, p.at, p.maxPinOrder);
  }
  return out;
}

export function useSidebarThreads(): Record<string, Thread> {
  const threads = useShell((s) => s.threads);
  const pending = usePendingShelf((s) => s.pending);
  return useMemo(() => applyPending(threads, pending), [threads, pending]);
}

/** One thread as the sidebar sees it (pending commands applied). */
export function useSidebarThread(threadId: string | undefined): Thread | undefined {
  const thread = useShell((s) => (threadId ? s.threads[threadId] : undefined));
  const pending = usePendingShelf((s) => s.pending);
  return useMemo(() => {
    if (!thread) return undefined;
    return applyPending({ [thread.id]: thread }, pending.filter((p) => p.command.threadId === thread.id))[thread.id];
  }, [thread, pending]);
}

function currentThread(threadId: string): Thread | undefined {
  return applyPending(useShell.getState().threads, usePendingShelf.getState().pending)[threadId];
}

function maxPinOrder(): number {
  let max = 0;
  for (const t of Object.values(useShell.getState().threads)) if (t.shelf === "pinned" && (t.pinOrder ?? 0) > max) max = t.pinOrder ?? 0;
  return max;
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────

let commandDeps: () => CommandDeps = defaultCommandDeps;
let clock: () => number = () => Date.now();

/** Test seam: the command client's fetch and id source, and the clock. */
export function __setSidebarDeps(deps: { command?: () => CommandDeps; now?: () => number }): void {
  if (deps.command) commandDeps = deps.command;
  if (deps.now) clock = deps.now;
}

const FAILURE_VERB: Record<ShelfCommand["type"], string> = {
  "thread.rename": "rename",
  "thread.pin": "pin",
  "thread.unpin": "unpin",
  "thread.snooze": "snooze",
  "thread.unsnooze": "wake",
  "thread.settle": "settle",
  "thread.unsettle": "unsettle",
  "thread.archive": "archive",
  "thread.unarchive": "unarchive",
  "thread.markRead": "mark read",
  "thread.markUnread": "mark unread",
};

function failureText(command: ShelfCommand, err: unknown): string {
  const reason = err instanceof V2CommandError ? (err.body?.error ?? err.code) : "the bridge did not answer";
  return `Couldn't ${FAILURE_VERB[command.type]}: ${reason}`;
}

/**
 * Apply `command` optimistically and post it. Resolves true when the bridge accepted it; on a refusal
 * or a network failure the overlay is dropped (the change rolls back) and an error toast says why.
 */
export async function sendShelfCommand(command: ShelfCommand): Promise<boolean> {
  const deps = commandDeps();
  const commandId = deps.newId();
  usePendingShelf.setState((s) => ({
    pending: [...s.pending, { commandId, command, at: clock(), maxPinOrder: maxPinOrder() }],
  }));
  const { type, ...payload } = command;
  try {
    const { sequence } = await sendCommand(type, payload as never, { ...deps, newId: () => commandId });
    if (useShell.getState().sequence >= sequence) drop(commandId);
    else {
      usePendingShelf.setState((s) => ({ pending: s.pending.map((p) => (p.commandId === commandId ? { ...p, sequence } : p)) }));
      setTimeout(() => drop(commandId), CONFIRM_GRACE_MS);
    }
    return true;
  } catch (err) {
    drop(commandId);
    showToast(failureText(command, err), "error");
    return false;
  }
}

/** Rename a project (`project.rename`). Not optimistic: the bridge's `project.upserted` redraws the label. */
export async function renameProject(projectId: string, label: string): Promise<boolean> {
  try {
    await sendCommand("project.rename", { projectId, label }, commandDeps());
    return true;
  } catch (err) {
    const reason = err instanceof V2CommandError ? (err.body?.error ?? err.code) : "the bridge did not answer";
    showToast(`Couldn't rename: ${reason}`, "error");
    return false;
  }
}

/** Run commands one after another; stop at the first refusal. */
export async function sendShelfCommands(commands: readonly ShelfCommand[]): Promise<boolean> {
  for (const command of commands) if (!(await sendShelfCommand(command))) return false;
  return true;
}

const UNDO_ACTION: Partial<Record<ShelfCommand["type"], UndoAction>> = {
  "thread.unpin": "Unpinned",
  "thread.settle": "Settled",
  "thread.snooze": "Snoozed",
  "thread.archive": "Archived",
};

/**
 * The sidebar's one entry point for a thread change: optimistic, posted, and (for unpin, settle,
 * snooze and archive) undoable for 5 s with the place captured now.
 */
export async function performThreadCommand(command: ShelfCommand): Promise<boolean> {
  const before = currentThread(command.threadId);
  const action = UNDO_ACTION[command.type];
  let noticeId: number | undefined;
  if (before && action) {
    const place = shelfPlace(before);
    const threadId = before.id;
    noticeId = showThreadUndoNotice({
      action,
      threadId,
      undo: async () => {
        const now = currentThread(threadId);
        if (!now) return;
        await sendShelfCommands(restoreShelfCommands(threadId, now.shelf, place, clock()));
      },
    });
  }
  const ok = await sendShelfCommand(command);
  if (!ok && noticeId !== undefined) dismissThreadUndoNotice(noticeId);
  return ok;
}

// ── Working since ───────────────────────────────────────────────────────────────────────────────

export const useWorkingSince = create<{ since: Record<string, number> }>(() => ({ since: {} }));

function noteWorking(threads: Readonly<Record<string, Thread>>, prev: Readonly<Record<string, Thread>>): void {
  if (threads === prev) return;
  const since = useWorkingSince.getState().since;
  let next: Record<string, number> | null = null;
  for (const t of Object.values(threads)) {
    const was = since[t.id];
    if (t.status === "working") {
      // An entry exists only while the thread works, so a missing one means it just started.
      if (was === undefined) {
        next ??= { ...since };
        next[t.id] = t.updatedAt;
      }
    } else if (was !== undefined) {
      next ??= { ...since };
      delete next[t.id];
    }
  }
  if (next) useWorkingSince.setState({ since: next });
}

// ── Per-device preferences ──────────────────────────────────────────────────────────────────────

const PREFS_KEY = "sightr:v2:sidebar";

interface SidebarPrefs {
  collapsedProjects: string[];
  /** `${projectId}:${section}` for each open Snoozed or Settled section. */
  openSections: string[];
  filter: SidebarFilter;
}

const DEFAULT_PREFS: SidebarPrefs = { collapsedProjects: [], openSections: [], filter: "all" };

function readPrefs(): SidebarPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<SidebarPrefs>;
    return {
      collapsedProjects: Array.isArray(parsed.collapsedProjects) ? parsed.collapsedProjects.filter((x) => typeof x === "string") : [],
      openSections: Array.isArray(parsed.openSections) ? parsed.openSections.filter((x) => typeof x === "string") : [],
      filter: parsed.filter === "needs-you" ? "needs-you" : "all",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs: SidebarPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode: the preference lives for this page only */
  }
}

interface SidebarPrefsState extends SidebarPrefs {
  toggleProject(projectId: string): void;
  toggleSection(projectId: string, section: SidebarSection): void;
  setFilter(filter: SidebarFilter): void;
}

const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

export const useSidebarPrefs = create<SidebarPrefsState>((set, get) => {
  const save = (patch: Partial<SidebarPrefs>) => {
    set(patch);
    const { collapsedProjects, openSections, filter } = get();
    writePrefs({ collapsedProjects, openSections, filter });
  };
  return {
    ...readPrefs(),
    toggleProject: (projectId) => save({ collapsedProjects: toggle(get().collapsedProjects, projectId) }),
    toggleSection: (projectId, section) => save({ openSections: toggle(get().openSections, `${projectId}:${section}`) }),
    setFilter: (filter) => save({ filter }),
  };
});

/** Test helper: every sidebar store back to its first state (and the preferences re-read). */
export function __resetSidebarState(): void {
  usePendingShelf.setState({ pending: [] }, true);
  useWorkingSince.setState({ since: {} }, true);
  useSidebarPrefs.setState(readPrefs());
  commandDeps = defaultCommandDeps;
  clock = () => Date.now();
}
