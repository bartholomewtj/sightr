// Sightr code (T25, windowed by T27). Candidate B: a hand-rolled renderer on `parsePatch` with highlight.js loaded per
// language (hand.highlight.ts). Stacked and split, line numbers, tappable gutters, annotations under a line,
// and unchanged lines between hunks on request (T28: 20 at a time from either end of a gap, or all of it). Rows mount in windows of 60 rows or 12,000 characters of line
// text; only the first window mounts at once (and only when the caller says `eager`), the rest as they come within
// 800 px of the screen. A window highlights its own lines when it mounts, in slices of at most 200 lines, and
// holds the result in its own state, so nothing highlight-related outlives the component. Browser find sees only
// mounted rows, and a window not yet mounted holds an estimated 20 px a row.
import { Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { DiffScrollRootContext, type DiffAdapterCapabilities, type DiffCodeViewProps, type DiffSide } from "../DiffCodeView.tsx";
import { useParsedFile } from "../parsedFile.ts";
import type { ParsedLine, ParsedPatchFile } from "../parsePatch.ts";
import { highlightLines } from "./hand.highlight.ts";
import { EXPAND_STEP, gapLength, gapSpans, lineMatches, linePrefix, NO_REVEALS, revealMore, splitFileText, splitRows, stackedRows, staleAgainst, windowLines, windowRows, type GapRow, type Reveals, type Row, type SplitRow } from "./hand.rows.ts";

export const capabilities: DiffAdapterCapabilities = { split: true, expand: true, annotations: true, highlight: true };

// highlight.js classes to the house palette (style/tokens.md), once for the whole file.
const CSS = `.hljs-keyword,.hljs-literal,.hljs-built_in{color:var(--accent)}.hljs-string,.hljs-regexp,.hljs-attr,.hljs-attribute{color:var(--ok)}
.hljs-comment,.hljs-quote,.hljs-meta{color:var(--muted)}.hljs-number,.hljs-title,.hljs-type,.hljs-name,.hljs-section{color:var(--navy)}`;
// Colours as classes (not an inline style per line): 1,500 rows each parsing a color-mix() was the render's biggest cost.
const TINT = { add: "text-[var(--ok)] bg-[color-mix(in_srgb,var(--ok)_14%,transparent)]", del: "text-[var(--warn)] bg-[color-mix(in_srgb,var(--warn)_14%,transparent)]", context: "" } as const;
const EST_ROW_PX = 20; // an unmounted window's height per row; low for wrapped long lines, so the scrollbar shifts as windows mount

type Highlighted = Map<ParsedLine, ReactNode[]>;
type Item = Row | SplitRow;

/** A window of rows: mounts when `eager`, else when it comes within 800 px of the viewport; until then it holds its estimated height. */
function Window({ eager, items: given, path, renderRow }: { eager: boolean; items: Item[]; path: string; renderRow: (item: Item, hl: Highlighted | null) => ReactNode }) {
  // Opening a gap re-cuts every window after it; a window whose rows are the same lines keeps its array, so its highlight is not redone.
  const kept = useRef(given);
  if (kept.current !== given && !sameItems(kept.current, given)) kept.current = given;
  const items = kept.current;
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(eager);
  const [hl, setHl] = useState<Highlighted | null>(null);
  const scrollRoot = useContext(DiffScrollRootContext);
  useEffect(() => {
    const el = ref.current;
    if (on || !el) return;
    if (typeof IntersectionObserver === "undefined") return setOn(true);
    // With a scroller of its own (the Diff panel) the margin is measured from that element; without one, from the viewport.
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setOn(true), { root: scrollRoot, rootMargin: "800px 0px" });
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
  return <div ref={ref} data-diff-window={on ? "on" : "off"} style={on ? undefined : { height: items.length * EST_ROW_PX }}>{on ? items.map((r) => renderRow(r, hl)) : null}</div>;
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

const GUTTER = "w-10 shrink-0 select-none pe-1 text-right text-muted-foreground pointer-coarse:relative pointer-coarse:min-w-11 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-3 pointer-coarse:after:inset-x-0";

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
  const { patch, parsed, filePath, wrap, layout = "stacked", annotations, renderAnnotation, onLineAction, onExpandContext, truncated = false, eager = true, header = true } = props;
  const file = useParsedFile(patch, parsed);
  const [stored, setStored] = useState<Expansion>({ file, reveals: NO_REVEALS, note: null });
  const ex: Expansion = stored.file === file ? stored : { file, reveals: NO_REVEALS, note: null };
  const loading = useRef<{ file: ParsedPatchFile; promise: Promise<Loaded> }>(undefined);
  const lineCache = useRef(new Map<string, ParsedLine>());

  const canExpand = !!onExpandContext && ex.note?.kind !== "blocked" && ex.note?.kind !== "stale";
  const rows = useMemo(() => stackedRows(file, ex.text, ex.reveals, { truncated, controls: canExpand, cache: lineCache.current }), [file, ex.text, ex.reveals, truncated, canExpand]);
  const list = useMemo<Item[]>(() => (layout === "split" ? splitRows(rows) : rows), [layout, rows]);
  const windows = useMemo(() => windowRows(list), [list]);
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

  const gutter = (side: DiffSide, n: number | undefined) =>
    n !== undefined && onLineAction ? (
      <button type="button" className={GUTTER} data-diff-gutter={side} aria-label={`${side} line ${n}`} onClick={() => onLineAction({ filePath, side, line: n })}>{n}</button>
    ) : (
      <span className={GUTTER} aria-hidden>{n}</span>
    );
  const code = (l: ParsedLine | undefined, hl: Highlighted | null): ReactNode => (
    <span className={`min-w-0 flex-1 select-text px-1 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"} ${l ? TINT[l.kind] : ""}`}>
      {l ? <>{linePrefix(l)}{hl?.get(l) ?? l.text}{l.noEol ? <span className="block select-none text-muted-foreground">\ No newline at end of file</span> : null}</> : null}
    </span>
  );
  const notes = (l: ParsedLine | undefined, only?: DiffSide) =>
    renderAnnotation && annotations?.filter((a) => a.at.filePath === filePath && (!only || a.at.side === only) && lineMatches(l, a.at.side, a.at.line))
      .map((a) => <div key={a.key} data-diff-annotation={a.key}>{renderAnnotation(a)}</div>);
  const half = (l: ParsedLine | undefined, s: DiffSide, hl: Highlighted | null) => (
    <div className="flex min-w-0" data-diff-side={s}>{gutter(s, s === "old" ? l?.oldLine : l?.newLine)}{code(l, hl)}</div>
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
      return <Fragment key={r.key}><div role="row" data-diff-line={(r.right ?? r.left)?.kind} className="grid grid-cols-2">{half(r.left, "old", hl)}{half(r.right, "new", hl)}</div>{notes(r.left, "old")}{notes(r.right, "new")}</Fragment>;
    }
    const l = r.line;
    return <Fragment key={r.key}><div role="row" data-diff-line={l.kind} data-old-line={l.oldLine} data-new-line={l.newLine} className="flex">{gutter("old", l.oldLine)}{gutter("new", l.newLine)}{code(l, hl)}</div>{notes(l)}</Fragment>;
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
            <Window key={items[0]?.key ?? i} eager={eager && i === 0} items={items} path={filePath} renderRow={renderRow} />
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
