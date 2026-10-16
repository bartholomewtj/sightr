// Adapted from T3 Code apps/web/src/hooks/showThreadUndoNotice.ts @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: one undo at a time (a new one replaces the old; T3 groups same-action undos), no claim
// tokens or Effect results, and `dismissThreadUndoNotice` for a change whose command failed.
import { create } from "zustand";

export const UNDO_NOTICE_MS = 5_000;

export type UndoAction = "Settled" | "Snoozed" | "Unpinned" | "Archived";

export interface UndoNotice {
  /** Unique per notice, so a late failure only dismisses its own. */
  id: number;
  action: UndoAction;
  threadId: string;
  undo: () => Promise<void>;
}

export const useThreadUndoNotice = create<{ notice: UndoNotice | null }>(() => ({ notice: null }));

let expiry: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;

/** Show "<action> · Undo" for 5 s. Returns the notice id. */
export function showThreadUndoNotice(options: Omit<UndoNotice, "id">): number {
  const notice: UndoNotice = { ...options, id: nextId++ };
  clearTimeout(expiry);
  useThreadUndoNotice.setState({ notice });
  expiry = setTimeout(() => {
    if (useThreadUndoNotice.getState().notice?.id === notice.id) useThreadUndoNotice.setState({ notice: null });
  }, UNDO_NOTICE_MS);
  return notice.id;
}

export function dismissThreadUndoNotice(id?: number): void {
  const current = useThreadUndoNotice.getState().notice;
  if (!current || (id !== undefined && current.id !== id)) return;
  clearTimeout(expiry);
  useThreadUndoNotice.setState({ notice: null });
}

/** Run the latest undo (the toast's button, or mod+z). False when there is none. */
export function undoLatestThreadAction(): boolean {
  const notice = useThreadUndoNotice.getState().notice;
  if (!notice) return false;
  // Consume first, so a second click or shortcut cannot restore twice.
  dismissThreadUndoNotice(notice.id);
  void notice.undo();
  return true;
}

/** Test helper. */
export function __resetThreadUndoNotice(): void {
  clearTimeout(expiry);
  useThreadUndoNotice.setState({ notice: null });
}
