// Sightr code (T25). Candidate C, the status quo: today's `DiffLines` (no highlighting, no line numbers,
// no split, no expansion) under a file header. The default `diffs-adapter` until T27 picks a winner.
import { DiffLines } from "../../right-panel/DiffView.tsx";
import type { DiffAdapterCapabilities, DiffCodeViewProps } from "../DiffCodeView.tsx";
import { unifiedLines, useParsedFile } from "../parsedFile.ts";

export const capabilities: DiffAdapterCapabilities = { split: false, expand: false, annotations: false, highlight: false };

export default function StatusAdapter({ patch, parsed, filePath, wrap }: DiffCodeViewProps) {
  const file = useParsedFile(patch, parsed);
  return (
    <div data-diff-adapter="status" data-diff-layout="stacked" data-diff-wrap={wrap ? "" : undefined} className="rounded border">
      <div className="flex gap-2 px-2 py-1 font-mono text-xs">
        <span className="min-w-0 flex-1 truncate">{filePath}</span>
        <span style={{ color: "var(--ok)" }}>+{file.additions}</span>
        <span style={{ color: "var(--warn)" }}>−{file.deletions}</span>
      </div>
      <DiffLines lines={unifiedLines(file)} wrap={wrap} />
    </div>
  );
}
