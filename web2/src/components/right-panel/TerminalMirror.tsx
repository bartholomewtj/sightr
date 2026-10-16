// Copied from web/src/components/ansi-output.tsx (`AnsiMirror`), raw mode only (T13): every line as the
// pane shows it, in the mirror's dark colour space with the light-theme inversion (ADR 0002), wide
// glyphs locked to their cells, and autolinked http(s) URLs. No lifted dialog blocks (requests are
// T12's job) and no find (T19). v1's pure helpers come through @v1.
import { Fragment, memo, useMemo } from "react";
import type { ReactNode } from "react";

import { MIRROR_INVERT, MIRROR_SPACE, styleFor } from "@v1/components/mirror-space";
import { lineText, type StyledLine } from "@v1/lib/blocks";
import { splitSegment } from "@v1/lib/find";
import { findLinks } from "@v1/lib/links";
import { partitionMirrorRuns } from "@v1/lib/mirror-cells";
import { cn } from "~/lib/utils";

const LINK_CLASS = "underline decoration-1 underline-offset-2 cursor-pointer py-[0.35em]";
const CELL_CLASS = "inline-block overflow-hidden text-center align-bottom [line-height:inherit]";

function preClass(className?: string): string {
  return cn(
    "m-0 font-mono leading-[1.25] tracking-normal text-foreground [font-variant-ligatures:none] [font-kerning:none] [text-rendering:geometricPrecision]",
    MIRROR_SPACE,
    MIRROR_INVERT,
    "min-w-0 w-full max-w-full shrink-0 overflow-x-auto overscroll-x-contain [touch-action:pan-x_pan-y] whitespace-pre",
    className,
  );
}

function renderCells(text: string): ReactNode {
  const runs = partitionMirrorRuns(text);
  if (runs.length === 0) return text;
  if (runs.length === 1 && runs[0]!.kind === "text") return runs[0]!.text;
  return runs.map((run, i) =>
    run.kind === "text" ? (
      run.text
    ) : (
      <span key={i} data-cell={run.cols} className={CELL_CLASS} style={{ width: `${run.cols}ch`, maxWidth: `${run.cols}ch` }}>
        {run.glyph}
      </span>
    ),
  );
}

export interface TerminalMirrorProps {
  lines: StyledLine[];
  className?: string;
  /** Monospace font size in px. */
  fontSize: number;
}

export const TerminalMirror = memo(function TerminalMirror({ lines, className, fontSize }: TerminalMirrorProps) {
  const haystack = useMemo(() => lines.map(lineText).join("\n"), [lines]);
  const links = useMemo(() => findLinks(haystack), [haystack]);

  let offset = 0;
  const renderSegment = (text: string, start: number): ReactNode => {
    if (links.length === 0) return renderCells(text);
    return splitSegment(text, start, links).map((p, i) => {
      if (p.matchIndex === null) return <Fragment key={i}>{renderCells(p.text)}</Fragment>;
      return (
        <a key={i} href={links[p.matchIndex]!.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          {renderCells(p.text)}
        </a>
      );
    });
  };

  return (
    <pre className={preClass(className)} style={{ fontSize: `${fontSize}px`, fontFamily: "Consolas, ui-monospace, monospace" }}>
      {lines.map((line, li) => {
        if (li > 0) offset += 1;
        const segs = line.segments.map((s, si) => {
          const segStart = offset;
          offset += s.text.length;
          return (
            <span key={si} style={styleFor(s)}>
              {renderSegment(s.text, segStart)}
            </span>
          );
        });
        return (
          <Fragment key={li}>
            {li > 0 ? "\n" : null}
            {segs}
          </Fragment>
        );
      })}
    </pre>
  );
});
