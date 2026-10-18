// Sightr code (T25). The measurement stand-in for T27's panel: one section per file, only the first `open`
// rendered ("files rendered on open"), each through the seam with the file's already-parsed form.
import { DiffCodeView } from "../DiffCodeView.tsx";
import type { SpikeFile } from "./files.ts";

export type PanelProps = { files: SpikeFile[]; open: number[]; wrap: boolean; layout?: "stacked" | "split"; actions?: boolean };

const noop = () => undefined;

export function Panel({ files, open, wrap, layout, actions }: PanelProps) {
  return (
    <div data-spike-panel="">
      {files.map((f, i) => (
        <section key={f.path + i} data-spike-file={f.path}>
          <h3 className="px-2 py-1 font-mono text-xs">{f.path}</h3>
          {open.includes(i) && <DiffCodeView patch={f.patch} parsed={f.parsed} filePath={f.path} wrap={wrap} layout={layout} onLineAction={actions ? noop : undefined} />}
        </section>
      ))}
    </div>
  );
}

/** Whether the adapter has drawn the file's lines (any adapter), and whether highlighting has arrived. */
export const SELECTORS = {
  highlighted: "[class*='hljs-'], [data-content] [data-line] span[style*='--diffs-token']",
} as const;
