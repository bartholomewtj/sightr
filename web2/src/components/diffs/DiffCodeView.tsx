// Sightr code (T25). The one seam the diff panel (T27), split and expand (T28) and line comments (T29)
// import. `diffs-adapter` is an alias, set in vite.config.ts / vitest.config.ts / tsconfig.json to
// `adapters/hand.tsx` (T25's decision, flipped by T27) unless SIGHTR_DIFFS=status|hand|pierre picks a candidate;
// the adapter loads in its own chunk, so a slow chunk shows the plain lines instead of a blank.
import { createContext, lazy, Suspense, type ReactNode } from "react";

import type { DiffExpandContents } from "@/lib/diffFileContents";

import { DiffLines } from "../right-panel/DiffView.tsx";
import type { ParsedPatchFile } from "./parsePatch.ts";

export type { ParsedPatchFile } from "./parsePatch.ts";
export type { DiffExpandContents } from "@/lib/diffFileContents";

export type DiffSide = "old" | "new";
export type DiffLineRef = { filePath: string; side: DiffSide; line: number }; // 1-based, from the hunk header
export type DiffAnnotation = { at: DiffLineRef; key: string };
export type DiffCodeViewProps = {
  patch: string; // one file's unified diff (what `parsePatch` splits out)
  parsed?: ParsedPatchFile; // optional, skips a second parse
  filePath: string; // picks the grammar; never an absolute path
  wrap: boolean; // phone default true (the existing `diffWrap`)
  layout?: "stacked" | "split"; // adapters without split render stacked and say so via `capabilities`
  annotations?: DiffAnnotation[]; // T29 anchors
  renderAnnotation?: (a: DiffAnnotation) => ReactNode;
  onLineAction?: (at: DiffLineRef) => void; // tap/click on a line gutter, T29
  /** T28: the whole file, fetched once on the first tap of any expand control. Null: the read failed (the adapter says so and offers a retry). */
  onExpandContext?: (filePath: string) => Promise<DiffExpandContents | null>;
  /** The host cut this patch: the tail after the last hunk is unknown, so there is no control for it (T28). */
  truncated?: boolean;
  /** Draw the first window of rows at once (default). False: it mounts when it nears the screen, like the rest (T27: only the first or revealed open file is eager). */
  eager?: boolean;
  /** Draw the adapter's own file header (path and +/-). Default true; the Diff panel draws its own sticky header and says false. */
  header?: boolean;
};
/**
 * The element that scrolls the diffs, when it is not the page. An adapter that mounts rows as they near the
 * screen observes against it: an IntersectionObserver with no root does not widen its margin past a nested
 * scroller, so rows would mount only once they were already on screen.
 */
export const DiffScrollRootContext = createContext<HTMLElement | null>(null);
export type DiffAdapterCapabilities ={ split: boolean; expand: boolean; annotations: boolean; highlight: boolean };

const loadAdapter = () => lazy(() => import("diffs-adapter"));
let Adapter = loadAdapter();

/** React.lazy keeps a rejected import for good; a caller's Retry swaps in a fresh one before it remounts the view. */
export function resetDiffRenderer(): void {
  Adapter = loadAdapter();
}

/**
 * Start loading the renderer's chunk. The first diff of a session otherwise waits about 300 ms in the
 * `Suspense` fallback (React's reveal throttle) on top of the fetch; the diff panel calls this on mount.
 * A failed load is swallowed here (the diff itself reports it, through the caller's error boundary).
 */
export function preloadDiffRenderer(): Promise<void> {
  return import("diffs-adapter").then(
    () => undefined,
    () => undefined,
  );
}

/** The patch from its first hunk on, as `DiffLines` draws it. No parser: the seam keeps `parsePatch` out of the main chunk. */
function hunkLines(patch: string): string[] {
  const rows = patch.replace(/\n$/, "").split("\n");
  const first = rows.findIndex((r) => r.startsWith("@@"));
  return first < 0 ? ["No changes to show"] : rows.slice(first);
}

/** The patch as plain lines: what shows while the adapter loads, and what a caller's error boundary falls back to. */
export function PlainPatch({ patch, wrap }: Pick<DiffCodeViewProps, "patch" | "wrap">) {
  return (
    <div data-diff-fallback="">
      <DiffLines lines={hunkLines(patch)} wrap={wrap} />
    </div>
  );
}

export function DiffCodeView(props: DiffCodeViewProps) {
  return (
    <Suspense fallback={<PlainPatch patch={props.patch} wrap={props.wrap} />}>
      <Adapter {...props} />
    </Suspense>
  );
}
