import { useSyncExternalStore } from "react";

type PasteHold =
  | { kind: "text"; lines: number; reason: string | null; onSend: () => void; onDiscard: () => void }
  | { kind: "path"; path: string; onSend: () => void; onDiscard: () => void };

let hold: PasteHold | null = null;
const listeners = new Set<() => void>();
function emit() { for (const listener of listeners) listener(); }

export function pasteHold(): PasteHold | null { return hold; }
export function setPasteHold(next: PasteHold | null): void { hold = next; emit(); }
export function clearPasteHold(): void { if (hold === null) return; hold = null; emit(); }
export function usePasteHold(): PasteHold | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, pasteHold, () => null);
}
export function __resetPasteHold(): void { hold = null; }
