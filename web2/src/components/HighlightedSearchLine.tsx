// Adapted from T3 Code apps/web/src/components/search/HighlightedSearchLine.tsx @ db5919d87 (MIT, see
// THIRD_PARTY.md). Kept: `normalizeRanges` (clamp, sort and merge the match ranges) and the <mark> split.
// Dropped: the Shiki token layer and its Suspense/RenderErrorBoundary wrapper (a one-line excerpt of a
// message needs no syntax colours). The ranges come from the bridge, which found the words.
import { memo, type ReactNode } from "react";

export interface MatchRange {
  readonly start: number;
  readonly end: number;
}

/** Clamp to the line, drop empty ranges, sort, and merge the ones that touch or overlap. */
export function normalizeRanges(line: string, ranges: ReadonlyArray<MatchRange>): MatchRange[] {
  const clamped = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(line.length, range.start)),
      end: Math.max(0, Math.min(line.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of clamped) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** `line` with each range wrapped in a <mark>, as inline children. */
export const HighlightedSearchLine = memo(function HighlightedSearchLine(props: {
  readonly line: string;
  readonly ranges: ReadonlyArray<MatchRange>;
}) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const range of normalizeRanges(props.line, props.ranges)) {
    if (range.start > cursor) parts.push(props.line.slice(cursor, range.start));
    parts.push(
      <mark className="rounded-xs bg-primary/25 font-semibold text-foreground" data-search-mark="" key={range.start}>
        {props.line.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < props.line.length) parts.push(props.line.slice(cursor));
  return <>{parts}</>;
});
