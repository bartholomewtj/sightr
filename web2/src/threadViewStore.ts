/**
 * A thread's main view: its timeline ("thread") or the pane's live terminal ("cli").
 *
 * A thread with no transcript (`capabilities.hasJournal` false: a bare shell, a harness this bridge
 * tails no journal for, or any thread while transcripts are off) has nothing in its timeline but the
 * lines Sightr sent, so it opens on the CLI, and a header toggle flips it back. A thread with a
 * transcript keeps its timeline, and its terminal stays the right-panel tab. The flip is remembered per
 * thread for the page only; a reload goes back to the default.
 *
 * While a thread's main view is the CLI, the paths that open the terminal (the composer's Type, Open
 * terminal on a password card, the palette, ctrl+` and ctrl+j, a spawn's Open terminal) land on it
 * instead of opening a second mirror of the same pane in the panel or a sheet.
 */
import { create } from "zustand";

import { openRightPanelSurface, toggleRightPanelSurface, useRightPanelStore } from "@/rightPanelStore";
import { useShell, useThreadStore } from "@/stream/stores";

export type ThreadView = "thread" | "cli";

interface ThreadViewState {
  /** The view the operator picked, per thread id. Only CLI-first threads read it. */
  chosen: Record<string, ThreadView>;
  setView: (threadId: string, view: ThreadView) => void;
}

export const useThreadViewStore = create<ThreadViewState>()((set) => ({
  chosen: {},
  setView: (threadId, view) => set((s) => ({ chosen: { ...s.chosen, [threadId]: view } })),
}));

/** The view a thread is on: the operator's pick, or the CLI when it has no transcript. */
export function resolveThreadView(hasJournal: boolean | undefined, chosen: ThreadView | undefined): ThreadView {
  // Unknown capabilities (the thread is not loaded yet) keep the timeline, which shows its skeleton.
  if (hasJournal !== false) return "thread";
  return chosen ?? "cli";
}

/** `hasJournal` for a thread from the sidebar, else the open thread's stream; undefined while unknown. */
function hasJournalOf(threadId: string): boolean | undefined {
  const fromShell = useShell.getState().threads[threadId]?.capabilities.hasJournal;
  if (fromShell !== undefined) return fromShell;
  const current = useThreadStore.getState().current;
  return current?.threadId === threadId ? current.thread?.capabilities.hasJournal : undefined;
}

/** `cliFirst`: the thread has no transcript, so the CLI is its home and the toggle shows. */
export function useThreadView(threadId: string): { view: ThreadView; cliFirst: boolean } {
  const fromShell = useShell((s) => s.threads[threadId]?.capabilities.hasJournal);
  const fromStream = useThreadStore((s) => (s.current?.threadId === threadId ? s.current.thread?.capabilities.hasJournal : undefined));
  const chosen = useThreadViewStore((s) => s.chosen[threadId]);
  const hasJournal = fromShell ?? fromStream;
  return { view: resolveThreadView(hasJournal, chosen), cliFirst: hasJournal === false };
}

/** The view `threadId` is on now, outside React. */
export function threadViewOf(threadId: string): ThreadView {
  return resolveThreadView(hasJournalOf(threadId), useThreadViewStore.getState().chosen[threadId]);
}

/** Show the CLI as the thread's main view, closing a phone sheet that would cover it. */
function showCli(threadId: string): void {
  useThreadViewStore.getState().setView(threadId, "cli");
  useRightPanelStore.getState().closeSheet();
}

/**
 * Open the thread's terminal where it lives: the main view for a thread with no transcript, otherwise
 * the right-panel tab (a sheet on a phone).
 */
export function openThreadTerminal(threadId: string | null | undefined): void {
  if (threadId && hasJournalOf(threadId) === false) showCli(threadId);
  else openRightPanelSurface("terminal");
}

/** `terminal.toggle`: flip a CLI-first thread between CLI and timeline; otherwise toggle the tab. */
export function toggleThreadTerminal(threadId: string | null | undefined): void {
  if (threadId && hasJournalOf(threadId) === false) {
    if (threadViewOf(threadId) === "cli") useThreadViewStore.getState().setView(threadId, "thread");
    else showCli(threadId);
  } else toggleRightPanelSurface("terminal");
}

/** Test helper. */
export function __resetThreadViewStore(): void {
  useThreadViewStore.setState({ chosen: {} });
}
