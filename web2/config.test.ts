import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Resolved through v1Scope (vitest.config.ts): agent-commands.ts says `@/lib/operator-scope`.
import { commandsFor } from "@v1/lib/agent-commands";

import { T3_SHIMS } from "./t3-shims";
import { isUnder, scopedTarget } from "./v1-scope";

const here = import.meta.dirname;
const dirs = { web2Src: resolve(here, "src"), v1Src: resolve(here, "../web/src") };

describe("v1-scope", () => {
  it("resolves `@/` inside a v1 file to v1's tree", () => {
    const importer = resolve(here, "../web/src/lib/agent-commands.ts");
    const target = scopedTarget("@/lib/operator-scope", importer, dirs);
    expect(target).toBe(resolve(here, "../web/src/lib/operator-scope"));
    expect(existsSync(`${target}.ts`)).toBe(true);
  });

  it("resolves `@/` anywhere else to web2's tree", () => {
    expect(scopedTarget("@/stream/apply", resolve(here, "src/main.tsx"), dirs)).toBe(resolve(here, "src/stream/apply"));
    expect(scopedTarget("@/x", undefined, dirs)).toBe(resolve(here, "src/x"));
    expect(scopedTarget("@shared/v2/contracts", resolve(here, "src/main.tsx"), dirs)).toBeNull();
  });

  it("does not treat a sibling folder that shares the prefix as v1", () => {
    expect(isUnder(resolve(here, "../web/src-old/x.ts"), dirs.v1Src)).toBe(false);
    expect(isUnder(resolve(here, "../web/src/lib/x.ts?import"), dirs.v1Src)).toBe(true);
  });

  it("makes a real import of a v1 file that uses `@/lib` pick up the v1 sibling", () => {
    // commandsFor runs rowsFor from agent-commands' own `@/lib/operator-scope`; web2 has no such file,
    // so this import only loads at all when the importer-aware resolver sends it to v1.
    expect(commandsFor("claude").length).toBeGreaterThan(0);
  });
});

describe("t3 shims", () => {
  it("lists every shim in tsconfig paths too, pointing at the same file", () => {
    const tsconfig = JSON.parse(
      readFileSync(resolve(here, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
    ) as { compilerOptions: { paths: Record<string, string[]> } };
    for (const [spec, file] of Object.entries(T3_SHIMS)) {
      expect(tsconfig.compilerOptions.paths[spec]).toEqual([`./${file}`]);
      expect(existsSync(resolve(here, file))).toBe(true);
    }
  });

  it("keeps the manifest pointing at files that exist", () => {
    const manifest = JSON.parse(readFileSync(resolve(here, "t3-upstream.json"), "utf8")) as {
      files: { local: string; upstream: string; commit: string; mode: string }[];
    };
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const row of manifest.files) {
      expect(existsSync(resolve(here, row.local)), row.local).toBe(true);
      expect(row.commit).toMatch(/^[0-9a-f]{8,40}$/);
      expect(["verbatim", "adapted", "pattern", "shape"]).toContain(row.mode);
    }
  });

  it("gives every adapted file a header naming its upstream path", () => {
    const manifest = JSON.parse(readFileSync(resolve(here, "t3-upstream.json"), "utf8")) as {
      files: { local: string; upstream: string; mode: string }[];
    };
    for (const row of manifest.files.filter((r) => r.mode === "adapted")) {
      const head = readFileSync(resolve(here, row.local), "utf8").split(/\r?\n/).slice(0, 8).join(" ");
      expect(head, row.local).toContain("T3 Code");
      expect(head, `${row.local} names ${row.upstream}`).toContain(row.upstream);
    }
  });
});
