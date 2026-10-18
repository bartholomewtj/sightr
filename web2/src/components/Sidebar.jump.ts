// Thread jump (mod+1..9) for the sidebar. Pattern, not a port: the idea is T3 Code's (apps/web/src/
// components/Sidebar.logic.ts `useThreadJumpHintVisibility`, apps/web/src/shortcutModifierState.ts @
// db5919d87; MIT, see THIRD_PARTY.md). The controller that delays the hint by 200 ms is T3's shape;
// the order the numbers follow is Sightr's: what the sidebar shows (a search's results, the Needs-you
// list, or the pinned and active rows of every open project).
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";

import type { Project, Thread } from "@shared/v2/contracts";

import { buildProjectTree, flattenProjectTree, needsYouThreads, searchSidebarThreads, type SidebarFilter } from "./Sidebar.logic";

/** T3's `THREAD_JUMP_HINT_SHOW_DELAY_MS`: a tap on the modifier shows nothing. */
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;

/** The sidebar's search text, shared so the keys and the badges agree with the list on screen. */
export const useSidebarSearch = create<{ query: string; setQuery(query: string): void }>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
}));

/**
 * The thread ids `mod+1..9` jump to, in screen order. A search shows its flat results; the Needs-you filter
 * its flat list (worst first); otherwise the pinned then active rows of each open project (worktrees after
 * their primary), skipping a collapsed project because its rows are not on screen.
 */
export function threadJumpOrder(input: {
  projects: Readonly<Record<string, Project>>;
  threads: readonly Thread[];
  filter: SidebarFilter;
  query: string;
  collapsedProjects: readonly string[];
}): string[] {
  if (input.query.trim()) return searchSidebarThreads(input.threads, input.projects, input.query).map((t) => t.id);
  if (input.filter === "needs-you") return needsYouThreads(input.threads).map((t) => t.id);
  const out: string[] = [];
  for (const node of flattenProjectTree(buildProjectTree(Object.values(input.projects), input.threads))) {
    if (input.collapsedProjects.includes(node.project.id)) continue;
    for (const t of node.shelves.pinned) out.push(t.id);
    for (const t of node.shelves.active) out.push(t.id);
  }
  return out;
}

// ── Hint visibility ──────────────────────────────────────────────────────────────────────────────

export interface ThreadJumpHintVisibilityController {
  sync(shouldShow: boolean): void;
  dispose(): void;
}

/** T3's controller: show the hints once the modifier has been held for `delayMs`, hide them at once on release. */
export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange(visible: boolean): void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearPending = () => {
    if (timer === null) return;
    clearTimeoutFn(timer);
    timer = null;
  };
  return {
    sync(shouldShow) {
      if (!shouldShow) {
        clearPending();
        if (visible) {
          visible = false;
          input.onVisibilityChange(false);
        }
        return;
      }
      if (visible || timer !== null) return;
      timer = setTimeoutFn(() => {
        timer = null;
        visible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: clearPending,
  };
}

export interface ModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export const NO_MODIFIERS: ModifierState = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

const MODIFIER_KEY: Record<string, keyof ModifierState> = {
  Meta: "metaKey",
  OS: "metaKey",
  Command: "metaKey",
  Control: "ctrlKey",
  Alt: "altKey",
  Shift: "shiftKey",
};

/**
 * The modifiers held after a key event. A modifier's own key event sets or clears it (a keyup is trusted over
 * the event's flags, which some platforms leave stale); any other key takes the flags it carries.
 */
export function modifiersAfterKeyEvent(event: Pick<KeyboardEvent, "type" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): ModifierState {
  const own = MODIFIER_KEY[event.key];
  if (own) {
    const held = event.type === "keydown";
    return { metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, [own]: held };
  }
  return { metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey };
}

const sameModifiers = (a: ModifierState, b: ModifierState) =>
  a.metaKey === b.metaKey && a.ctrlKey === b.ctrlKey && a.altKey === b.altKey && a.shiftKey === b.shiftKey;

/** Which modifier keys are down now. A blur or paste resets it: the keyup of a synthetic paste never arrives. */
export function useShortcutModifierState(enabled = true): ModifierState {
  const [state, setState] = useState(NO_MODIFIERS);
  const ref = useRef(NO_MODIFIERS);
  useEffect(() => {
    if (!enabled) {
      ref.current = NO_MODIFIERS;
      setState(NO_MODIFIERS);
      return;
    }
    const update = (next: ModifierState) => {
      if (sameModifiers(ref.current, next)) return;
      ref.current = next;
      setState(next);
    };
    const onKey = (event: KeyboardEvent) => update(modifiersAfterKeyEvent(event));
    const reset = () => update(NO_MODIFIERS);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("paste", reset, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("paste", reset, true);
      window.removeEventListener("blur", reset);
    };
  }, [enabled]);
  return state;
}

/** True while the jump modifier has been held long enough to show the numbers on the rows. */
export function useThreadJumpHintVisibility(): { visible: boolean; sync(shouldShow: boolean): void } {
  const [visible, setVisible] = useState(false);
  const controller = useRef<ThreadJumpHintVisibilityController | null>(null);
  useEffect(() => {
    const c = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: setVisible,
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controller.current = c;
    return () => {
      c.dispose();
      controller.current = null;
    };
  }, []);
  const sync = useCallback((shouldShow: boolean) => controller.current?.sync(shouldShow), []);
  return { visible, sync };
}
