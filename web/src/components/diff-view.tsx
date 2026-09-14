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

const ADD = "var(--status-done)"; const DEL = "var(--destructive)";
const tint = (colour: string) => `color-mix(in srgb, ${colour} 14%, transparent)`;
function lineStyle(line: string): React.CSSProperties | undefined {
  if (line.startsWith("+")) return { color: ADD, background: tint(ADD) };
  if (line.startsWith("-")) return { color: DEL, background: tint(DEL) };
  if (line.startsWith("@@")) return { color: "var(--muted-foreground)" };
  return undefined;
}

export function DiffView({ diff }: { diff: string }) {
  const files = parseDiff(diff);
  return <div className="space-y-2">{files.map((file, index) => <details open key={file.path || index} className="rounded border">
    {file.path && <summary className="flex cursor-pointer gap-2 px-2 py-1 font-mono text-xs"><span className="min-w-0 flex-1 truncate">{file.path}</span><span style={{ color: ADD }}>+{file.added}</span><span style={{ color: DEL }}>−{file.removed}</span></summary>}
    <pre className="overflow-x-auto py-1 font-mono text-xs leading-5">{file.lines.map((line, i) => <div key={i} className="w-max min-w-full px-2" style={lineStyle(line)}>{line || " "}</div>)}</pre>
  </details>)}</div>;
}
