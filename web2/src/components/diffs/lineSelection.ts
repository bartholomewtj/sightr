// Sightr code (T29). The range logic behind line comments: pure functions over a parsed file, with no DOM.
//
// A range lives on one side, `old` (deleted and context rows, old numbers) or `new` (added and context rows, new
// numbers), set by the first row tapped. Rows with no number on that side are skipped. A range never spans two
// hunks: a tap in another hunk moves the anchor. At most 12 lines.
import type { DiffLineRef, DiffSide } from "./DiffCodeView.tsx";
import type { ParsedHunk, ParsedLine, ParsedPatchFile } from "./parsePatch.ts";
import { blockHash, MAX_QUOTE_LINES } from "@/lib/reviewCommentContext";

export { MAX_QUOTE_LINES as MAX_RANGE_LINES } from "@/lib/reviewCommentContext";

/** The gesture's state: where it started and where it is now, on one side, inside one hunk. */
export interface Gesture {
  side: DiffSide;
  /** The line the first tap named (stays put while the range grows either way). */
  anchor: number;
  /** The line the latest tap named. */
  head: number;
  hunk: number;
}

export interface Range {
  side: DiffSide;
  start: number;
  end: number;
}

/** This line's number on `side`, or undefined when it is not part of that side. */
export function numberOn(line: ParsedLine, side: DiffSide): number | undefined {
  if (side === "old") return line.kind === "add" ? undefined : line.oldLine;
  return line.kind === "del" ? undefined : line.newLine;
}

/** The hunk and row a tapped gutter names, or null (a line of revealed unchanged context is not in any hunk). */
export function findRow(file: ParsedPatchFile, at: Pick<DiffLineRef, "side" | "line">): { hunk: number; line: ParsedLine } | null {
  for (let h = 0; h < file.hunks.length; h++) {
    const hit = (file.hunks[h] as ParsedHunk).lines.find((l) => numberOn(l, at.side) === at.line);
    if (hit) return { hunk: h, line: hit };
  }
  return null;
}

export const rangeOf = (g: Gesture): Range => ({ side: g.side, start: Math.min(g.anchor, g.head), end: Math.max(g.anchor, g.head) });

/** A new gesture on the tapped line, or null when the patch has no such line. */
export function startGesture(file: ParsedPatchFile, at: Pick<DiffLineRef, "side" | "line">): Gesture | null {
  const row = findRow(file, at);
  return row ? { side: at.side, anchor: at.line, head: at.line, hunk: row.hunk } : null;
}

export type Extended = {
  gesture: Gesture;
  /** The range stopped at the 12-line limit. */
  limited: boolean;
  /** The tapped row has no number on the gesture's side, or is not in the patch: nothing changed. */
  skipped: boolean;
  /** `skipped` because the row is not in any hunk (a line of opened unchanged context). */
  outside?: boolean;
};

/**
 * A tap while a range is open (shift-click, or any tap on a phone): the range grows to the tapped row's number on
 * the gesture's side. A row with no number there is skipped; a row in another hunk moves the anchor there; a range
 * past 12 lines stops at 12.
 */
export function extendGesture(file: ParsedPatchFile, g: Gesture, at: Pick<DiffLineRef, "side" | "line">): Extended {
  const row = findRowFor(file, g, at);
  if (!row) return { gesture: g, limited: false, skipped: true, outside: true };
  const n = numberOn(row.line, g.side);
  if (n === undefined) return { gesture: g, limited: false, skipped: true };
  if (row.hunk !== g.hunk) return { gesture: { side: g.side, anchor: n, head: n, hunk: row.hunk }, limited: false, skipped: false };
  const reach = MAX_QUOTE_LINES - 1;
  const head = Math.max(g.anchor - reach, Math.min(g.anchor + reach, n));
  return { gesture: { ...g, head }, limited: head !== n, skipped: false };
}

/** The tapped row, preferring the gesture's own hunk (a run's edits number their lines separately). */
function findRowFor(file: ParsedPatchFile, g: Gesture, at: Pick<DiffLineRef, "side" | "line">): { hunk: number; line: ParsedLine } | null {
  const own = file.hunks[g.hunk];
  const inOwn = own?.lines.find((l) => numberOn(l, at.side) === at.line);
  return inOwn ? { hunk: g.hunk, line: inOwn } : findRow(file, at);
}

/** Back to the anchor line alone ("Clear range"). */
export const clearRange = (g: Gesture): Gesture => ({ ...g, head: g.anchor });

/** The lines of a range as diff excerpt: `+`, `-` or a space, then the full text (a CRLF file's `\r` dropped). Null when the range is not in the patch. */
export function quoteFor(file: ParsedPatchFile, range: Range): string[] | null {
  for (const hunk of file.hunks) {
    const out: string[] = [];
    for (const l of hunk.lines) {
      const n = numberOn(l, range.side);
      if (n !== undefined && n >= range.start && n <= range.end) out.push(prefix(l) + l.text.replace(/\r$/, ""));
    }
    if (out.length === range.end - range.start + 1) return out;
  }
  return null;
}

const prefix = (l: ParsedLine) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ");

export type Anchored = { state: "anchored" } | { state: "moved"; start: number; end: number } | { state: "outdated" };

/**
 * Where a comment's lines are in this patch: the same range with the same hash (`anchored`), else the same run of
 * lines at another place on that side (`moved`, the nearest to where it was), else `outdated`. The hash is over the
 * full lines, prefixes included, so a line that went from context to changed does not match.
 */
export function locateComment(file: ParsedPatchFile, c: { side: DiffSide; start: number; end: number; hash: string }): Anchored {
  const here = quoteFor(file, c);
  if (here && blockHash(here) === c.hash) return { state: "anchored" };
  const len = c.end - c.start + 1;
  let best: { start: number; end: number } | null = null;
  for (const hunk of file.hunks) {
    const rows = hunk.lines.flatMap((l) => {
      const n = numberOn(l, c.side);
      return n === undefined ? [] : [{ n, text: prefix(l) + l.text.replace(/\r$/, "") }];
    });
    for (let i = 0; i + len <= rows.length; i++) {
      const window = rows.slice(i, i + len);
      if (blockHash(window.map((r) => r.text)) !== c.hash) continue;
      const start = (window[0] as { n: number }).n;
      if (!best || Math.abs(start - c.start) < Math.abs(best.start - c.start)) best = { start, end: (window[len - 1] as { n: number }).n };
    }
  }
  return best ? { state: "moved", ...best } : { state: "outdated" };
}
