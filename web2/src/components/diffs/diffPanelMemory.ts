// Sightr code (T27). What the Diff panel remembers while its sheet is closed (a phone sheet is not kept
// mounted, as `navMemory` in GitPanel.tsx and `useScrollMemory`): per thread and scope, which files were
// unfolded, whether the tree was open and which of its folders were folded, and where the page was
// scrolled. In memory for the life of the page, like those.
//
// Scroll is kept as a file header plus an offset into that file, not a raw `scrollTop`: the diffs mount in
// windows and a window not yet drawn holds an estimated height, so the same `scrollTop` lands in a
// different place once the content settles. The file is the stable thing.
import { scopeKey, type DiffScope } from "@/diffPanelStore";

export interface DiffMemory {
  /** null: the default (the revealed file, or all files when there are 3 or fewer) has not been applied yet. */
  unfolded: string[] | null;
  /** null: the first visit (the tree is open); a pick folds it. */
  treeOpen: boolean | null;
  collapsedDirs: string[];
  anchor: { path: string; offset: number } | null;
}

const memory = new Map<string, DiffMemory>();

export const diffMemoryKey = (threadId: string, scope: DiffScope) => `diff:${threadId}:${scopeKey(scope)}`;

export function readDiffMemory(key: string): DiffMemory {
  return memory.get(key) ?? { unfolded: null, treeOpen: null, collapsedDirs: [], anchor: null };
}

export function writeDiffMemory(key: string, patch: Partial<DiffMemory>): void {
  memory.set(key, { ...readDiffMemory(key), ...patch });
}

/** Test helper. */
export function __resetDiffMemory(): void {
  memory.clear();
}

const USER_INPUT = ["touchstart", "wheel", "pointerdown", "keydown"] as const;
/** Give up restoring after this long (the content never got tall enough, or the operator moved on). */
export const ANCHOR_GIVE_UP_MS = 3_000;

const sectionTop = (scroller: HTMLElement, section: HTMLElement) => section.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;

/** The file section at the top of the scroller and how far into it the top edge is. */
export function readAnchor(scroller: HTMLElement): { path: string; offset: number } | null {
  const top = scroller.getBoundingClientRect().top;
  for (const el of scroller.querySelectorAll<HTMLElement>("[data-diff-file]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top + 1) return { path: el.dataset.diffFile ?? "", offset: Math.max(0, Math.round(top - r.top)) };
  }
  return null;
}

/**
 * Restore `key`'s anchor on `scroller` and keep recording it. The restore repeats while the content grows
 * (patches arrive after the list) and stops at the first success, at the operator's first touch, or after
 * {@link ANCHOR_GIVE_UP_MS}. `restore: false` only records (a reveal asked for another place, so the remembered
 * one must not win). `stopRestoring` ends a restore in progress, for a reveal that arrives while it runs.
 */
export interface AnchorMemory {
  detach: () => void;
  stopRestoring: () => void;
}

export function attachAnchorMemory(scroller: HTMLElement, key: string, opts: { restore?: boolean } = {}): AnchorMemory {
  const target = readDiffMemory(key).anchor;
  let restoring = opts.restore !== false && target !== null && (target.path !== "" || target.offset > 0);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;
  let frame = 0;

  const stopRestoring = () => {
    if (!restoring) return;
    restoring = false;
    observer?.disconnect();
    if (timer !== null) clearTimeout(timer);
    for (const type of USER_INPUT) scroller.removeEventListener(type, stopRestoring);
  };
  const apply = () => {
    if (!restoring || !target) return;
    const section = Array.from(scroller.querySelectorAll<HTMLElement>("[data-diff-file]")).find((el) => el.dataset.diffFile === target.path);
    if (!section) return;
    const wanted = Math.max(0, sectionTop(scroller, section) + target.offset);
    scroller.scrollTop = wanted;
    if (Math.abs(scroller.scrollTop - wanted) < 2) stopRestoring();
  };
  const onScroll = () => {
    if (restoring || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const anchor = readAnchor(scroller);
      if (anchor) writeDiffMemory(key, { anchor });
    });
  };

  scroller.addEventListener("scroll", onScroll, { passive: true });
  if (restoring) {
    for (const type of USER_INPUT) scroller.addEventListener(type, stopRestoring, { passive: true });
    observer = new MutationObserver(apply);
    observer.observe(scroller, { childList: true, subtree: true });
    timer = setTimeout(stopRestoring, ANCHOR_GIVE_UP_MS);
    apply();
  }
  return {
    stopRestoring,
    detach: () => {
      stopRestoring();
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
    },
  };
}
