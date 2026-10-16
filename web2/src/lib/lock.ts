// Copied from web/src/lib/lock.ts: a module flag any request can raise when the bridge answers a
// lock refusal, so the root layout swaps the app for the unlock prompt.
import { useSyncExternalStore } from "react";

let required = false;
const listeners = new Set<() => void>();

export function noteLockRequired(): void {
  required = true;
  listeners.forEach((fn) => fn());
}

export function clearLockRequired(): void {
  required = false;
  listeners.forEach((fn) => fn());
}

export function useLockRequired(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => required,
    () => false,
  );
}
