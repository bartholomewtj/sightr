/**
 * A `matchMedia` that answers `(min-width: Npx)` / `(max-width: Npx)` against a width tests can move,
 * firing `change` on every live query when it does.
 */
type ChangeListener = (event: { matches: boolean }) => void;

let width = 800;
const queries = new Set<{ media: string; listeners: Set<ChangeListener>; last: boolean }>();

function evaluate(media: string): boolean {
  const min = /min-width:\s*(\d+)px/.exec(media);
  const max = /max-width:\s*(\d+)px/.exec(media);
  if (min && width < Number(min[1])) return false;
  if (max && width > Number(max[1])) return false;
  return Boolean(min || max);
}

export function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) => {
      const entry = { media, listeners: new Set<ChangeListener>(), last: evaluate(media) };
      queries.add(entry);
      return {
        media,
        get matches() {
          return evaluate(media);
        },
        onchange: null,
        addEventListener: (_: string, fn: ChangeListener) => entry.listeners.add(fn),
        removeEventListener: (_: string, fn: ChangeListener) => entry.listeners.delete(fn),
        addListener: (fn: ChangeListener) => entry.listeners.add(fn),
        removeListener: (fn: ChangeListener) => entry.listeners.delete(fn),
        dispatchEvent: () => true,
      };
    },
  });
}

/** Move the viewport and notify every query whose answer changed. */
export function setViewportWidth(px: number): void {
  width = px;
  for (const q of queries) {
    const now = evaluate(q.media);
    if (now === q.last) continue;
    q.last = now;
    for (const fn of q.listeners) fn({ matches: now });
  }
}

export function resetMedia(): void {
  width = 800;
  queries.clear();
}
