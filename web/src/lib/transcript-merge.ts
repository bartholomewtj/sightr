import type { TranscriptEntry } from "./types";

/**
 * Splice a freshly fetched newest page into the turns already held. Pure.
 *
 * Overlapping turns (same uuid) take the fresh copy; turns after the overlap append. When nothing
 * overlaps the pane is on a different session (or has moved further than a page since the last
 * look), and the fresh page replaces everything — stitching would show two conversations as one.
 */
export function mergeNewest(prev: TranscriptEntry[], fresh: TranscriptEntry[]): TranscriptEntry[] {
  if (prev.length === 0) return fresh;
  const freshIds = new Set(fresh.map((e) => e.uuid));
  const firstOverlap = prev.findIndex((e) => freshIds.has(e.uuid));
  if (firstOverlap === -1) return fresh;
  const k = fresh.findIndex((e) => e.uuid === prev[firstOverlap]!.uuid);
  return [...prev.slice(0, firstOverlap), ...fresh.slice(k)];
}
