// Sightr code (T25). Candidate A: @pierre/diffs (Apache-2.0) through its React `PatchDiff`, with a small
// worker pool (a same-origin Vite `?worker` file, shiki's JS regex engine; never the WASM one).
// If the worker cannot start, the file shows as plain lines instead of throwing.
import { PatchDiff, WorkerPoolContext } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { Component, useEffect, useMemo, useState, type ReactNode } from "react";

import { DiffLines } from "../../right-panel/DiffView.tsx";
import type { DiffAdapterCapabilities, DiffAnnotation, DiffCodeViewProps } from "../DiffCodeView.tsx";
import { unifiedLines, useParsedFile } from "../parsedFile.ts";

export const capabilities: DiffAdapterCapabilities = { split: true, expand: true, annotations: true, highlight: true };

// 44 px gutter under a coarse pointer, and the page palette behind the code.
const UNSAFE_CSS = `@media (pointer: coarse) { [data-column-number] { min-width: 44px; } }
:host { --diffs-bg: transparent; }`;

type PoolState = { pool: WorkerPoolManager | null; ready: "pending" | "ok" | "failed" };
let shared: { pool: WorkerPoolManager; init: Promise<void> } | null | undefined;

function sharedPool() {
  if (shared === undefined) {
    try {
      const pool = new WorkerPoolManager(
        { workerFactory: () => new DiffsWorker(), poolSize: 2, totalASTLRUCacheSize: 240 },
        { theme: { dark: "pierre-dark", light: "pierre-light" }, preferredHighlighter: "shiki-js", tokenizeMaxLineLength: 1000, useTokenTransformer: true },
      );
      shared = { pool, init: pool.initialize() };
    } catch {
      shared = null; // no worker at all: plain lines
    }
  }
  return shared;
}

// Test seam: jsdom has no Worker, so the contract test sets this to render on the main thread.
const mainThreadOnly = () => (globalThis as { __SIGHTR_DIFFS_NO_WORKER__?: boolean }).__SIGHTR_DIFFS_NO_WORKER__ === true;

function usePool(): PoolState {
  const [state, set] = useState<PoolState>({ pool: null, ready: mainThreadOnly() ? "ok" : "pending" });
  useEffect(() => {
    if (mainThreadOnly()) return;
    const s = sharedPool();
    if (!s) { set({ pool: null, ready: "failed" }); return; }
    let off = false;
    s.init.then(() => !off && set({ pool: s.pool, ready: "ok" }), () => { shared = null; if (!off) set({ pool: null, ready: "failed" }); });
    return () => { off = true; };
  }, []);
  return state;
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export default function PierreAdapter(props: DiffCodeViewProps) {
  const { patch, parsed, filePath, wrap, layout = "stacked", annotations, renderAnnotation, onLineAction, onExpandContext } = props;
  const file = useParsedFile(patch, parsed);
  const { pool, ready } = usePool();
  const [error, setError] = useState<string | null>(null);
  const plain = <DiffLines lines={unifiedLines(file)} wrap={wrap} />;
  const lineAnnotations = useMemo(
    () => (annotations ?? []).filter((a) => a.at.filePath === filePath).map((a) => ({ side: a.at.side === "old" ? ("deletions" as const) : ("additions" as const), lineNumber: a.at.line, metadata: a })),
    [annotations, filePath],
  );
  const options = useMemo(
    () => ({
      diffStyle: layout === "split" ? ("split" as const) : ("unified" as const),
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      theme: { dark: "pierre-dark", light: "pierre-light" } as const,
      themeType: "system" as const,
      hunkSeparators: "line-info" as const,
      diffIndicators: "classic" as const, // +/- glyphs, so a change is not told by colour alone
      disableFileHeader: true, // the adapter draws the path above, in the page DOM
      unsafeCSS: UNSAFE_CSS,
      onLineNumberClick: onLineAction ? (e: { annotationSide: "deletions" | "additions"; lineNumber: number }) => onLineAction({ filePath, side: e.annotationSide === "deletions" ? "old" : "new", line: e.lineNumber }) : undefined,
      loadDiffFiles: onExpandContext
        ? async () => {
            const r = await onExpandContext(filePath).catch(() => null);
            if (!r) { setError("Could not load the unchanged lines. The diff is unchanged."); throw new Error("expand failed"); }
            setError(null);
            return { oldFile: { name: file.oldPath ?? filePath, contents: r.oldText }, newFile: { name: filePath, contents: r.newText } };
          }
        : undefined,
    }),
    [layout, wrap, onLineAction, onExpandContext, filePath, file.oldPath],
  );

  return (
    <div data-diff-adapter="pierre" data-diff-layout={layout === "split" ? "split" : "stacked"} data-diff-wrap={wrap ? "" : undefined}>
      <div className="flex gap-2 px-2 py-1 font-mono text-xs"><span className="min-w-0 flex-1 truncate">{filePath}</span><span style={{ color: "var(--ok)" }}>+{file.additions}</span><span style={{ color: "var(--warn)" }}>−{file.deletions}</span></div>
      {ready === "ok" ? (
        <Boundary fallback={plain}>
          <WorkerPoolContext value={pool ?? undefined}>
            <PatchDiff<DiffAnnotation>
              patch={patch}
              disableWorkerPool={mainThreadOnly()}
              options={options}
              lineAnnotations={lineAnnotations}
              renderAnnotation={renderAnnotation ? (a) => (a.metadata ? renderAnnotation(a.metadata) : null) : undefined}
            />
          </WorkerPoolContext>
        </Boundary>
      ) : (
        plain
      )}
      {error && <div role="alert" className="px-2 py-1 text-xs" style={{ color: "var(--warn)" }}>{error}</div>}
    </div>
  );
}
