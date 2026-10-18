// Sightr code (T25). Candidate B: a hand-rolled renderer on `parsePatch` with highlight.js loaded per
// language (hand.highlight.ts). Stacked and split, line numbers, tappable gutters, annotations under a line,
// and unchanged lines between hunks on request. Rows mount in 60-row windows as they come within 800 px of the
// screen (the first two at once), so a long file costs what is near the screen; browser find sees only mounted rows.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { DiffAdapterCapabilities, DiffCodeViewProps, DiffSide } from "../DiffCodeView.tsx";
import { useParsedFile } from "../parsedFile.ts";
import type { ParsedLine } from "../parsePatch.ts";
import { highlightFile } from "./hand.highlight.ts";
import { lineMatches, linePrefix, splitRows, stackedRows, type GapRow, type Row, type SplitRow } from "./hand.rows.ts";

export const capabilities: DiffAdapterCapabilities = { split: true, expand: true, annotations: true, highlight: true };

// highlight.js classes to the house palette (style/tokens.md), once for the whole file.
const CSS = `.hljs-keyword,.hljs-literal,.hljs-built_in{color:var(--accent)}.hljs-string,.hljs-regexp,.hljs-attr,.hljs-attribute{color:var(--ok)}
.hljs-comment,.hljs-quote,.hljs-meta{color:var(--muted)}.hljs-number,.hljs-title,.hljs-type,.hljs-name,.hljs-section{color:var(--navy)}`;
// Colours as classes (not an inline style per line): 1,500 rows each parsing a color-mix() was the render's biggest cost.
const TINT = { add: "text-[var(--ok)] bg-[color-mix(in_srgb,var(--ok)_14%,transparent)]", del: "text-[var(--warn)] bg-[color-mix(in_srgb,var(--warn)_14%,transparent)]", context: "" } as const;
const CHUNK = 60; // rows per window; the first two mount at once, the rest as they near the screen

/** A run of rows that mounts when it comes within 800 px of the viewport; until then it holds its estimated height. */
function Chunk({ eager, rows, children }: { eager: boolean; rows: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(eager);
  useEffect(() => {
    const el = ref.current;
    if (on || !el) return;
    if (typeof IntersectionObserver === "undefined") return setOn(true);
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setOn(true), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [on]);
  return <div ref={ref} style={on ? undefined : { height: rows * 20 }}>{on ? children : null}</div>;
}

const GUTTER = "w-10 shrink-0 select-none pe-1 text-right text-muted-foreground pointer-coarse:relative pointer-coarse:min-w-11 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-3 pointer-coarse:after:inset-x-0";

export default function HandAdapter(props: DiffCodeViewProps) {
  const { patch, parsed, filePath, wrap, layout = "stacked", annotations, renderAnnotation, onLineAction, onExpandContext } = props;
  const file = useParsedFile(patch, parsed);
  const [hl, setHl] = useState<Map<ParsedLine, ReactNode[]> | null>(null);
  const [text, setText] = useState<string[]>();
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const loading = useRef<Promise<string[]>>(undefined);

  useEffect(() => {
    let off = false;
    highlightFile(file, filePath, () => off).then((m) => !off && setHl(m), () => undefined); // no grammar or no highlighter: plain text
    return () => { off = true; };
  }, [file, filePath]);

  const rows = useMemo(() => stackedRows(file, text, revealed), [file, text, revealed]);
  const list: (Row | SplitRow)[] = layout === "split" ? splitRows(rows) : rows;
  const chunks = useMemo(() => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK)), [list]);

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
  const code = (l: ParsedLine | undefined): ReactNode => (
    <span className={`min-w-0 flex-1 select-text px-1 ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"} ${l ? TINT[l.kind] : ""}`}>
      {l ? <>{linePrefix(l)}{hl?.get(l) ?? l.text}</> : null}
    </span>
  );
  const notes = (l: ParsedLine | undefined, only?: DiffSide) =>
    renderAnnotation && annotations?.filter((a) => a.at.filePath === filePath && (!only || a.at.side === only) && lineMatches(l, a.at.side, a.at.line))
      .map((a) => <div key={a.key} data-diff-annotation={a.key}>{renderAnnotation(a)}</div>);
  const half = (l: ParsedLine | undefined, s: DiffSide) => (
    <div className="flex min-w-0 flex-1" data-diff-side={s}>{gutter(s, s === "old" ? l?.oldLine : l?.newLine)}{code(l)}</div>
  );

  return (
    <div data-diff-adapter="hand" data-diff-layout={layout === "split" ? "split" : "stacked"} data-diff-wrap={wrap ? "" : undefined} className="rounded border font-mono text-xs leading-5">
      <style>{CSS}</style>
      <div className="flex gap-2 px-2 py-1"><span className="min-w-0 flex-1 truncate">{filePath}</span><span className="text-[var(--ok)]">+{file.additions}</span><span className="text-[var(--warn)]">−{file.deletions}</span></div>
      <div role="table" aria-label={filePath} className={wrap ? "" : "overflow-x-auto overscroll-x-contain"}>
        {file.hunks.length === 0 && <div className="px-2 text-muted-foreground">{file.status === "binary" ? "Binary file" : "No changes to show"}</div>}
        {chunks.map((items, i) => (
          <Chunk key={items[0]?.key ?? i} eager={i < 2} rows={items.length}>
            {items.map((r) => {
              if (r.type === "hunk") return <div key={r.key} className="px-2 text-[var(--muted)]">{r.header}</div>;
              if (r.type === "gap") return <button key={r.key} type="button" data-diff-expand className="w-full px-2 py-0.5 text-start text-muted-foreground pointer-coarse:min-h-11" onClick={() => void expand(r)}>{r.hidden === null ? "Show unchanged lines" : `Show ${r.hidden} unchanged lines`}</button>;
              if (r.type === "pair") {
                return <Fragment key={r.key}><div role="row" data-diff-line={(r.right ?? r.left)?.kind} className="flex">{half(r.left, "old")}{half(r.right, "new")}</div>{notes(r.left, "old")}{notes(r.right, "new")}</Fragment>;
              }
              const l = r.line;
              return <Fragment key={r.key}><div role="row" data-diff-line={l.kind} data-old-line={l.oldLine} data-new-line={l.newLine} className="flex">{gutter("old", l.oldLine)}{gutter("new", l.newLine)}{code(l)}</div>{notes(l)}</Fragment>;
            })}
          </Chunk>
        ))}
      </div>
      {error && <div role="alert" className="px-2 py-1 text-[var(--warn)]">{error}</div>}
    </div>
  );
}
