// Sightr code (T31). Previous and next over the runs that changed something, in the Diff panel's run scope: "Run 4 of 7 ·
// 12:41". The scope picker still chooses among scopes (and lists the runs); this steps through them without opening
// it, which is what a phone wants. Two 44 px buttons on a touch screen, disabled at the ends.
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { RunOption } from "../diffs/runScope";

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "Run 4 of 7 · 12:41": the run's place among the listed runs (oldest first), and when it ended (or started). */
export function runPickerLabel(position: number, total: number, at: number): string {
  return `Run ${position} of ${total} · ${clock(at)}`;
}

export function RunPicker({ runs, runId, onPick }: { runs: ReadonlyArray<RunOption>; runId: string; onPick: (runId: string) => void }) {
  // `runs` is newest first (the scope picker's order); the position counts from the oldest.
  const ordered = [...runs].reverse();
  const index = ordered.findIndex((r) => r.runId === runId);
  if (ordered.length === 0) return null;
  const current = index >= 0 ? ordered[index]! : null;
  const prev = index > 0 ? ordered[index - 1]! : null;
  // A run that is not listed (it changed nothing) steps to the newest listed one with Next off and Previous on.
  const next = index >= 0 ? (ordered[index + 1] ?? null) : null;
  const previous = index >= 0 ? prev : (ordered.at(-1) ?? null);
  return (
    <span role="group" aria-label="Run" className="flex items-center" data-run-picker="">
      <Button size="icon-xs" variant="ghost-muted" aria-label="Previous run" disabled={previous === null} onClick={() => previous && onPick(previous.runId)} className="pointer-coarse:size-11">
        <ChevronLeftIcon />
      </Button>
      <span className="min-w-0 px-1 text-center text-xs tabular-nums text-muted-foreground" data-run-picker-label="" aria-live="polite">
        {current ? runPickerLabel(index + 1, ordered.length, current.at) : "Run not listed"}
      </span>
      <Button size="icon-xs" variant="ghost-muted" aria-label="Next run" disabled={next === null} onClick={() => next && onPick(next.runId)} className="pointer-coarse:size-11">
        <ChevronRightIcon />
      </Button>
    </span>
  );
}
