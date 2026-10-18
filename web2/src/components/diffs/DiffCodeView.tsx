// Sightr code (T25). The one seam the diff panel (T27), split and expand (T28) and line comments (T29)
// import. `diffs-adapter` is an alias, set in vite.config.ts / vitest.config.ts / tsconfig.json to
// `adapters/status.tsx` unless SIGHTR_DIFFS=pierre|hand picks a candidate; the adapter loads in its own
// chunk, so a slow chunk shows the status-quo lines instead of a blank.
import { lazy, Suspense, type ReactNode } from "react";

import { DiffLines } from "../right-panel/DiffView.tsx";
import { unifiedLines, useParsedFile } from "./parsedFile.ts";
import type { ParsedPatchFile } from "./parsePatch.ts";

export type { ParsedPatchFile } from "./parsePatch.ts";

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
  onExpandContext?: (filePath: string) => Promise<{ oldText: string; newText: string } | null>; // T28
};
export type DiffAdapterCapabilities = { split: boolean; expand: boolean; annotations: boolean; highlight: boolean };

const Adapter = lazy(() => import("diffs-adapter"));

function Fallback({ patch, parsed, wrap }: Pick<DiffCodeViewProps, "patch" | "parsed" | "wrap">) {
  return <DiffLines lines={unifiedLines(useParsedFile(patch, parsed))} wrap={wrap} />;
}

export function DiffCodeView(props: DiffCodeViewProps) {
  return (
    <Suspense fallback={<Fallback patch={props.patch} parsed={props.parsed} wrap={props.wrap} />}>
      <Adapter {...props} />
    </Suspense>
  );
}
