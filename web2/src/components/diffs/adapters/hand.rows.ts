// Sightr code (T25). Pure row model for the hand-rolled adapter (hand.tsx): numbered lines from
// `parsePatch`, a split pairing, and the unchanged lines between hunks once the caller has the file.
import type { ParsedHunk, ParsedLine, ParsedPatchFile } from "../parsePatch.ts";

export type LineRow = { type: "line"; key: string; line: ParsedLine };
/** `index` names the gap: 0 = before the first hunk, n = after hunk n. `hidden` is null before the file text is known. */
export type GapRow = { type: "gap"; key: string; index: number; hidden: number | null };
export type HunkRow = { type: "hunk"; key: string; header: string };
export type Row = HunkRow | GapRow | LineRow;
export type PairRow = { type: "pair"; key: string; left?: ParsedLine; right?: ParsedLine };
export type SplitRow = HunkRow | GapRow | PairRow;

const prefixOf = (l: ParsedLine) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ");
export const linePrefix = prefixOf;

type Span = { from: number; to: number };

/** New-file line numbers hidden before the first hunk, between hunks and after the last (`to` Infinity until the length is known). */
function gapSpans(file: ParsedPatchFile): Span[] {
  const spans: Span[] = [];
  let next = 1;
  for (const h of file.hunks) {
    spans.push({ from: next, to: h.newStart - 1 });
    next = h.newStart + h.newCount;
  }
  spans.push({ from: next, to: Infinity });
  return spans;
}

/** Old-side line number for a new-side line inside gap `index`. */
function oldOffset(file: ParsedPatchFile, index: number): number {
  const h = file.hunks[index - 1];
  return h ? h.oldStart + h.oldCount - (h.newStart + h.newCount) : 0;
}

/**
 * Stacked rows. `newLines` (the whole new file, split on newline) fills the gaps in `revealed`; without it a
 * gap is one expandable row saying how many lines it hides. The tail gap's size is unknown until the text is.
 */
export function stackedRows(file: ParsedPatchFile, newLines?: string[], revealed: ReadonlySet<number> = new Set()): Row[] {
  const rows: Row[] = [];
  const spans = gapSpans(file);
  const gap = (index: number) => {
    if (file.status === "added" || file.status === "deleted") return; // nothing is unchanged in a new or removed file
    const s = spans[index] as Span;
    const to = Math.min(s.to, newLines ? newLines.length : s.to);
    const hidden = to === Infinity ? null : Math.max(0, to - s.from + 1);
    if (hidden === 0) return;
    if (newLines && revealed.has(index)) {
      for (let n = s.from; n <= to; n++) {
        rows.push({ type: "line", key: `g${index}:${n}`, line: { kind: "context", text: newLines[n - 1] ?? "", newLine: n, oldLine: n + oldOffset(file, index) } });
      }
    } else if (file.hunks.length > 0) {
      rows.push({ type: "gap", key: `gap${index}`, index, hidden });
    }
  };
  file.hunks.forEach((h: ParsedHunk, i) => {
    gap(i);
    rows.push({ type: "hunk", key: `h${i}`, header: h.header });
    h.lines.forEach((line, j) => rows.push({ type: "line", key: `h${i}:${j}`, line }));
  });
  if (file.hunks.length > 0) gap(file.hunks.length);
  return rows;
}

/** Split layout: a run of removals is paired with the additions after it; context sits on both sides. */
export function splitRows(rows: Row[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: ParsedLine[] = [];
  let adds: ParsedLine[] = [];
  const flush = (key: string) => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ type: "pair", key: `${key}:p${i}`, left: dels[i], right: adds[i] });
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.type !== "line") { flush(row.key); out.push(row); continue; }
    const l = row.line;
    if (l.kind === "del") dels.push(l);
    else if (l.kind === "add") adds.push(l);
    else { flush(row.key); out.push({ type: "pair", key: row.key, left: l, right: l }); }
  }
  flush("end");
  return out;
}

/** Whether `line` is the one an annotation or tap names (a context line answers to either side). */
export function lineMatches(line: ParsedLine | undefined, side: "old" | "new", n: number): boolean {
  return !!line && (side === "old" ? line.kind !== "add" && line.oldLine === n : line.kind !== "del" && line.newLine === n);
}

/** A window closes at this many rows or {@link WINDOW_MAX_CHARS} characters of line text, whichever comes first (T27). */
export const WINDOW_MAX_ROWS = 60;
export const WINDOW_MAX_CHARS = 12_000;

function textLength(row: Row | SplitRow): number {
  if (row.type === "line") return row.line.text.length;
  if (row.type === "pair") return (row.left?.text.length ?? 0) + (row.right && row.right !== row.left ? row.right.text.length : 0);
  return 0;
}

/**
 * Cut rows into windows that mount one at a time: 60 rows or 12,000 characters of line text, whichever
 * comes first (a file of 400-character lines gets about 30 rows a window). A row longer than the cap
 * still gets a window of its own.
 */
export function windowRows<T extends Row | SplitRow>(rows: readonly T[], maxRows = WINDOW_MAX_ROWS, maxChars = WINDOW_MAX_CHARS): T[][] {
  const windows: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const row of rows) {
    const n = textLength(row);
    if (current.length > 0 && (current.length >= maxRows || chars + n > maxChars)) {
      windows.push(current);
      current = [];
      chars = 0;
    }
    current.push(row);
    chars += n;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

/** The distinct diff lines a window draws, in order (a split pair's context line is one line, not two). */
export function windowLines(rows: readonly (Row | SplitRow)[]): ParsedLine[] {
  const seen = new Set<ParsedLine>();
  const out: ParsedLine[] = [];
  const add = (l: ParsedLine | undefined) => {
    if (l && !seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  };
  for (const r of rows) {
    if (r.type === "line") add(r.line);
    else if (r.type === "pair") {
      add(r.left);
      add(r.right);
    }
  }
  return out;
}
