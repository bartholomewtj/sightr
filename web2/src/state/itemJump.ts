// "Open this message": the palette's Messages results (and anything else that knows a thread id and an
// item id) ask the open timeline to bring one item into view. The request outlives the navigation: the
// timeline of the target thread picks it up once it has the item (paging older history if needed),
// scrolls to it, rings the row for a moment and clears the request.
import { create } from "zustand";

interface ItemJumpState {
  threadId: string | null;
  itemId: string | null;
  /** Bumps on every request so asking for the same item twice jumps twice. */
  nonce: number;
  /** When it was asked, so a request nobody picked up (a CLI-first thread) does not fire much later. */
  at: number;
}

const NONE = { threadId: null, itemId: null };

export const ITEM_JUMP_TTL_MS = 30_000;

export const useItemJumpStore = create<ItemJumpState>(() => ({ ...NONE, nonce: 0, at: 0 }));

export function requestItemJump(threadId: string, itemId: string): void {
  useItemJumpStore.setState((s) => ({ threadId, itemId, nonce: s.nonce + 1, at: Date.now() }));
}

export function clearItemJump(): void {
  useItemJumpStore.setState({ ...NONE });
}
