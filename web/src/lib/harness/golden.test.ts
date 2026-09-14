import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { adapterFor } from "./registry";

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");
const GOLDEN_PATH = join(import.meta.dirname, "golden.blocks.json");
type Golden = Record<string, unknown> & { _generated?: { commit: string; note: string } };

function fixtureNames(): string[] {
  return readdirSync(PANES_DIR).filter((name) => name.endsWith(".txt")).sort();
}
function blocksFor(name: string) {
  const agent = name.split("--", 1)[0]!;
  const adapter = adapterFor(agent);
  if (!adapter) throw new Error(`No adapter for fixture ${name}`);
  const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
  return adapter.buildBlocks(lines).map((block) => ({
    kind: block.kind,
    lines: block.lines.length,
    sha: createHash("sha256").update(JSON.stringify(block)).digest("hex").slice(0, 16),
  }));
}

describe("adapter block golden", () => {
  it("matches the committed pre-refactor output for every fixture", () => {
    const names = fixtureNames();
    if (process.env.UPDATE_BLOCK_GOLDEN === "1") {
      const commit = process.env.GOLDEN_BASE_COMMIT;
      if (!commit) throw new Error("GOLDEN_BASE_COMMIT is required when regenerating the block golden");
      const data: Golden = { _generated: { commit, note: "Generated from main before shared scanner refactor" } };
      for (const name of names) data[name] = blocksFor(name);
      writeFileSync(GOLDEN_PATH, JSON.stringify(data));
      return;
    }
    if (!existsSync(GOLDEN_PATH)) throw new Error(`Missing ${GOLDEN_PATH}`);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden;
    const recorded = Object.keys(golden).filter((name) => name !== "_generated").sort();
    expect(recorded).toEqual(names);
    for (const name of names) expect(blocksFor(name), name).toEqual(golden[name]);
  });
});
