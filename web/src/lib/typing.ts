import { useSyncExternalStore } from "react";

// Whether the operator is typing into a pane right now: editing the composer, or sending text or keys.
// While they are, the open pane's mirror refreshes faster (use-polling.ts TYPING_MS), so what they
// type shows up in the terminal mirror without waiting out the normal cadence. It holds for
// TYPING_HOLD_MS after the last keystroke, then the cadence falls back.

export const TYPING_HOLD_MS = 5_000;

let typing = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (typing === next) return;
  typing = next;
  for (const fn of listeners) fn();
}

/** A keystroke, a composer edit or a send. Starts (or extends) the typing window. */
export function noteTyping(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    set(false);
  }, TYPING_HOLD_MS);
  set(true);
}

export function isTyping(): boolean {
  return typing;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Re-renders when typing starts or stops. */
export function useTyping(): boolean {
  return useSyncExternalStore(subscribe, isTyping, () => false);
}

/** Test helper. */
export function __resetTyping(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  typing = false;
}
