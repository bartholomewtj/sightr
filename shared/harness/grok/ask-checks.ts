// Checked state for Grok checkbox rows the card's own scrollbar has not painted.
//
// The glyph is the source of truth while the row is on screen. Once it scrolls off, a pure re-parse
// would report it unchecked and the toggle walk would treat that as drift. Remember the last glyph
// per pane, catalog, and step. The screen still wins the moment the row is painted again.

import { currentAskPane } from "../ask-pane";

const memory = new Map<string, Map<number, boolean>>();

function bucket(catalogId: string, step: number): Map<number, boolean> | null {
  const paneId = currentAskPane();
  if (paneId === null) return null;
  const key = `${paneId}\0${catalogId}\0${step}`;
  let mem = memory.get(key);
  if (!mem) {
    mem = new Map();
    memory.set(key, mem);
  }
  return mem;
}

/**
 * Overlay remembered checks onto options that are not in `painted`. Painted rows update the memory
 * and keep the glyph. No pane scope (a unit test, a parse outside the view) leaves `options` as-is.
 */
export function overlayChecks<T extends { n: number; checked: boolean }>(
  catalogId: string,
  step: number,
  options: T[],
  painted: Set<number>,
): T[] {
  const mem = bucket(catalogId, step);
  if (!mem) return options;
  return options.map((o) => {
    if (painted.has(o.n)) {
      mem.set(o.n, o.checked);
      return o;
    }
    const prev = mem.get(o.n);
    return prev === undefined ? o : { ...o, checked: prev };
  });
}
