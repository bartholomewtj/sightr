#!/usr/bin/env bun
/**
 * T25 diff-renderer spike driver (docs/specs/t3/T25-diff-renderer-spike.md).
 *
 *   bun scripts/diff-spike.ts fixtures [--out <dir>] [--source auto|git|default|<threads.sqlite>] [--seed <n>]
 *   bun scripts/diff-spike.ts jsdom <status|hand|pierre>
 *   bun scripts/diff-spike.ts report --results <results.json> [--readme <file>] [--write]
 *
 * `fixtures` writes deterministic patches (same seed and same extension mix give the same bytes) under
 * web2/.spike-diffs/ (git-ignored). `jsdom` runs the vitest harness against one adapter and prints a
 * markdown row. `report` turns the merged measurements into the README table and refuses a table that is
 * missing a threshold row. Read-only: it reads `threads.sqlite` (extension counts only) or `git log`.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const WEB2 = join(ROOT, "web2");
export const DEFAULT_OUT = join(WEB2, ".spike-diffs");

// ---------------------------------------------------------------------------------------------
// Seeded randomness

export function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

// ---------------------------------------------------------------------------------------------
// The language mix: the top changed-file extensions of real use

export type ExtCount = { ext: string; count: number };
/** Used when neither threads.sqlite nor git history can be read (and by the tests). */
export const DEFAULT_MIX: ExtCount[] = [
  { ext: "ts", count: 1468 }, { ext: "tsx", count: 703 }, { ext: "md", count: 348 }, { ext: "txt", count: 161 },
  { ext: "json", count: 70 }, { ext: "png", count: 21 }, { ext: "css", count: 15 }, { ext: "toml", count: 13 },
  { ext: "ps1", count: 11 }, { ext: "html", count: 10 }, { ext: "example", count: 10 }, { ext: "svg", count: 8 },
];
const BINARY_EXTS = new Set(["png", "jpg", "jpeg", "gif", "ico", "woff2", "woff", "pdf", "webp"]);

export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "(none)";
}

export function countExts(paths: string[]): ExtCount[] {
  const m = new Map<string, number>();
  for (const p of paths) m.set(extOf(p), (m.get(extOf(p)) ?? 0) + 1);
  return [...m].map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
}

/** `file_change` item file names from a v2 store, read-only. Counts extensions only; no content is read. */
export function extsFromSqlite(dbPath: string): ExtCount[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const stmt = db.prepare("SELECT body_json FROM turn_items WHERE type = 'file_change'");
    const rows = stmt.all() as { body_json: string }[];
    stmt.finalize();
    const names: string[] = [];
    for (const r of rows) {
      try {
        const name = (JSON.parse(r.body_json) as { fileName?: unknown }).fileName;
        if (typeof name === "string") names.push(name);
      } catch { /* a row that is not JSON counts for nothing */ }
    }
    return countExts(names);
  } finally {
    db.close();
  }
}

export function extsFromGit(cwd = ROOT): ExtCount[] {
  const r = Bun.spawnSync(["git", "log", "--no-merges", "--name-only", "--pretty=format:"], { cwd, stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return [];
  return countExts(r.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean));
}

export type MixSource = { source: string; all: ExtCount[] };
export function resolveMix(source: string): MixSource {
  if (source === "default") return { source: "built-in default mix", all: DEFAULT_MIX };
  const sqlite = source === "auto"
    ? join(process.env.SIGHTR_STATE_DIR?.trim() || process.env.HERDR_PLUGIN_STATE_DIR?.trim() || join(homedir(), ".local", "state", "sightr"), "threads.sqlite")
    : source.endsWith(".sqlite") ? source : null;
  if (sqlite && existsSync(sqlite)) {
    const all = extsFromSqlite(sqlite);
    if (all.length > 0) return { source: "threads.sqlite file_change history (extension counts)", all };
  }
  if (source === "auto" || source === "git") {
    const all = extsFromGit();
    if (all.length > 0) return { source: "git log --name-only of this repo (threads.sqlite not found)", all };
  }
  return { source: "built-in default mix", all: DEFAULT_MIX };
}

// ---------------------------------------------------------------------------------------------
// Text generators, one family per extension

const IDS = ["state", "thread", "pane", "bridge", "item", "run", "queue", "frame", "cursor", "token", "panel", "diff", "hunk", "label", "scope", "stream", "offset", "result"];
const TYPES = ["string", "number", "boolean", "Thread", "Run", "Map<string, number>", "Promise<void>", "readonly string[]"];
const WORDS = ["bridge", "thread", "reads", "the", "journal", "and", "keeps", "offset", "per", "pane", "when", "it", "is", "idle", "or", "working", "then", "sends", "a", "message"];
const id = (r: Rng) => pick(r, IDS) + (r() < 0.3 ? String(int(r, 1, 9)) : "");
const sentence = (r: Rng, n: number) => Array.from({ length: n }, () => pick(r, WORDS)).join(" ");

function tsLine(r: Rng, jsx: boolean): string {
  const t = int(r, 0, 13);
  const pad = "  ".repeat(int(r, 0, 3));
  switch (t) {
    case 0: return `import { ${id(r)}, ${id(r)} } from "./${id(r)}.ts";`;
    case 1: return `${pad}export function ${id(r)}(${id(r)}: ${pick(r, TYPES)}): ${pick(r, TYPES)} {`;
    case 2: return `${pad}const ${id(r)} = await ${id(r)}.${id(r)}(${id(r)}, ${int(r, 0, 99)});`;
    case 3: return `${pad}if (${id(r)} === ${int(r, 0, 9)} && !${id(r)}) {`;
    case 4: return `${pad}return ${id(r)}.${id(r)} ?? ${JSON.stringify(sentence(r, 2))};`;
    case 5: return `${pad}// ${sentence(r, int(r, 3, 9))}`;
    case 6: return `${pad}}`;
    case 7: return `${pad}type ${id(r)[0]?.toUpperCase()}${id(r).slice(1)} = { ${id(r)}: ${pick(r, TYPES)}; ${id(r)}?: ${pick(r, TYPES)} };`;
    case 8: return `${pad}for (const ${id(r)} of ${id(r)}.${id(r)}) ${id(r)}.push(\`\${${id(r)}}:\${${int(r, 0, 9)}}\`);`;
    case 9: return jsx ? `${pad}<div className="flex gap-2 text-xs" onClick={() => ${id(r)}(${id(r)})}>{${id(r)}.${id(r)}}</div>` : `${pad}${id(r)}.${id(r)} = ${int(r, 0, 999)};`;
    case 10: return jsx ? `${pad}const [${id(r)}, set${id(r)}] = useState<${pick(r, TYPES)}>(${int(r, 0, 3)});` : `${pad}export const ${id(r).toUpperCase()} = ${int(r, 0, 9999)};`;
    case 11: return `${pad}  ${id(r)}: ${JSON.stringify(sentence(r, 2))},`;
    case 12: return "";
    default: return `${pad}${id(r)}(${id(r)}.${id(r)});`;
  }
}

function lineFor(ext: string, r: Rng): string {
  switch (ext) {
    case "ts": return tsLine(r, false);
    case "tsx": case "js": case "jsx": return tsLine(r, true);
    case "md": return pick(r, [`# ${sentence(r, 3)}`, `- ${sentence(r, int(r, 4, 12))}`, sentence(r, int(r, 8, 20)), "", `\`${id(r)}\` ${sentence(r, 5)}`, `| ${id(r)} | ${id(r)} | ${int(r, 0, 99)} |`]);
    case "json": return pick(r, [`  "${id(r)}": "${sentence(r, 2)}",`, `  "${id(r)}": ${int(r, 0, 9999)},`, `  "${id(r)}": ["${id(r)}", "${id(r)}"],`, "  },", `  "${id(r)}": {`]);
    case "css": return pick(r, [`.${id(r)}-${id(r)} {`, `  color: var(--${id(r)});`, `  padding: ${int(r, 0, 12)}px ${int(r, 0, 12)}px;`, "}", `  display: ${pick(r, ["flex", "grid", "block", "none"])};`, `/* ${sentence(r, 4)} */`]);
    case "toml": return pick(r, [`[${id(r)}.${id(r)}]`, `${id(r)} = "${sentence(r, 2)}"`, `${id(r)} = ${int(r, 0, 9999)}`, `# ${sentence(r, 5)}`, `${id(r)} = [ "${id(r)}", "${id(r)}" ]`]);
    case "ps1": return pick(r, [`$${id(r)} = Get-Item -Path "$env:USERPROFILE\\${id(r)}"`, `function ${id(r)}-${id(r)} { param([string]$${id(r)}) }`, `if ($${id(r)} -eq ${int(r, 0, 9)}) { Write-Host "${sentence(r, 2)}" }`, `# ${sentence(r, 5)}`, `$${id(r)} | Where-Object { $_.${id(r)} } | ForEach-Object { $_ }`]);
    case "html": case "svg": return pick(r, [`<div class="${id(r)} ${id(r)}">${sentence(r, 3)}</div>`, `  <span data-${id(r)}="${int(r, 0, 99)}">${sentence(r, 2)}</span>`, `<path d="M${int(r, 0, 99)} ${int(r, 0, 99)}L${int(r, 0, 99)} ${int(r, 0, 99)}z"/>`, `<!-- ${sentence(r, 4)} -->`]);
    case "example": return `${id(r).toUpperCase()}_${id(r).toUpperCase()}=${pick(r, ["1", "0", "http://127.0.0.1:8787", "changeme"])}`;
    default: return sentence(r, int(r, 3, 10));
  }
}

/** One long line (the spec's 400-char lines): a TypeScript object literal of many short fields. */
function longLine(r: Rng): string {
  let s = `  const ${id(r)} = { `;
  while (s.length < 400) s += `${id(r)}: ${r() < 0.5 ? int(r, 0, 9999) : JSON.stringify(pick(r, WORDS))}, `;
  return s.trimEnd() + " };";
}

// ---------------------------------------------------------------------------------------------
// Patch builder

export type FixtureFile = { path: string; oldPath?: string; kind: "modify" | "add" | "delete" | "rename" | "binary"; lines: number; long?: boolean };

function hash7(r: Rng): string {
  return Array.from({ length: 7 }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");
}

/** Builds one file's `git diff` text with about `target` body lines. Returns the text and the exact body-line count. */
export function buildFilePatch(f: FixtureFile, ext: string, target: number, r: Rng): { text: string; bodyLines: number } {
  const a = `a/${f.oldPath ?? f.path}`;
  const b = `b/${f.path}`;
  const out: string[] = [`diff --git ${a} ${b}`];
  if (f.kind === "binary") {
    out.push(`index ${hash7(r)}..${hash7(r)} 100644`, `Binary files ${a} and ${b} differ`);
    return { text: out.join("\n") + "\n", bodyLines: 0 };
  }
  if (f.kind === "rename") out.push(`similarity index ${int(r, 70, 98)}%`, `rename from ${f.oldPath}`, `rename to ${f.path}`);
  if (f.kind === "add") out.push("new file mode 100644");
  if (f.kind === "delete") out.push("deleted file mode 100644");
  out.push(`index ${hash7(r)}..${hash7(r)}${f.kind === "add" || f.kind === "delete" ? "" : " 100644"}`);
  out.push(f.kind === "add" ? "--- /dev/null" : `--- ${a}`, f.kind === "delete" ? "+++ /dev/null" : `+++ ${b}`);
  const gen = () => (f.long ? longLine(r) : lineFor(ext, r));
  let body = 0;
  let oldNo = 1;
  let newNo = 1;
  if (f.kind === "add" || f.kind === "delete") {
    const n = target;
    out.push(f.kind === "add" ? `@@ -0,0 +1,${n} @@` : `@@ -1,${n} +0,0 @@`);
    for (let i = 0; i < n; i++) out.push((f.kind === "add" ? "+" : "-") + gen());
    return { text: out.join("\n") + "\n", bodyLines: n };
  }
  while (body < target) {
    const gap = int(r, 6, 40);
    oldNo += gap;
    newNo += gap;
    const hunk: string[] = [];
    let oc = 0;
    let nc = 0;
    const ctx = (n: number) => {
      for (let i = 0; i < n; i++) { hunk.push(" " + gen()); oc++; nc++; }
    };
    const remaining = target - body;
    if (remaining <= 45) {
      // The last hunk is cut to the budget, so a fixture is its stated size (a hunk is never under 3 lines).
      const lead = remaining >= 7 ? 3 : 1;
      const change = Math.max(1, remaining - 2 * lead);
      const dels = Math.floor(change * 0.4);
      ctx(lead);
      for (let i = 0; i < dels; i++) { hunk.push("-" + gen()); oc++; }
      for (let i = 0; i < change - dels; i++) { hunk.push("+" + gen()); nc++; }
      ctx(lead);
    } else {
      ctx(3);
      for (let blocks = int(r, 1, 4); blocks > 0; blocks--) {
        const dels = int(r, 0, 6);
        const adds = dels === 0 ? int(r, 1, 8) : int(r, 0, 8);
        for (let i = 0; i < dels; i++) { hunk.push("-" + gen()); oc++; }
        for (let i = 0; i < adds; i++) { hunk.push("+" + gen()); nc++; }
        if (blocks > 1) ctx(int(r, 1, 4));
      }
      ctx(3);
    }
    out.push(`@@ -${oldNo},${oc} +${newNo},${nc} @@ ${f.long ? "" : lineFor(ext, r).trim().slice(0, 40)}`.trimEnd(), ...hunk);
    body += hunk.length;
    oldNo += oc;
    newNo += nc;
  }
  return { text: out.join("\n") + "\n", bodyLines: body };
}

export type Fixture = { name: "small" | "medium" | "large"; files: FixtureFile[]; patch: string; bodyLines: number; sizes: number[] };
export type FixtureSet = { seed: number; source: string; mix: ExtCount[]; fixtures: Fixture[] };

const DIRS = ["web2/src/components", "web2/src/lib", "bridge/threads", "shared/v2", "docs/specs", "scripts", "web/src/lib", "web2/src/routes"];

function planFiles(count: number, mix: ExtCount[], r: Rng, opts: { special: boolean }): { file: FixtureFile; ext: string }[] {
  const text = mix.filter((m) => !BINARY_EXTS.has(m.ext) && m.ext !== "(none)");
  const total = text.reduce((n, m) => n + m.count, 0);
  const extFor = () => {
    let x = r() * total;
    for (const m of text) { x -= m.count; if (x < 0) return m.ext; }
    return text[0]?.ext ?? "ts";
  };
  const files: { file: FixtureFile; ext: string }[] = [];
  for (let i = 0; i < count; i++) {
    const ext = extFor();
    files.push({ file: { path: `${pick(r, DIRS)}/${id(r)}-${i}.${ext}`, kind: "modify", lines: 0 }, ext });
  }
  if (opts.special && count >= 8) {
    // Spec: one 3,000-line file with 400-char lines, a rename, a binary and a deleted file. The first file stays ordinary.
    files[7] = { file: { path: "web2/src/lib/generated-table-7.ts", kind: "modify", lines: 0, long: true }, ext: "ts" };
    files[3] = { file: { path: "web2/src/components/NewPanelName-3.tsx", oldPath: "web2/src/components/OldPanelName-3.tsx", kind: "rename", lines: 0 }, ext: "tsx" };
    files[11] = { file: { path: "web2/public/shot-11.png", kind: "binary", lines: 0 }, ext: "png" };
    files[15] = { file: { path: "web2/src/lib/removed-15.ts", kind: "delete", lines: 0 }, ext: "ts" };
    files[19] = { file: { path: "docs/specs/added-19.md", kind: "add", lines: 0 }, ext: "md" };
  }
  return files;
}

function buildFixture(name: Fixture["name"], fileCount: number, totalLines: number, mix: ExtCount[], seed: number): Fixture {
  const r = rngFrom(seed);
  const plan = planFiles(fileCount, mix, r, { special: name === "large" });
  const long = plan.findIndex((p) => p.file.long);
  const budget = totalLines - (long >= 0 ? 3000 : 0);
  const normal = plan.filter((p, i) => i !== long && p.file.kind !== "binary");
  // Weighted random split of the budget across the ordinary files, each at least 12 lines.
  const weights = normal.map(() => 0.4 + r());
  const wsum = weights.reduce((n, w) => n + w, 0);
  const sizes = new Map<number, number>();
  normal.forEach((p, k) => sizes.set(plan.indexOf(p), Math.max(12, Math.round((budget * (weights[k] as number)) / wsum))));
  if (long >= 0) sizes.set(long, 3000);
  let patch = "";
  let body = 0;
  const outSizes: number[] = [];
  plan.forEach((p, i) => {
    const target = p.file.kind === "binary" ? 0 : (sizes.get(i) ?? 12);
    const built = buildFilePatch(p.file, p.ext, target, r);
    p.file.lines = built.bodyLines;
    patch += built.text;
    body += built.bodyLines;
    outSizes.push(built.bodyLines);
  });
  return { name, files: plan.map((p) => p.file), patch, bodyLines: body, sizes: outSizes };
}

export function generateFixtures(mix: MixSource, seed = 25): FixtureSet {
  const top12 = mix.all.slice(0, 12);
  return {
    seed,
    source: mix.source,
    mix: top12,
    fixtures: [
      buildFixture("small", 1, 50, top12, seed + 1),
      buildFixture("medium", 3, 1500, top12, seed + 2),
      buildFixture("large", 40, 10000, top12, seed + 3),
    ],
  };
}

export function writeFixtures(set: FixtureSet, out: string): string[] {
  mkdirSync(out, { recursive: true });
  const written: string[] = [];
  for (const f of set.fixtures) {
    const p = join(out, `${f.name}.patch`);
    writeFileSync(p, f.patch);
    written.push(p);
  }
  const manifest = {
    seed: set.seed,
    source: set.source,
    mix: set.mix,
    fixtures: set.fixtures.map((f) => ({ name: f.name, files: f.files.length, bodyLines: f.bodyLines, maxFileLines: Math.max(...f.sizes), entries: f.files })),
  };
  const mp = join(out, "manifest.json");
  writeFileSync(mp, JSON.stringify(manifest, null, 2) + "\n");
  written.push(mp);
  return written;
}

// ---------------------------------------------------------------------------------------------
// Report: the README table

/** One id per row of the spec's threshold table, in its order. */
export const THRESHOLD_ROWS: { id: string; label: string; pass: string }[] = [
  { id: "licence", label: "Licence of the package and every runtime dependency", pass: "MIT, Apache-2.0, BSD or ISC" },
  { id: "main-gzip", label: "Main chunk gzip growth (seam and Suspense)", pass: "<= +2 KB" },
  { id: "lazy-gzip", label: "Lazy chunk gzip: renderer, worker, grammars for one language", pass: "<= 150 KB" },
  { id: "dist-gzip", label: "Total dist JS gzip growth", pass: "<= +400 KB (or grammars left out of precache)" },
  { id: "cold-fetch", label: "Cold fetch of the lazy chunk (median of 5, SW cleared)", pass: "<= 1.0 s cold, <= 100 ms warm" },
  { id: "first-render", label: "First render, 50 / 1,500 lines (390 px, 4x CPU)", pass: "<= 50 ms / 300 ms" },
  { id: "large-paint", label: "First paint of first file, large patch", pass: "<= 800 ms, no long task > 250 ms" },
  { id: "commits", label: "React commits for one first render", pass: "<= 3, no loop" },
  { id: "jank", label: "Scroll jank, large patch, 5 s fling", pass: "p95 frame <= 20 ms, <= 10% dropped" },
  { id: "dom", label: "Mounted DOM nodes, large patch", pass: "<= 5,000" },
  { id: "heap", label: "Heap, large patch (Chrome)", pass: "<= +60 MB, within 20% of baseline after unmount" },
  { id: "worker-csp", label: "Worker under the bridge CSP, SW active", pass: "0 violations, same-origin worker, no WASM, falls back" },
  { id: "features", label: "Split, expand-unchanged, line annotations behind the seam", pass: "native or <= 150 adapter lines" },
  { id: "coverage", label: "Highlight coverage of the corpus's changed files", pass: ">= 90%" },
  { id: "touch-a11y", label: "Touch and accessibility", pass: "44 px gutter, selectable, old-then-new order, no page h-scroll" },
];

/**
 * `true`/`false` pass or fail, `null` = recorded but not decidable (n/a, or pending a real-phone trial).
 * `strict: false` marks a pass on the main reading that fails a harder one (the large-patch rows are also
 * run with the 3,000-line, 400-character-line file open): the table says so, the reader weighs it.
 */
export type Cell = { value: string; pass: boolean | null; strict?: boolean };
export type CandidateResult = { name: string; version: string; rows: Record<string, Cell> };
export type Results = { device: string; measuredAt: string; candidates: Record<string, CandidateResult> };

export function missingRows(results: Results): string[] {
  const missing: string[] = [];
  for (const [key, c] of Object.entries(results.candidates)) {
    for (const row of THRESHOLD_ROWS) if (!c.rows[row.id]) missing.push(`${key}:${row.id}`);
  }
  if (Object.keys(results.candidates).length === 0) missing.push("(no candidates)");
  return missing;
}

const mark = (c: Cell) => (c.pass === true ? (c.strict === false ? "pass on (a), FAIL on (b)" : "pass") : c.pass === false ? "FAIL" : "n/a");
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderReport(results: Results): string {
  const missing = missingRows(results);
  if (missing.length > 0) throw new Error(`the table is missing threshold rows: ${missing.join(", ")}`);
  const keys = Object.keys(results.candidates);
  const head = ["Measure", "Pass", ...keys.map((k) => `${k}: ${results.candidates[k]?.name} ${results.candidates[k]?.version}`)];
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const row of THRESHOLD_ROWS) {
    const cells = keys.map((k) => {
      const c = (results.candidates[k] as CandidateResult).rows[row.id] as Cell;
      return `${esc(c.value)} (${mark(c)})`;
    });
    lines.push(`| ${esc(row.label)} | ${esc(row.pass)} | ${cells.join(" | ")} |`);
  }
  const verdict = keys.map((k) => {
    const rows = Object.values((results.candidates[k] as CandidateResult).rows);
    const failed = THRESHOLD_ROWS.filter((r) => (results.candidates[k] as CandidateResult).rows[r.id]?.pass === false).map((r) => r.id);
    const strict = THRESHOLD_ROWS.filter((r) => (results.candidates[k] as CandidateResult).rows[r.id]?.strict === false).map((r) => r.id);
    return `- ${k}: ${failed.length === 0 ? "every decidable row passes" : `fails ${failed.join(", ")}`}${strict.length ? `; passes on (a) but fails on (b): ${strict.join(", ")}` : ""} (${rows.filter((c) => c.pass === null).length} row(s) n/a or pending)`;
  });
  return [`Device and method: ${results.device}. Measured ${results.measuredAt}.`, "", ...lines, "", ...verdict, ""].join("\n");
}

export const TABLE_START = "<!-- diff-spike:table -->";
export const TABLE_END = "<!-- /diff-spike:table -->";

export function spliceTable(readme: string, table: string): string {
  const a = readme.indexOf(TABLE_START);
  const b = readme.indexOf(TABLE_END);
  if (a < 0 || b < a) throw new Error(`README has no ${TABLE_START} ... ${TABLE_END} block`);
  const eol = readme.includes("\r\n") ? "\r\n" : "\n"; // the README may be checked out with CRLF
  return readme.slice(0, a + TABLE_START.length) + eol + table.replace(/\r?\n/g, eol) + readme.slice(b);
}

// ---------------------------------------------------------------------------------------------
// CLI

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export type JsdomRow = Record<string, number | string>;

/** Markdown for the harness's rows: one table, a row per fixture. */
export function jsdomTable(rows: JsdomRow[]): string {
  const cols = Object.keys(rows[0] ?? {});
  return [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${cols.map((c) => String(r[c])).join(" | ")} |`)].join("\n");
}

function jsdomRun(adapter: string): number {
  const out = join(WEB2, ".spike-diffs", `jsdom-${adapter}.json`);
  mkdirSync(dirname(out), { recursive: true });
  if (!existsSync(join(DEFAULT_OUT, "large.patch"))) writeFixtures(generateFixtures(resolveMix("auto")), DEFAULT_OUT);
  // SIGHTR_DIFFS points the seam's `diffs-adapter` alias at the candidate, as a build would.
  const r = Bun.spawnSync(["bunx", "vitest", "run", "src/components/diffs/spike.harness.test.tsx"], {
    cwd: WEB2,
    env: { ...process.env, SIGHTR_SPIKE_ADAPTER: adapter, SIGHTR_SPIKE_OUT: out, SIGHTR_DIFFS: adapter },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (r.exitCode !== 0 || !existsSync(out)) return r.exitCode || 1;
  console.log(jsdomTable((JSON.parse(readFileSync(out, "utf8")) as { rows: JsdomRow[] }).rows));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "fixtures") {
    const out = resolve(flag(rest, "--out") ?? DEFAULT_OUT);
    const mix = resolveMix(flag(rest, "--source") ?? "auto");
    const set = generateFixtures(mix, Number(flag(rest, "--seed") ?? 25));
    for (const p of writeFixtures(set, out)) console.log(p);
    console.log(`mix: ${set.source}; ${set.mix.map((m) => `${m.ext}=${m.count}`).join(" ")}`);
    return 0;
  }
  if (cmd === "jsdom") {
    const adapter = rest[0];
    if (!adapter || !/^[a-z]+$/.test(adapter)) { console.error("usage: diff-spike.ts jsdom <status|hand|pierre>"); return 2; }
    return jsdomRun(adapter);
  }
  if (cmd === "report") {
    const file = flag(rest, "--results");
    if (!file) { console.error("usage: diff-spike.ts report --results <results.json> [--readme <file>] [--write]"); return 2; }
    const results = JSON.parse(readFileSync(resolve(file), "utf8")) as Results;
    const table = renderReport(results);
    const readme = resolve(flag(rest, "--readme") ?? join(ROOT, "docs", "specs", "t3", "README.md"));
    if (rest.includes("--write")) writeFileSync(readme, spliceTable(readFileSync(readme, "utf8"), table));
    else console.log(table);
    return 0;
  }
  console.error("usage: diff-spike.ts fixtures | jsdom <adapter> | report --results <file> [--readme <file>] [--write]");
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { console.error((e as Error).message); process.exit(1); },
  );
}
