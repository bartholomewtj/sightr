// Sightr code (T25, windowed by T27). Candidate B: a hand-rolled renderer on `parsePatch` with highlight.js loaded per
// language (hand.highlight.ts). Stacked and split, line numbers, tappable gutters, annotations under a line,
// and unchanged lines between hunks on request. Rows mount in windows of 60 rows or 12,000 characters of line
// text; only the first window mounts at once (and only when the caller says `eager`), the rest as they come within
// 800 px of the screen. A window highlights its own lines when it mounts, in slices of at most 200 lines, and
// holds the result in its own state, so nothing highlight-related outlives the component. Browser find sees only
// mounted rows, and a window not yet mounted holds an estimated 20 px a row.
import { Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { DiffScrollRootContext, type DiffAdapterCapabilities, type DiffCodeViewProps, type DiffSide } from "../DiffCodeView.tsx";
import { useParsedFile } from "../parsedFile.ts";
import type { ParsedLine } from "../parsePatch.ts";
import { highlightLines } from "./hand.highlight.ts";
import { lineMatches, linePrefix, splitRows, stackedRows, windowLines, windowRows, type GapRow, type Row, type SplitRow } from "./hand.rows.ts";

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
function Window({ eager, items, path, renderRow }: { eager: boolean; items: Item[]; path: string; renderRow: (item: Item, hl: Highlighted | null) => ReactNode }) {
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

const GUTTER = "w-10 shrink-0 select-none pe-1 text-right text-muted-foreground pointer-coarse:relative pointer-coarse:min-w-11 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-3 pointer-coarse:after:inset-x-0";

export default function HandAdapter(props: DiffCodeViewProps) {
  const { patch, parsed, filePath, wrap, layout = "stacked", annotations, renderAnnotation, onLineAction, onExpandContext, eager = true, header = true } = props;
  const file = useParsedFile(patch, parsed);
  const [text, setText] = useState<string[]>();
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const loading = useRef<Promise<string[]>>(undefined);

  const rows = useMemo(() => stackedRows(file, text, revealed), [file, text, revealed]);
  const list = useMemo<Item[]>(() => (layout === "split" ? splitRows(rows) : rows), [layout, rows]);
  const windows = useMemo(() => windowRows(list), [list]);

  const expand = async (gap: GapRow) => {
    if (!onExpandContext) return;
    // One request per file, however many gaps are opened.
    loading.current ??= onExpandContext(filePath).then((r) => {
      if (!r) throw new Error("no file text");
      const lines = r.newText.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      return lines;
    });
    try {
      setText(await loading.current);
      setRevealed((s) => new Set(s).add(gap.index));
      setError(null);
    } catch {
      loading.current = undefined;
      setError("Could not load the unchanged lines. The diff is unchanged.");
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
      {l ? <>{linePrefix(l)}{hl?.get(l) ?? l.text}</> : null}
    </span>
  );
  const notes = (l: ParsedLine | undefined, only?: DiffSide) =>
    renderAnnotation && annotations?.filter((a) => a.at.filePath === filePath && (!only || a.at.side === only) && lineMatches(l, a.at.side, a.at.line))
      .map((a) => <div key={a.key} data-diff-annotation={a.key}>{renderAnnotation(a)}</div>);
  const half = (l: ParsedLine | undefined, s: DiffSide, hl: Highlighted | null) => (
    <div className="flex min-w-0 flex-1" data-diff-side={s}>{gutter(s, s === "old" ? l?.oldLine : l?.newLine)}{code(l, hl)}</div>
  );
  const renderRow = (r: Item, hl: Highlighted | null): ReactNode => {
    if (r.type === "hunk") return <div key={r.key} className="px-2 text-[var(--muted)]">{r.header}</div>;
    if (r.type === "gap") return <button key={r.key} type="button" data-diff-expand className="w-full px-2 py-0.5 text-start text-muted-foreground pointer-coarse:min-h-11" onClick={() => void expand(r)}>{r.hidden === null ? "Show unchanged lines" : `Show ${r.hidden} unchanged lines`}</button>;
    if (r.type === "pair") {
      return <Fragment key={r.key}><div role="row" data-diff-line={(r.right ?? r.left)?.kind} className="flex">{half(r.left, "old", hl)}{half(r.right, "new", hl)}</div>{notes(r.left, "old")}{notes(r.right, "new")}</Fragment>;
    }
    const l = r.line;
    return <Fragment key={r.key}><div role="row" data-diff-line={l.kind} data-old-line={l.oldLine} data-new-line={l.newLine} className="flex">{gutter("old", l.oldLine)}{gutter("new", l.newLine)}{code(l, hl)}</div>{notes(l)}</Fragment>;
  };

  return (
    <div data-diff-adapter="hand" data-diff-layout={layout === "split" ? "split" : "stacked"} data-diff-wrap={wrap ? "" : undefined} className="rounded border font-mono text-xs leading-5">
      <style>{CSS}</style>
      {header && <div className="flex gap-2 px-2 py-1"><span className="min-w-0 flex-1 truncate">{filePath}</span><span className="text-[var(--ok)]">+{file.additions}</span><span className="text-[var(--warn)]">−{file.deletions}</span></div>}
      <div role="table" aria-label={filePath} className={wrap ? "" : "overflow-x-auto overscroll-x-contain"}>
        {file.hunks.length === 0 && <div className="px-2 text-muted-foreground">{file.status === "binary" ? "Binary file" : "No changes to show"}</div>}
        {windows.map((items, i) => (
          <Window key={items[0]?.key ?? i} eager={eager && i === 0} items={items} path={filePath} renderRow={renderRow} />
        ))}
      </div>
      {error && <div role="alert" className="px-2 py-1 text-[var(--warn)]">{error}</div>}
    </div>
  );
}
