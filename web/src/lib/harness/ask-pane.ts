// Which pane a Grok ask parse is for, and the pending question catalog the journal stored for it.
//
// The phone builds blocks from the screen, then the race guard builds them again from a fresh read.
// Both have to see the same catalog or a tap on a row the screen never painted fails the identity
// check. The catalog is keyed by pane. `withAskPane` says which pane the parse on the stack is for;
// outside that stack `currentAskCatalog` is null, so a test that only has a screen stays screen-only.

const paneStack: string[] = [];
const catalogs = new Map<string, unknown>();

/** Run `fn` as a parse of `paneId`. Nested calls restore the previous pane. */
export function withAskPane<T>(paneId: string, fn: () => T): T {
  paneStack.push(paneId);
  try {
    return fn();
  } finally {
    paneStack.pop();
  }
}

/** Remember `catalog` for `paneId`. `null` clears it (the question was answered, or the log has none). */
export function setPaneAskCatalog(paneId: string, catalog: unknown): void {
  if (catalog === null) catalogs.delete(paneId);
  else catalogs.set(paneId, catalog);
}

/** The catalog for the pane currently inside `withAskPane`, or null when there is no pane scope. */
export function currentAskCatalog<T>(): T | null {
  const paneId = paneStack[paneStack.length - 1];
  if (paneId === undefined) return null;
  return (catalogs.get(paneId) as T | undefined) ?? null;
}

/** The pane id currently inside `withAskPane`, or null. */
export function currentAskPane(): string | null {
  return paneStack[paneStack.length - 1] ?? null;
}
