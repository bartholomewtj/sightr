// The find bar owns its open state; this bridge lets the desktop hotkey request it.
const listeners = new Set<() => void>();
export function onFindOpenRequest(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function requestFindOpen(): void { for (const fn of listeners) fn(); }
