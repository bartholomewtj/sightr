// Sightr code (T25). Pure row model for the hand-rolled adapter (hand.tsx): numbered lines from
// `parsePatch`, a split pairing, and the unchanged lines between hunks once the caller has the file (T28: in steps of
// 20, from either end of a gap or all at once, behind a check that the file is still the one the diff was made from).
import type { ParsedHunk, ParsedLine, ParsedPatchFile } from "../parsePatch.ts";

export type LineRow = { type: "line"; key: string; line: ParsedLine };
/**
 * The controls for what is still hidden in gap `index` (0 = before the first hunk, n = after hunk n). `hidden` is how many lines
 * remain (null for the tail until the file text is known); `up` reveals lines above the next hunk, `down` below the previous one.
 */
export type GapRow = { type: "gap"; key: string; index: number; hidden: number | null; up: boolean; down: boolean };
export type HunkRow = { type: "hunk"; key: string; header: string };
export type Row = HunkRow | GapRow | LineRow;
export type PairRow = { type: "pair"; key: string; left?: ParsedLine; right?: ParsedLine };
export type SplitRow = HunkRow | GapRow | PairRow;

const prefixOf = (l: ParsedLine) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ");
export const linePrefix = prefixOf;

/** One "more" tap reveals this many lines (T28). */
export const EXPAND_STEP = 20;

/** Lines of gap `index` already shown: `top` below the hunk before it, `bottom` above the hunk after it. */
export type GapReveal = { top: number; bottom: number };
export type Reveals = ReadonlyMap<number, GapReveal>;
export const NO_REVEALS: Reveals = new Map();

/** A gap in new-file line numbers (inclusive; `to` is Infinity for the tail). An old-side number is the new one minus `delta`. */
export type Span = { from: number; to: number; delta: number };

/**
 * The unchanged lines before the first hunk, between hunks and after the last, as new-file spans. A header `+c,0` (or `-a,0`)
 * names the line *before* an empty side, so that side's first line is `start + 1` (a context-free diff, a whole-file deletion or a
 * pure insertion). The old-side and new-side gaps must be the same length; when they are not (or a hunk's body disagrees with
 * its header), the file's numbers cannot be trusted and there are no gaps to open: null.
 */
export function gapSpans(file: ParsedPatchFile): Span[] | null {
  const spans: Span[] = [];
  let newNext = 1;
  let oldNext = 1;
  for (const h of file.hunks) {
    if (h.mismatch || !/^@@ -\d/.test(h.header)) return null; // a bare `@@ @@` header has no numbers to place a gap by
    const newFirst = h.newCount === 0 ? h.newStart + 1 : h.newStart;
    const oldFirst = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart;
    const len = newFirst - newNext;
    if (len < 0 || len !== oldFirst - oldNext) return null;
    spans.push({ from: newNext, to: newFirst - 1, delta: newNext - oldNext });
    newNext = newFirst + h.newCount;
    oldNext = oldFirst + h.oldCount;
  }
  spans.push({ from: newNext, to: Infinity, delta: newNext - oldNext });
  return spans;
}

/** How many lines gap `span` holds in a file of `total` lines (the tail runs to the end of the file); null while the tail's length is unknown. */
export function gapLength(span: Span, total: number | undefined): number | null {
  if (span.to !== Infinity) return span.to - span.from + 1;
  return total === undefined ? null : Math.max(0, total - span.from + 1);
}

/**
 * The file text as lines: split on `\r?\n`, a final empty piece after a trailing newline is not a line, an unterminated last
 * line is. (A CRLF file keeps no `\r` in the lines it reveals.)
 */
export function splitFileText(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const strip = (s: string) => s.replace(/\r$/, "");
const squash = (s: string) => s.replace(/\s+/g, "");
const sameLine = (a: string, b: string) => strip(a) === strip(b) || squash(a) === squash(b);

/**
 * Whether the file on disk no longer matches the diff: the first and last line of each hunk's new side (context and additions)
 * are compared with the text at the numbered position. A line that differs only in whitespace passes (under `-w` the host
 * prints a context line from the old file), so a whitespace-only drift is not caught; a shift of lines is.
 */
export function staleAgainst(file: ParsedPatchFile, newLines: readonly string[]): boolean {
  for (const h of file.hunks) {
    const side = h.lines.filter((l) => l.kind !== "del");
    const ends = side.length > 1 ? [side[0], side[side.length - 1]] : side;
    for (const l of ends) {
      const actual = l?.newLine === undefined ? undefined : newLines[l.newLine - 1];
      if (l === undefined || actual === undefined || !sameLine(l.text, actual)) return true;
    }
  }
  return false;
}

/**
 * The reveal after a tap on a gap's control (`down`: below the previous hunk, `up`: above the next one, `all`), clamped to the gap.
 * The gap before the first hunk has no hunk above it, so all of it is revealed from the bottom (`head`).
 */
export function revealMore(prev: GapReveal | undefined, how: "down" | "up" | "all", len: number, head = false): GapReveal {
  const top = prev?.top ?? 0;
  const bottom = prev?.bottom ?? 0;
  if (how === "all") return head ? { top: 0, bottom: len } : { top: len, bottom: 0 };
  if (how === "down") return { top: Math.min(len - bottom, top + EXPAND_STEP), bottom };
  return { top, bottom: Math.min(len - top, bottom + EXPAND_STEP) };
}

export type StackedOptions = {
  /** The host cut the patch: the tail is unknown, so there is no control (and nothing) after the last hunk. */
  truncated?: boolean;
  /** False: no controls at all (no way to load the file, or the file cannot be expanded). Default true. */
  controls?: boolean;
  /** Revealed lines keep their identity between calls, so a window's highlight stays attached to them. */
  cache?: Map<string, ParsedLine>;
};

/**
 * Stacked rows. `newLines` (the whole new file, split on newline) fills the lines revealed in `reveals`; without it each gap is
 * one row of controls saying how many lines it hides. The tail gap's size is unknown until the text is.
 */
export function stackedRows(file: ParsedPatchFile, newLines?: readonly string[], reveals: Reveals = NO_REVEALS, opts: StackedOptions = {}): Row[] {
  const rows: Row[] = [];
  const nothingToOpen = file.status === "added" || file.status === "deleted"; // nothing is unchanged in a new or removed file
  const spans = opts.controls === false || nothingToOpen || file.hunks.length === 0 ? null : gapSpans(file);
  const cache = opts.cache;
  const revealed = (index: number, n: number, delta: number): LineRow => {
    const key = `g${index}:${n}`;
    const text = newLines?.[n - 1] ?? "";
    let l = cache?.get(key);
    if (!l || l.text !== text || l.oldLine !== n - delta) {
      l = { kind: "context", text, newLine: n, oldLine: n - delta };
      cache?.set(key, l);
    }
    return { type: "line", key, line: l };
  };
  const gap = (index: number) => {
    const span = spans?.[index];
    if (!span || (index === file.hunks.length && opts.truncated)) return;
    const len = gapLength(span, newLines?.length);
    if (len === 0) return;
    const up = index < file.hunks.length;
    const down = index > 0;
    if (len === null) {
      rows.push({ type: "gap", key: `gap${index}`, index, hidden: null, up, down });
      return;
    }
    const r = reveals.get(index);
    const top = down ? Math.min(r?.top ?? 0, len) : 0;
    const bottom = up ? Math.min(r?.bottom ?? 0, len - top) : 0;
    for (let n = span.from; n < span.from + top; n++) rows.push(revealed(index, n, span.delta));
    if (len - top - bottom > 0) rows.push({ type: "gap", key: `gap${index}`, index, hidden: len - top - bottom, up, down });
    for (let n = span.from + len - bottom; n < span.from + len; n++) rows.push(revealed(index, n, span.delta));
  };
  file.hunks.forEach((h: ParsedHunk, i) => {
    gap(i);
    rows.push({ type: "hunk", key: `h${i}`, header: h.header });
    h.lines.forEach((line, j) => rows.push({ type: "line", key: `h${i}:${j}`, line }));
  });
  if (file.hunks.length > 0) gap(file.hunks.length);
  return rows;
}

/**
 * Split layout: within a hunk, a run of removals is paired one to one, in order, with the additions that follow it; the longer
 * run's surplus pairs with an empty cell. A removal after an addition starts a new run. Context sits on both sides. A line
 * that the diff marks `\ No newline at end of file` stays on its own side.
 */
export function splitRows(rows: Row[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: ParsedLine[] = [];
  let adds: ParsedLine[] = [];
  let run = 0;
  const flush = (key: string) => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ type: "pair", key: `${key}:r${run}:p${i}`, left: dels[i], right: adds[i] });
    if (dels.length > 0 || adds.length > 0) run++;
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.type !== "line") { flush(row.key); out.push(row); continue; }
    const l = row.line;
    if (l.kind === "del") {
      if (adds.length > 0) flush(row.key);
      dels.push(l);
    } else if (l.kind === "add") adds.push(l);
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
  // A context pair draws its line on both sides, so it counts twice: split view must not double a window's nodes past the budget.
  if (row.type === "pair") return (row.left?.text.length ?? 0) + (row.right?.text.length ?? 0);
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
