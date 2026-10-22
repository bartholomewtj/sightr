/**
 * A build-time budget over `web2/dist` (issue #155, Phase 1's exit criterion).
 *
 * Spec 27 removed 266 KB of KaTeX from the thread route's static import closure and nothing stopped it
 * coming back: the snapshot cap and the gzip path have functional tests, but no test fails when the
 * *bundle* grows. This walks the **eager** graph the browser downloads on a cold thread open — the
 * entry module plus the `_chat.thread._threadId` route chunk and everything they statically import
 * (dynamic `import()`s are other routes and lazy chunks, so they stay out) — and fails CI when the raw
 * or gzipped total crosses a documented ceiling.
 *
 * The walk is the same graph Vite's build manifest describes; it matches the 27-chunk / 1,463 KB
 * number spec 27 recorded and the manifest's own `imports` closure exactly (verified 22 Oct 2026), so
 * the build emits no extra artifact for it.
 *
 * The snapshot frame's own bound (`v2-routes.test.ts`: a thread snapshot carries at most
 * `MAX_SNAPSHOT_ITEMS`) stays the snapshot-size assertion; this file budgets the bundle around it.
 *
 * When the bundle legitimately grows, raise `THREAD_ROUTE_BUDGET` in the same PR and say why in the
 * commit — that edit is the review trigger.
 *
 * Run after `bun run build:web2`:
 *   bun scripts/web2-budget.ts [distDir] [--json]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

/** The v2 thread route chunk. Vite names it after the route file; the hash changes per build. */
export const THREAD_ROUTE_CHUNK = /^_chat\.thread\._threadId-.*\.js$/;

/**
 * The documented ceilings for the thread-route closure, raw and gzipped. Measured 22 Oct 2026:
 * ~1,692 KB raw / ~507 KB gzipped across 29 entries (27 JS chunks + theme-init.js + the entry CSS). KaTeX re-imported
 * eagerly is the regression this is sized against: it adds ~268 KB raw / ~70 KB gzip to the closure,
 * which clears both ceilings.
 */
export const THREAD_ROUTE_BUDGET = { rawBytes: 1_800 * 1024, gzipBytes: 560 * 1024 } as const;

export interface Budget {
  rawBytes: number;
  gzipBytes: number;
}
export interface MeasuredFile {
  /** Path relative to the dist tree, forward-slashed. */
  rel: string;
  raw: number;
  gzip: number;
}
export interface BundleMeasure {
  files: MeasuredFile[];
  raw: number;
  gzip: number;
}

const bytes = (p: string): Uint8Array => new Uint8Array(readFileSync(p));

/** Gzip the way the bridge ships it (`Bun.gzipSync`), falling back to zlib off-Bun. */
export function gzipBytes(input: Uint8Array): number {
  return typeof Bun !== "undefined" ? Bun.gzipSync(input as Uint8Array<ArrayBuffer>).length : gzipSync(input).length;
}

/**
 * Static (eager) import specifiers in a built chunk. `import("./x.js")` is dynamic and deliberately
 * does not match: the regex requires a quote right after the keyword, so an `import(` never qualifies.
 * The `;`/`(` exclusions stop a match bridged across statements by `import.meta` or a string.
 */
export function staticSpecifiers(code: string): string[] {
  const out: string[] = [];
  const re = /(?<![.\w$])(?:import|export)(?![.\w$])\s*(?:[^"'();]*?from\s*)?(["'])([^"']+)\1/g;
  for (const m of code.matchAll(re)) out.push(m[2]!);
  return out;
}

/**
 * Every file reachable from `starts` by static import, resolved to absolute paths. Depth-first so a
 * cycle (the entry imports a chunk that imports the entry) terminates; the return order is stable.
 */
export function moduleClosure(starts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (raw: string): void => {
    const file = resolve(raw); // one spelling per file, so a relative start and an absolute import agree
    if (seen.has(file)) return;
    seen.add(file);
    out.push(file);
    let code: string;
    try {
      code = readFileSync(file, "utf8");
    } catch {
      return; // a chunk listed but missing on disk: skip, it contributes no bytes
    }
    for (const spec of staticSpecifiers(code)) {
      if (!spec.startsWith(".")) continue;
      visit(resolve(dirname(file), spec));
    }
  };
  for (const start of starts) visit(start);
  return out;
}

/** The entry module, its modulepreloads and the entry CSS, read from the built `index.html`. */
export function entryFiles(distDir: string): string[] {
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  const rels = new Set<string>();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) rels.add(m[1]!);
  for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) rels.add(m[1]!);
  const out: string[] = [];
  for (const rel of rels) {
    if (/^https?:/i.test(rel)) continue;
    if (!/\.(?:js|css)$/i.test(rel)) continue;
    out.push(join(distDir, ...rel.replace(/^\/+/, "").split("/")));
  }
  return out;
}

/** The thread route's chunk(s) under `dist/assets`. */
export function threadRouteStarts(distDir: string): string[] {
  const assets = join(distDir, "assets");
  let names: string[];
  try {
    names = readdirSync(assets);
  } catch {
    return [];
  }
  return names.filter((n) => THREAD_ROUTE_CHUNK.test(n)).map((n) => join(assets, n));
}

/** Measure the thread-route closure the browser downloads on a cold thread open. */
export function measureThreadRoute(distDir: string): BundleMeasure {
  const root = resolve(distDir);
  const starts = [...entryFiles(root), ...threadRouteStarts(root)];
  const closure = moduleClosure(starts);
  const files: MeasuredFile[] = closure
    .map((full) => ({ rel: relative(root, full).split(sep).join("/"), raw: statSync(full).size, gzip: gzipBytes(bytes(full)) }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
  return {
    files,
    raw: files.reduce((n, f) => n + f.raw, 0),
    gzip: files.reduce((n, f) => n + f.gzip, 0),
  };
}

/** Each ceiling the measurement crossed, as a human line. Empty when within budget. */
export function budgetViolations(measured: BundleMeasure, budget: Budget): string[] {
  const out: string[] = [];
  if (measured.raw > budget.rawBytes) out.push(`raw ${kb(measured.raw)} KB > ${kb(budget.rawBytes)} KB budget`);
  if (measured.gzip > budget.gzipBytes) out.push(`gzip ${kb(measured.gzip)} KB > ${kb(budget.gzipBytes)} KB budget`);
  return out;
}

const kb = (n: number): string => (n / 1024).toLocaleString("en-US", { maximumFractionDigits: 0 });

/** The report the CLI and tests share. */
export function formatReport(measured: BundleMeasure, budget: Budget): string {
  const lines = [
    `web2 thread-route closure — ${measured.files.length} files`,
    `  raw   ${kb(measured.raw).padStart(6)} KB  / ${kb(budget.rawBytes)} KB budget`,
    `  gzip  ${kb(measured.gzip).padStart(6)} KB  / ${kb(budget.gzipBytes)} KB budget`,
  ];
  const violations = budgetViolations(measured, budget);
  lines.push(violations.length === 0 ? "  OK" : `  OVER BUDGET: ${violations.join("; ")}`);
  return lines.join("\n");
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const distDir = argv.find((a) => !a.startsWith("--")) ?? join(import.meta.dir, "..", "web2", "dist");
  let measured: BundleMeasure;
  try {
    if (threadRouteStarts(distDir).length === 0) {
      throw new Error(`no ${THREAD_ROUTE_CHUNK} chunk under ${distDir}/assets`);
    }
    measured = measureThreadRoute(distDir);
  } catch (e) {
    console.error(`web2-budget: ${(e as Error).message}`);
    console.error(`web2-budget: build first — cd web2 && bun run build`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify({ measured, budget: THREAD_ROUTE_BUDGET, violations: budgetViolations(measured, THREAD_ROUTE_BUDGET) }, null, 2));
  } else {
    console.log(formatReport(measured, THREAD_ROUTE_BUDGET));
  }
  return budgetViolations(measured, THREAD_ROUTE_BUDGET).length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
