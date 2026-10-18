// Sightr code (T29). The Diff panel's comment gestures, per thread, in memory: the range being made (and the note being
// typed into its editor), whether the pending list shows in place of the files, and the line a list row asked to
// scroll to. None of it is persisted: the comments themselves are (state/lineComments.ts).
import { create } from "zustand";

import type { Gesture } from "@/components/diffs/lineSelection";

/** The editor that is open: a range in one file and the note typed so far. `editingId` names a saved comment being changed. */
export interface OpenEditor {
  path: string;
  gesture: Gesture;
  note: string;
  editingId: string | null;
  /** A word under the editor: the 12-line limit, a refusal. Cleared by the next gesture. */
  notice: string | null;
}

export interface LineReveal {
  path: string;
  side: "old" | "new";
  line: number;
  key: number;
}

interface CommentsUiState {
  editor: Record<string, OpenEditor | null>;
  listOpen: Record<string, boolean>;
  reveal: Record<string, LineReveal | null>;
}

const useStore = create<CommentsUiState>(() => ({ editor: {}, listOpen: {}, reveal: {} }));

let nextKey = 1;

/**
 * The note as typed so far. The editor reports every keystroke here instead of into the store, because a store change redraws the
 * diff; the editor reads it back when it remounts (its range moved, so its row did), and a new gesture carries it over.
 */
const live = new Map<string, string>();
export const setLiveNote = (threadId: string, note: string): void => void live.set(threadId, note);
export const currentNote = (threadId: string): string => live.get(threadId) ?? getOpenEditor(threadId)?.note ?? "";

export const useOpenEditor = (threadId: string): OpenEditor | null => useStore((s) => s.editor[threadId] ?? null);
export const getOpenEditor = (threadId: string): OpenEditor | null => useStore.getState().editor[threadId] ?? null;
export function setOpenEditor(threadId: string, editor: OpenEditor | null): void {
  if (editor) live.set(threadId, editor.note);
  else live.delete(threadId);
  useStore.setState((s) => ({ editor: { ...s.editor, [threadId]: editor } }));
}
export function patchOpenEditor(threadId: string, patch: Partial<OpenEditor>): void {
  const cur = getOpenEditor(threadId);
  if (cur) setOpenEditor(threadId, { ...cur, ...patch });
}

export const useCommentsListOpen = (threadId: string): boolean => useStore((s) => s.listOpen[threadId] === true);
export function setCommentsListOpen(threadId: string, open: boolean): void {
  useStore.setState((s) => ({ listOpen: { ...s.listOpen, [threadId]: open } }));
}

export const useLineReveal = (threadId: string): LineReveal | null => useStore((s) => s.reveal[threadId] ?? null);
/** Ask for a line to be scrolled to (the file is unfolded and loaded by the panel). */
export function revealCommentLine(threadId: string, target: Omit<LineReveal, "key">): void {
  useStore.setState((s) => ({ reveal: { ...s.reveal, [threadId]: { ...target, key: nextKey++ } } }));
}

/** The scroll was asked for and done: forget it, so a file that remounts later does not jump again. */
export function clearLineReveal(threadId: string, key: number): void {
  if (useStore.getState().reveal[threadId]?.key === key) useStore.setState((s) => ({ reveal: { ...s.reveal, [threadId]: null } }));
}

export function __resetCommentsUi(): void {
  live.clear();
  useStore.setState({ editor: {}, listOpen: {}, reveal: {} });
}
