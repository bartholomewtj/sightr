import { useSyncExternalStore } from "react";
let required = false;
const listeners = new Set<() => void>();
export function noteLockRequired(): void { required = true; listeners.forEach((fn) => fn()); }
export function clearLockRequired(): void { required = false; listeners.forEach((fn) => fn()); }
export function useLockRequired(): boolean {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => required, () => false);
}
