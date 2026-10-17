// A phone sheet is not kept mounted (RightPanelSheet): closing Files or Git to look at the thread and
// reopening it must not throw the operator back to the top of a long list. Each scroller remembers its
// position per key (kind + thread) for the life of the page and puts it back on mount, waiting for
// async content (a folder listing, a git status) to grow tall enough before it gives up.
import { useCallback } from "react";

const positions = new Map<string, number>();

/** Give up restoring after this long (the content never got tall enough, or the operator moved on). */
export const RESTORE_GIVE_UP_MS = 3_000;
const USER_INPUT = ["touchstart", "wheel", "pointerdown", "keydown"] as const;

export function rememberedScroll(key: string): number {
  return positions.get(key) ?? 0;
}

export function forgetScroll(key?: string): void {
  if (key === undefined) positions.clear();
  else positions.delete(key);
}

/** Restore `key`'s position on `el` and keep recording it. Returns the detach function. */
export function attachScrollMemory(el: HTMLElement, key: string): () => void {
  const target = rememberedScroll(key);
  let restoring = target > 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;

  const stopRestoring = () => {
    if (!restoring) return;
    restoring = false;
    observer?.disconnect();
    if (timer !== null) clearTimeout(timer);
    for (const type of USER_INPUT) el.removeEventListener(type, stopRestoring);
  };
  const apply = () => {
    if (!restoring) return;
    el.scrollTop = target;
    if (Math.abs(el.scrollTop - target) < 2) stopRestoring();
  };
  const onScroll = () => {
    if (!restoring) positions.set(key, el.scrollTop);
  };

  el.addEventListener("scroll", onScroll, { passive: true });
  if (restoring) {
    for (const type of USER_INPUT) el.addEventListener(type, stopRestoring, { passive: true });
    observer = new MutationObserver(apply);
    observer.observe(el, { childList: true, subtree: true });
    timer = setTimeout(stopRestoring, RESTORE_GIVE_UP_MS);
    apply();
  }
  return () => {
    // No final save: by now the node is detached and reads 0; the scroll events already recorded it.
    stopRestoring();
    el.removeEventListener("scroll", onScroll);
  };
}

/** A callback ref for a scroller: `<div ref={useScrollMemory(\`git:${threadId}\`)}>`. */
export function useScrollMemory<T extends HTMLElement>(key: string): (el: T | null) => void {
  return useCallback(
    (el: T | null) => {
      if (!el) return;
      return attachScrollMemory(el, key);
    },
    [key],
  );
}
