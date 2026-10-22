import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// shared/harness/ is imported by the bridge at runtime and by the root typecheck, which runs before
// web's `bun install` in CI. So nothing here may reach a package (react, katex, …) or a web alias
// (`@shared`, `@/`, `@v1`): every specifier must be a relative path or a node:/bun: builtin. Spec 28
// (#145) is the last slice of the extraction that made this true; see docs/specs/28-bridge-free-of-web.md.
//
// Kept in scripts/ rather than beside the code because web2's tsc compiles shared/ but has no
// bun:test types — a test file under shared/ would break the web2 typecheck.

/** The folder this guard covers, in this checkout. */
export const HARNESS_DIR = join(import.meta.dir, "..", "shared", "harness");

const SPECIFIER = /(?<![.\w$])(?:import|export)(?![.\w$])\s*(?:[^"'();]*?from\s*)?(["'])([^"']+)\1/g;

/** A specifier shared/harness may use: a relative path or a runtime builtin. */
export function isAllowedSpecifier(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("bun:");
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** `file:line: specifier` for every import shared/harness must not have. Empty is the invariant. */
export function forbiddenImports(dir: string = HARNESS_DIR): string[] {
  const hits: string[] = [];
  for (const file of sources(dir)) {
    const rel = relative(dir, file).split("\\").join("/");
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const m of line.matchAll(SPECIFIER)) {
          const spec = m[2]!;
          if (!isAllowedSpecifier(spec)) hits.push(`${rel}:${i + 1}: ${spec}`);
        }
      });
  }
  return hits;
}

if (import.meta.main) {
  const hits = forbiddenImports(process.argv[2] ?? HARNESS_DIR);
  for (const h of hits) console.log(h);
  process.exit(hits.length > 0 ? 1 : 0);
}
