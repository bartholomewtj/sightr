// Copied from web/src/components/diff-view.tsx (T13: the Git tab). Change: `open` sets whether each
// file starts expanded (the tab starts them folded and expands on tap). Colours use web2 tokens.
import type { CSSProperties } from "react";

// Renders a unified diff as one collapsible block per file, with added and removed lines coloured.
// Pure presentation: the text comes from the bridge already stripped of colour and secrets.
export type DiffFile = { path: string; added: number; removed: number; lines: string[] };

// Header lines git prints per file that carry nothing the file summary line doesn't already say.
const NOISE = /^(index |--- |\+\+\+ |old mode |new mode |similarity |rename |copy )/;

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []; let current: DiffFile | null = null;
  const push = (line: string) => { if (!current) { current = { path: "", added: 0, removed: 0, lines: [] }; files.push(current); } current.lines.push(line); };
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (header) { current = { path: header[1], added: 0, removed: 0, lines: [] }; files.push(current); continue; }
    if (NOISE.test(line)) continue;
    if (line.startsWith("+")) current && current.added++; else if (line.startsWith("-")) current && current.removed++;
    push(line);
  }
  return files;
}

const ADD = "var(--ok)"; const DEL = "var(--warn)";
const tint = (colour: string) => `color-mix(in srgb, ${colour} 14%, transparent)`;
export function lineStyle(line: string): CSSProperties | undefined {
  if (line.startsWith("+")) return { color: ADD, background: tint(ADD) };
  if (line.startsWith("-")) return { color: DEL, background: tint(DEL) };
  if (line.startsWith("@@")) return { color: "var(--muted)" };
  return undefined;
}

/**
 * One file's diff lines. `wrap` breaks long lines (a phone's default); otherwise the block scrolls
 * sideways inside its own box, and `overscroll-x-contain` keeps that swipe from moving the sheet or page.
 */
export function DiffLines({ lines, wrap }: { lines: string[]; wrap: boolean }) {
  return (
    <pre className={wrap ? "whitespace-pre-wrap break-all border-t py-1 font-mono text-xs leading-5" : "overflow-x-auto overscroll-x-contain border-t py-1 font-mono text-xs leading-5"} data-diff-wrap={wrap ? "" : undefined}>
      {lines.map((line, i) => (
        <div key={i} className={wrap ? "px-2" : "w-max min-w-full px-2"} data-diff-line={line[0] ?? " "} style={lineStyle(line)}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/** Diff text by file path (`parseDiff`), for rows that know their own paths. */
export function diffLinesByPath(diff: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of parseDiff(diff)) if (f.path) map.set(f.path, f.lines);
  return map;
}

export function DiffView({ diff, open = true }: { diff: string; open?: boolean }) {
  const files = parseDiff(diff);
  return <div className="space-y-2">{files.map((file, index) => <details open={open} key={file.path || index} className="rounded border" data-diff-file={file.path}>
    {file.path && <summary className="flex cursor-pointer gap-2 px-2 py-1 font-mono text-xs"><span className="min-w-0 flex-1 truncate">{file.path}</span><span style={{ color: ADD }}>+{file.added}</span><span style={{ color: DEL }}>−{file.removed}</span></summary>}
    <pre className="overflow-x-auto py-1 font-mono text-xs leading-5">{file.lines.map((line, i) => <div key={i} className="w-max min-w-full px-2" style={lineStyle(line)}>{line || " "}</div>)}</pre>
  </details>)}</div>;
}
