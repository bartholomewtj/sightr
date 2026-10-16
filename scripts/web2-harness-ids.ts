import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { AGENTS } from "../shared/agents.ts";

// The v2 UI rule (T08): web2 reads `thread.capabilities`, never the harness name. No harness id as a
// string literal and no `agent ===` / `harness ===` comparison in web2/src, outside the harness icon
// map (AgentIcon.tsx) and tests. web2/ arrives with the feat/v2-web merge; until then there is
// nothing to scan.

/** web2's source folder in this checkout. */
export const WEB2_SRC = join(import.meta.dir, "..", "web2", "src");
const ALLOWED = new Set(["components/AgentIcon.tsx"]);

const ids = [...new Set(AGENTS.flatMap((a) => [a.id, a.family, ...a.prefixes.map((p) => p.replace(/[-.]$/, ""))]))];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const ID_LITERAL = new RegExp(`(["'\`])(?:${ids.map(escape).join("|")})\\1`);
export const ID_COMPARE = /\b(?:agent|harness)\s*[!=]==|[!=]==\s*[\w.?]*\b(?:agent|harness)\b|switch\s*\(\s*[\w.?]*\b(?:agent|harness)\s*\)/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" || entry.name === "node_modules") continue;
      out.push(...sources(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** `file:line: text` for every line that names a harness. */
export function harnessIdHits(srcDir: string): string[] {
  const hits: string[] = [];
  for (const file of sources(srcDir)) {
    const rel = relative(srcDir, file).replace(/\\/g, "/");
    if (ALLOWED.has(rel)) continue;
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (ID_LITERAL.test(line) || ID_COMPARE.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
  return hits;
}


if (import.meta.main) {
  const hits = harnessIdHits(process.argv[2] ?? WEB2_SRC);
  for (const h of hits) console.log(h);
  process.exit(hits.length > 0 ? 1 : 0);
}
