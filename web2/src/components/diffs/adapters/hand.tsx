// Sightr code (T25, windowed by T27, mounted and unmounted on demand by T29). Candidate B: a hand-rolled renderer on
// `parsePatch` with highlight.js loaded per language (hand.highlight.ts). Stacked and split, line numbers, tappable
// gutters, a selection, annotations under a line, and unchanged lines between hunks on request (T28: 20 at a time from either end of a gap, or all of it). Rows mount in windows
// of 60 rows or 4,000 characters of line text; only the first window mounts at once (and only when the caller says
// `eager`), the rest as they come within 800 px of the screen. A window that has gone more than 1,600 px from the
// screen unmounts again and holds the height it measured, so a sweep through a long file stays near the mounted-node
// budget; a window with a selection or an annotation never unmounts. A window highlights its own lines when it
// mounts, in slices of at most 200 lines, and holds the result in its own state, so nothing highlight-related
// outlives the component. Browser find sees only mounted rows, and a window not mounted holds an estimated 20 px a
// row (or the height it had when it unmounted). `revealLine` mounts the target's window, then scrolls to the line.
import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { DiffScrollRootContext, type DiffAdapterCapabilities, type DiffCodeViewProps, type DiffLineRef, type DiffRevealLine, type DiffSide } from "../DiffCodeView.tsx";
import { useParsedFile } from "../parsedFile.ts";
import type { ParsedLine, ParsedPatchFile } from "../parsePatch.ts";
import { highlightLines } from "./hand.highlight.ts";
import { EXPAND_STEP, gapLength, gapSpans, itemHasLine, lineInRange, lineMatches, linePrefix, NO_REVEALS, revealMore, splitFileText, splitRows, stackedRows, staleAgainst, windowLines, windowRows, type GapRow, type Reveals, type Row, type SplitRow } from "./hand.rows.ts";

export const capabilities: DiffAdapterCapabilities = { split: true, expand: true, annotations: true, highlight: true };

// highlight.js classes to the house palette (style/tokens.md), once for the whole file.
const CSS = `.hljs-keyword,.hljs-literal,.hljs-built_in{color:var(--accent)}.hljs-string,.hljs-regexp,.hljs-attr,.hljs-attribute{color:var(--ok)}
.hljs-comment,.hljs-quote,.hljs-meta{color:var(--muted)}.hljs-number,.hljs-title,.hljs-type,.hljs-name,.hljs-section{color:var(--navy)}`;
// Colours as classes (not an inline style per line): 1,500 rows each parsing a color-mix() was the render's biggest cost.
const TINT = { add: "text-[var(--ok)] bg-[color-mix(in_srgb,var(--ok)_14%,transparent)]", del: "text-[var(--warn)] bg-[color-mix(in_srgb,var(--warn)_14%,transparent)]", context: "" } as const;
const SELECTED = "bg-[color-mix(in_srgb,var(--accent)_18%,transparent)]";
const EST_ROW_PX = 20; // an unmounted window's height per row until it has been measured; low for wrapped long lines
/** A window mounts when it comes within this far of the scroller, and unmounts when it has gone this far (the gap stops it flickering at the edge). */
export const MOUNT_MARGIN_PX = 800;
export const UNMOUNT_MARGIN_PX = 1600;
/** A touch is a tap when it moved less than this far and lasted less than this long (T29). */
export const TAP_SLOP_PX = 8;
export const TAP_MAX_MS = 500;


type Highlighted = Map<ParsedLine, ReactNode[]>;
type Item = Row | SplitRow;

type WindowProps = {
  eager: boolean;
  items: Item[];
  path: string;
  /** Changes when the rows would measure differently (wrap, layout): a measured height is then stale. */
  sig: string;
  /** Holds a selection or an annotation: stays mounted wherever it is. */
  pinned: boolean;
  /** Set on the one window that holds the line to reveal. */
  target: DiffRevealLine | undefined;
  renderRow: (item: Item, hl: Highlighted | null) => ReactNode;
};

/** A window of rows: mounts when `eager`, else near the viewport; unmounts again far from it unless pinned; `target` mounts it at once and scrolls its line into view, once per key. */
function Window({ eager, items: given, path, sig, pinned, target, renderRow }: WindowProps) {
  // Opening a gap re-cuts every window after it; a window whose rows are the same lines keeps its array, so its highlight is not redone.
  const kept = useRef(given);
  if (kept.current !== given && !sameItems(kept.current, given)) kept.current = given;
  const items = kept.current;
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(eager);
  const [hl, setHl] = useState<Highlighted | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  const scrolled = useRef<DiffRevealLine["key"] | null>(null);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const scrollRoot = useContext(DiffScrollRootContext);
  // The rows changed (lines revealed, wrap or layout switched): a height measured for the old ones is stale.
  useEffect(() => setMeasured(null), [items, sig]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return setOn(true);
    // With a scroller of its own (the Diff panel) the margin is measured from that element; without one, from the viewport.
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (!last) return;
        if (!on) {
          if (last.isIntersecting) setOn(true);
        } else if (!last.isIntersecting && !pinnedRef.current) {
          setMeasured(Math.round(el.getBoundingClientRect().height));
          setHl(null);
          setOn(false);
        }
      },
      { root: scrollRoot, rootMargin: `${on ? UNMOUNT_MARGIN_PX : MOUNT_MARGIN_PX}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [on, scrollRoot]);
  // Highlight this window's own lines once it is mounted (and again if its rows change, e.g. lines revealed).
  useEffect(() => {
    if (!on) return;
    let off = false;
    highlightLines(windowLines(items), path, () => off).then((m) => !off && setHl(m), () => undefined); // no grammar or no highlighter: plain text
    return () => { off = true; };
  }, [on, items, path]);
  // A line to reveal: mount the window before paint, then scroll once its rows are in the DOM.
  useLayoutEffect(() => {
    if (target && !on) setOn(true);
  }, [target, on]);
  useLayoutEffect(() => {
    if (!target || !on || scrolled.current === target.key) return;
    const row = ref.current?.querySelector(`[data-diff-line][data-${target.side}-line="${target.line}"]`);
    if (!row) return;
    scrolled.current = target.key;
    row.scrollIntoView?.({ block: "center" });
  }, [target, on]);
  return <div ref={ref} data-diff-window={on ? "on" : "off"} style={on ? undefined : { height: measured ?? items.length * EST_ROW_PX }}>{on ? items.map((r) => renderRow(r, hl)) : null}</div>;
}

function sameItems(a: readonly Item[], b: readonly Item[]): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i] as Item;
    if (x.type !== y.type || x.key !== y.key) return false;
    if (x.type === "line" && y.type === "line") return x.line === y.line;
    if (x.type === "pair" && y.type === "pair") return x.left === y.left && x.right === y.right;
    if (x.type === "gap" && y.type === "gap") return x.hidden === y.hidden && x.up === y.up && x.down === y.down;
    return x.type === "hunk" && y.type === "hunk" && x.header === y.header;
  });
}

// The number is the target. Under a coarse pointer it is at least 44 px wide. T25's ::after also reached 12 px above and
// below a 20 px row, but later rows paint over earlier ones, so a tap on the lower part of a number landed on the line
// below; the hit area is now the row's own height.
const GUTTER = "w-10 shrink-0 select-none pe-1 text-right text-muted-foreground pointer-coarse:min-w-11";
// A mouse hover shows a "+" at the number's left edge (T29: the comment affordance); a pseudo-element, so the number stays the button's text.
const GUTTER_BUTTON = `${GUTTER} relative pointer-fine:hover:text-foreground pointer-fine:hover:before:absolute pointer-fine:hover:before:start-0 pointer-fine:hover:before:text-[var(--accent)] pointer-fine:hover:before:content-['+']`;

/**
 * A line number that reports taps. A touch tap fires on `pointerup`, only when the finger moved under 8 px and was
 * down under 500 ms, and `touch-action` stays `pan-y`, so a scroll that starts on the gutter never selects. A mouse
 * or the keyboard goes through `click`, which carries the shift key.
 */
function Gutter({ side, n, filePath, onLineAction }: { side: DiffSide; n: number | undefined; filePath: string; onLineAction: ((at: DiffLineRef, modifiers: { shiftKey: boolean }) => void) | undefined }) {
  const down = useRef<{ x: number; y: number; at: number } | null>(null);
  const ignoreClickUntil = useRef(0);
  if (n === undefined || !onLineAction) return <span className={GUTTER} aria-hidden>{n}</span>;
  const fire = (shiftKey: boolean) => onLineAction({ filePath, side, line: n }, { shiftKey });
  return (
    <button
      type="button"
      className={GUTTER_BUTTON}
      style={{ touchAction: "pan-y" }}
      data-diff-gutter={side}
      aria-label={`${side} line ${n}`}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        down.current = { x: e.clientX, y: e.clientY, at: Date.now() };
      }}
      onPointerUp={(e) => {
        if (e.pointerType === "mouse") return;
        const d = down.current;
        down.current = null;
        // The click a touch may still synthesise after this is not a second tap.
        ignoreClickUntil.current = Date.now() + 600;
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < TAP_SLOP_PX && Date.now() - d.at < TAP_MAX_MS) fire(false);
      }}
      onPointerCancel={() => { down.current = null; }}
      onClick={(e) => {
        if (Date.now() < ignoreClickUntil.current) return;
        fire(e.shiftKey);
      }}
    >
      {n}
    </button>
  );
}


/** What the operator is told after a tap on an expand control that did not open anything. */
type Note =
  | { kind: "error"; index: number; how: "down" | "up" | "all" }
  | { kind: "blocked"; why: "binary" | "too-large" | "refused" }
  | { kind: "stale" };
/** Expand state for one parsed file. A new patch is a new `file`, and starts again from nothing. */
type Expansion = { file: ParsedPatchFile; text?: readonly string[]; reveals: Reveals; note: Note | null };
type Loaded = { lines: readonly string[]; stale: boolean } | { blocked: "binary" | "too-large" | "refused" | "absent" };

const BLOCKED_NOTE = { binary: "Binary file: there are no unchanged lines to show.", "too-large": "File too large to expand.", refused: "Files keeps that file hidden (dot files, secrets, dependencies)." } as const;

/** Half the width of a no-wrap split view, in `ch`: the longest line on either side, a tab counted as 8. */
function longestLine(rows: readonly Item[]): number {
  let max = 0;
  const see = (t: string | undefined) => {
    if (t === undefined) return;
    let n = t.length;
    for (let i = t.indexOf("\t"); i >= 0; i = t.indexOf("\t", i + 1)) n += 7;
    if (n > max) max = n;
  };
  for (const r of rows) {
    if (r.type === "line") see(r.line.text);
    else if (r.type === "pair") {
      see(r.left?.text);
      see(r.right?.text);
    }
  }
  return max;
}

export default function HandAdapter(props: DiffCodeViewProps) {
  const { patch, parsed, filePath, wrap, layout = "stacked", annotations, renderAnnotation, onLineAction, onExpandContext, truncated = false, selection, revealLine, eager = true, header = true } = props;
  const file = useParsedFile(patch, parsed);
  const [stored, setStored] = useState<Expansion>({ file, reveals: NO_REVEALS, note: null });
  const ex: Expansion = stored.file === file ? stored : { file, reveals: NO_REVEALS, note: null };
  const loading = useRef<{ file: ParsedPatchFile; promise: Promise<Loaded> }>(undefined);
  const lineCache = useRef(new Map<string, ParsedLine>());

  const canExpand = !!onExpandContext && ex.note?.kind !== "blocked" && ex.note?.kind !== "stale";
  const rows = useMemo(() => stackedRows(file, ex.text, ex.reveals, { truncated, controls: canExpand, cache: lineCache.current }), [file, ex.text, ex.reveals, truncated, canExpand]);
  const list = useMemo<Item[]>(() => (layout === "split" ? splitRows(rows) : rows), [layout, rows]);
  const windows = useMemo(() => windowRows(list), [list]);
  const ownAnnotations = useMemo(() => (annotations ?? []).filter((a) => a.at.filePath === filePath), [annotations, filePath]);
  // Windows that hold a selection or a note never unmount (an open editor lives in one), and the one that holds the line to reveal.
  const pinned = useMemo(
    () => windows.map((w) => w.some((r) => ownAnnotations.some((a) => itemHasLine(r, a.at.side, a.at.line)) || (selection !== undefined && selectedIn(r, selection.side, selection.start, selection.end)))),
    [windows, ownAnnotations, selection],
  );
  const targetWindow = useMemo(() => (revealLine ? windows.findIndex((w) => w.some((r) => itemHasLine(r, revealLine.side, revealLine.line))) : -1), [windows, revealLine]);
  // Split without wrap: both sides scroll together, so each is as wide as the longest line anywhere (rows stay aligned).
  const splitWidth = useMemo(() => (layout === "split" && !wrap ? longestLine(list) : 0), [layout, wrap, list]);

  const update = (fn: (cur: Expansion) => Expansion) => setStored((prev) => fn(prev.file === file ? prev : { file, reveals: NO_REVEALS, note: null }));

  const expand = async (index: number, how: "down" | "up" | "all") => {
    if (!onExpandContext) return;
    update((c) => ({ ...c, note: null }));
    try {
      // One request per file, however many gaps are opened.
      if (loading.current?.file !== file) {
        loading.current = {
          file,
          promise: onExpandContext(filePath).then((r): Loaded => {
            if (!r) throw new Error("no file text");
            if ("unavailable" in r) return { blocked: r.unavailable };
            const lines = splitFileText(r.newText);
            return { lines, stale: staleAgainst(file, lines) };
          }),
        };
      }
      const loaded = await loading.current.promise;
      if ("blocked" in loaded) return update((c) => ({ ...c, note: loaded.blocked === "absent" ? { kind: "stale" } : { kind: "blocked", why: loaded.blocked } }));
      if (loaded.stale) return update((c) => ({ ...c, note: { kind: "stale" } }));
      const span = gapSpans(file)?.[index];
      const len = span ? gapLength(span, loaded.lines.length) : null;
      if (len === null) return;
      update((c) => ({ ...c, text: loaded.lines, note: null, reveals: new Map(c.reveals).set(index, revealMore(c.reveals.get(index), how, len, index === 0)) }));
    } catch {
      if (loading.current?.file === file) loading.current = undefined;
      update((c) => ({ ...c, note: { kind: "error", index, how } }));
    }
  };

  const gutter = (side: DiffSide, n: number | undefined) => <Gutter side={side} n={n} filePath={filePath} onLineAction={onLineAction} />;
  const code = (l: ParsedLine | undefined, hl: Highlighted | null): ReactNode => (
    <span className={`min-w-0 flex-1 select-text px-1 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"} ${l ? TINT[l.kind] : ""}`}>
      {l ? <>{linePrefix(l)}{hl?.get(l) ?? l.text}{l.noEol ? <span className="block select-none text-muted-foreground">\ No newline at end of file</span> : null}</> : null}
    </span>
  );
  const notes = (l: ParsedLine | undefined, only?: DiffSide) =>
    renderAnnotation && ownAnnotations.filter((a) => (!only || a.at.side === only) && lineMatches(l, a.at.side, a.at.line))
      .map((a) => <div key={a.key} data-diff-annotation={a.key}>{renderAnnotation(a)}</div>);
  const picked = (l: ParsedLine | undefined, side: DiffSide) => selection !== undefined && selection.side === side && lineInRange(l, side, selection.start, selection.end);
  const half = (l: ParsedLine | undefined, s: DiffSide, hl: Highlighted | null) => (
    <div className={`flex min-w-0 ${picked(l, s) ? SELECTED : ""}`} data-diff-side={s} data-diff-selected={picked(l, s) ? "" : undefined}>{gutter(s, s === "old" ? l?.oldLine : l?.newLine)}{code(l, hl)}</div>
  );
  const EXPAND = "px-1 py-0.5 text-start text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:px-2";
  const control = (r: GapRow) => {
    const n = r.hidden;
    const button = (how: "down" | "up" | "all", label: string) => (
      <button key={how} type="button" data-diff-expand={how} className={EXPAND} onClick={() => void expand(r.index, how)}>{label}</button>
    );
    // A gap of one step or less is one button; a bigger one steps from either end or opens whole.
    if (n !== null && n <= EXPAND_STEP) return [button("all", n === 1 ? "Show 1 line" : `Show ${n} lines`)];
    const step = n === null ? EXPAND_STEP : Math.min(EXPAND_STEP, n);
    return [
      r.down ? button("down", `↓ ${step} more below${r.up ? " the previous hunk" : ""}`) : null,
      r.up ? button("up", `↑ ${step} more above${r.down ? " the next hunk" : ""}`) : null,
      button("all", n === null ? "Show all" : `Show all ${n}`),
    ];
  };
  const renderRow = (r: Item, hl: Highlighted | null): ReactNode => {
    if (r.type === "hunk") return <div key={r.key} className="px-2 text-[var(--muted)]">{r.header}</div>;
    if (r.type === "gap") return <div key={r.key} data-diff-gap={r.index} className="flex flex-wrap gap-x-3 px-1">{control(r)}</div>;
    if (r.type === "pair") {
      return <Fragment key={r.key}><div role="row" data-diff-line={(r.right ?? r.left)?.kind} data-old-line={r.left?.oldLine} data-new-line={r.right?.newLine} className="grid grid-cols-2">{half(r.left, "old", hl)}{half(r.right, "new", hl)}</div>{notes(r.left, "old")}{notes(r.right, "new")}</Fragment>;
    }
    const l = r.line;
    const sel = picked(l, "old") || picked(l, "new");
    return <Fragment key={r.key}><div role="row" data-diff-line={l.kind} data-old-line={l.oldLine} data-new-line={l.newLine} data-diff-selected={sel ? "" : undefined} className={`flex ${sel ? SELECTED : ""}`}>{gutter("old", l.oldLine)}{gutter("new", l.newLine)}{code(l, hl)}</div>{notes(l)}</Fragment>;
  };

  const note = ex.note;
  return (
    <div data-diff-adapter="hand" data-diff-layout={layout === "split" ? "split" : "stacked"} data-diff-wrap={wrap ? "" : undefined} className="rounded border font-mono text-xs leading-5">
      <style>{CSS}</style>
      {header && <div className="flex gap-2 px-2 py-1"><span className="min-w-0 flex-1 truncate">{filePath}</span><span className="text-[var(--ok)]">+{file.additions}</span><span className="text-[var(--warn)]">−{file.deletions}</span></div>}
      <div role="table" aria-label={filePath} className={wrap ? "" : "overflow-x-auto overscroll-x-contain"}>
        {file.hunks.length === 0 && <div className="px-2 text-muted-foreground">{file.status === "binary" ? "Binary file" : "No changes to show"}</div>}
        <div style={splitWidth > 0 ? { minWidth: "100%", width: `calc(${2 * (splitWidth + 1)}ch + 6rem)` } : undefined}>
          {windows.map((items, i) => (
            <Window key={items[0]?.key ?? i} eager={eager && i === 0} items={items} path={filePath} sig={`${wrap}:${layout}`} pinned={pinned[i] === true} target={i === targetWindow ? revealLine : undefined} renderRow={renderRow} />
          ))}
        </div>
      </div>
      {note?.kind === "error" && (
        <div role="alert" className="flex flex-wrap items-center gap-2 px-2 py-1 text-[var(--warn)]">
          <span>Couldn't read this file. The diff is unchanged.</span>
          <button type="button" className="underline pointer-coarse:min-h-11 pointer-coarse:px-2" onClick={() => void expand(note.index, note.how)}>Retry</button>
        </div>
      )}
      {note?.kind === "blocked" && <div data-diff-expand-note="blocked" className="px-2 py-1 text-muted-foreground">{BLOCKED_NOTE[note.why]}</div>}
      {note?.kind === "stale" && <div role="alert" data-diff-expand-note="stale" className="px-2 py-1 text-[var(--warn)]">File changed since this diff. Refresh.</div>}
    </div>
  );
}

/** Whether a row draws any line of the selection. */
function selectedIn(r: Item, side: DiffSide, start: number, end: number): boolean {
  if (r.type === "line") return lineInRange(r.line, side, start, end);
  if (r.type === "pair") return lineInRange(side === "old" ? r.left : r.right, side, start, end);
  return false;
}
