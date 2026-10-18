// Sightr: bring one item into view when the palette's Messages result (or any `requestItemJump`) asks.
// Same moves as find's navigation (`useThreadFindNavigation`): open the fold or tool group that hides
// the item (`findRevealPlan`), then `scrollToIndex` through the windowed list. Beyond find it pages
// older history until the item is loaded (a hit is often far back), rings the row for a moment, and
// says so when the item is gone (pruned) or out of reach: the thread then stays where it opened.
import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { showToast } from "@/components/toast";
import { clearItemJump, ITEM_JUMP_TTL_MS, useItemJumpStore } from "@/state/itemJump";
import { loadOlderHistory } from "@/state/timeline";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { findRevealPlan, findRowIndex } from "./threadFind";
import { openForFind } from "./useThreadFindNavigation";

/** Pages of older history one jump may pull before it gives up (5 runs a page). */
export const JUMP_MAX_PAGES = 40;
export const JUMP_RING_MS = 2_400;
const SETTLE_FRAMES = 40;

export function useItemJump({
  threadId,
  container,
  rows,
  itemRunId,
  hasItem,
  synchronized,
  historyCursor,
  historyStatus,
  historyError,
  deriveAllOpenRows,
  listRef,
}: {
  threadId: string;
  container: HTMLElement | null;
  rows: readonly MessagesTimelineRow[];
  /** The run the wanted item belongs to, or undefined when it is not loaded (null: no run). */
  itemRunId: (itemId: string) => string | null | undefined;
  hasItem: (itemId: string) => boolean;
  synchronized: boolean;
  historyCursor: string | null;
  historyStatus: string;
  historyError: string | null;
  deriveAllOpenRows: () => readonly MessagesTimelineRow[];
  listRef: RefObject<LegendListRef | null>;
}): boolean {
  const jump = useItemJumpStore((s) => (s.threadId === threadId ? s : null));
  const itemId = jump?.itemId ?? null;
  const nonce = jump?.nonce ?? 0;
  const at = jump?.at ?? 0;
  const key = itemId === null ? null : `${nonce}:${itemId}`;
  const pages = useRef({ key: null as string | null, n: 0 });
  const opened = useRef<string | null>(null);
  const landing = useRef<string | null>(null);
  // The history store frees its in-flight slot a beat after it reports idle, so the next page is asked
  // for when the previous request has fully settled, not on the status change.
  const [settled, setSettled] = useState(0);
  const pending = useRef<{ raf: number | null; ring: ReturnType<typeof setTimeout> | null }>({ raf: null, ring: null });
  useEffect(
    () => () => {
      if (pending.current.raf !== null) cancelAnimationFrame(pending.current.raf);
      if (pending.current.ring !== null) clearTimeout(pending.current.ring);
      document.querySelectorAll("[data-item-jump]").forEach((el) => el.removeAttribute("data-item-jump"));
    },
    [],
  );

  const rowIndex = itemId === null ? -1 : findRowIndex(rows, itemId);
  const loaded = itemId !== null && hasItem(itemId);

  useEffect(() => {
    if (key === null || itemId === null) return;
    if (Date.now() - at > ITEM_JUMP_TTL_MS) return clearItemJump();
    if (!synchronized) return;
    if (pages.current.key !== key) pages.current = { key, n: 0 };

    const giveUp = (why: string) => {
      showToast(why, "info", { key: "item-jump" });
      clearItemJump();
    };

    if (!loaded) {
      if (historyCursor === null) return giveUp("That message is no longer in this thread.");
      if (historyError !== null || historyStatus === "error") return giveUp("Couldn't load earlier messages to find it.");
      if (historyStatus !== "idle") return;
      if (pages.current.n >= JUMP_MAX_PAGES) return giveUp("That message is too far back to open. Scroll up to find it.");
      pages.current.n += 1;
      void loadOlderHistory(threadId).finally(() => setSettled((n) => n + 1));
      return;
    }

    if (rowIndex < 0) {
      // Loaded but folded: open its run and group once; if it still has no row, it is not shown (a
      // hidden thought, say).
      if (opened.current === key) return giveUp("That message isn't shown in the timeline.");
      opened.current = key;
      const plan = findRevealPlan(deriveAllOpenRows(), itemId, itemRunId(itemId) ?? null);
      if (plan.runIds.length === 0 && plan.groupIds.length === 0) return giveUp("That message isn't shown in the timeline.");
      openForFind(threadId, plan.runIds, plan.groupIds);
      return;
    }

    if (landing.current === key) return;
    landing.current = key;
    const rowId = rows[rowIndex]!.id;
    let frame = 0;
    const selector = `[data-timeline-row-id="${CSS.escape(rowId)}"]`;
    // The list mounts the row a frame or two after the scroll (and may still be settling its first
    // layout), so ask again until the row is in the DOM, then ring it. The loop outlives this effect's
    // re-runs (rows change on every stream event); only unmount stops it.
    const settle = () => {
      pending.current.raf = null;
      const el = container?.querySelector<HTMLElement>(selector);
      if (!el) {
        if (frame++ >= SETTLE_FRAMES) return clearItemJump();
        void listRef.current?.scrollToIndex({ index: rowIndex, animated: false, viewPosition: 0.3 });
        pending.current.raf = requestAnimationFrame(settle);
        return;
      }
      el.scrollIntoView?.({ block: "center" });
      el.setAttribute("data-item-jump", "true");
      clearItemJump();
      pending.current.ring = setTimeout(() => el.removeAttribute("data-item-jump"), JUMP_RING_MS);
    };
    void listRef.current?.scrollToIndex({ index: rowIndex, animated: false, viewPosition: 0.3 });
    pending.current.raf = requestAnimationFrame(settle);
    // `rows` changes on every stream event; the request key and what it needs decide.
  }, [key, loaded, rowIndex, synchronized, historyCursor, historyStatus, historyError, threadId, container, settled]);

  return itemId !== null;
}
