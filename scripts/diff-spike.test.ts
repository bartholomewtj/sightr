import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MIX,
  THRESHOLD_ROWS,
  TABLE_END,
  TABLE_START,
  countExts,
  extOf,
  extsFromSqlite,
  generateFixtures,
  missingRows,
  renderReport,
  spliceTable,
  writeFixtures,
  type Results,
} from "./diff-spike.ts";

const mix = { source: "test", all: DEFAULT_MIX };

describe("fixtures", () => {
  test("are deterministic: the same seed and mix write the same bytes twice", () => {
    const a = mkdtempSync(join(tmpdir(), "spike-a-"));
    const b = mkdtempSync(join(tmpdir(), "spike-b-"));
    try {
      writeFixtures(generateFixtures(mix, 25), a);
      writeFixtures(generateFixtures(mix, 25), b);
      const names = readdirSync(a).sort();
      expect(names).toEqual(["large.patch", "manifest.json", "medium.patch", "small.patch"]);
      expect(readdirSync(b).sort()).toEqual(names);
      for (const n of names) expect(readFileSync(join(a, n), "utf8")).toBe(readFileSync(join(b, n), "utf8"));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test("a different seed changes them", () => {
    const x = generateFixtures(mix, 1).fixtures[1]?.patch;
    const y = generateFixtures(mix, 2).fixtures[1]?.patch;
    expect(x).not.toBe(y);
  });

  test("have the specified shapes", () => {
    const [small, medium, large] = generateFixtures(mix, 25).fixtures;
    expect(small?.files).toHaveLength(1);
    expect(small?.bodyLines).toBe(50);
    expect(medium?.files).toHaveLength(3);
    expect(medium?.bodyLines).toBeGreaterThanOrEqual(1500);
    expect(medium?.bodyLines).toBeLessThan(1560);
    expect(large?.files).toHaveLength(40);
    expect(large?.bodyLines).toBeGreaterThanOrEqual(10000);
    expect(large?.bodyLines).toBeLessThan(10100);
    const kinds = new Set(large?.files.map((f) => f.kind));
    for (const k of ["modify", "rename", "binary", "delete"]) expect(kinds.has(k as "modify")).toBe(true);
    expect(Math.max(...(large?.sizes ?? []))).toBe(3000);
    const longest = Math.max(...(large?.patch.split("\n").map((l) => l.length) ?? [0]));
    expect(longest).toBeGreaterThanOrEqual(400);
    expect(large?.files[0]?.kind).toBe("modify"); // the first file is an ordinary one
  });

  test("hunk headers agree with their bodies", () => {
    const large = generateFixtures(mix, 25).fixtures[2];
    let hunks = 0;
    const rows = (large?.patch ?? "").split("\n");
    for (let i = 0; i < rows.length; i++) {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(rows[i] ?? "");
      if (!m) continue;
      let oc = 0;
      let nc = 0;
      for (i++; i < rows.length && /^[ +-]/.test(rows[i] ?? ""); i++) {
        const c = (rows[i] as string)[0];
        if (c !== "+") oc++;
        if (c !== "-") nc++;
      }
      i--;
      expect([oc, nc]).toEqual([Number(m[1] ?? 1), Number(m[2] ?? 1)]);
      hunks++;
    }
    expect(hunks).toBeGreaterThan(100);
  });
});

describe("extension counts", () => {
  test("extOf and countExts", () => {
    expect(extOf("a/b/c.TS")).toBe("ts");
    expect(extOf("Makefile")).toBe("(none)");
    expect(countExts(["a.ts", "b.ts", "c.md"])).toEqual([{ ext: "ts", count: 2 }, { ext: "md", count: 1 }]);
  });

  test("extsFromSqlite reads file_change names read-only and counts extensions only", () => {
    const dir = mkdtempSync(join(tmpdir(), "spike-db-"));
    const path = join(dir, "threads.sqlite");
    try {
      const db = new Database(path);
      db.run("CREATE TABLE turn_items (id TEXT PRIMARY KEY, type TEXT NOT NULL, body_json TEXT NOT NULL)");
      const ins = db.prepare("INSERT INTO turn_items VALUES (?, ?, ?)");
      ins.run("1", "file_change", JSON.stringify({ fileName: "src/a.ts", diffStr: "secret" }));
      ins.run("2", "file_change", JSON.stringify({ fileName: "src/b.ts" }));
      ins.run("3", "file_change", JSON.stringify({ fileName: "README.md" }));
      ins.run("4", "assistant_message", JSON.stringify({ text: "x.rs" }));
      ins.run("5", "file_change", "not json");
      ins.finalize();
      db.close();
      expect(extsFromSqlite(path)).toEqual([{ ext: "ts", count: 2 }, { ext: "md", count: 1 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fullResults(): Results {
  const rows = Object.fromEntries(THRESHOLD_ROWS.map((r) => [r.id, { value: "1 KB", pass: true as boolean | null }]));
  return { device: "test", measuredAt: "2026-10-18", candidates: { A: { name: "a", version: "1", rows: { ...rows } }, C: { name: "c", version: "-", rows: { ...rows } } } };
}

describe("report", () => {
  test("renders every threshold row for every candidate", () => {
    const md = renderReport(fullResults());
    for (const r of THRESHOLD_ROWS) expect(md).toContain(r.label);
    expect(md).toContain("A: a 1");
    expect(md).toContain("every decidable row passes");
  });

  test("rejects a table missing a threshold row", () => {
    const res = fullResults();
    delete (res.candidates.A as { rows: Record<string, unknown> }).rows["heap"];
    expect(missingRows(res)).toEqual(["A:heap"]);
    expect(() => renderReport(res)).toThrow(/A:heap/);
  });

  test("rejects an empty table", () => {
    expect(() => renderReport({ device: "", measuredAt: "", candidates: {} })).toThrow();
  });

  test("lists failed rows in the verdict and keeps n/a rows visible", () => {
    const res = fullResults();
    (res.candidates.C as { rows: Record<string, { value: string; pass: boolean | null }> }).rows["dom"] = { value: "12,000", pass: false };
    (res.candidates.C as { rows: Record<string, { value: string; pass: boolean | null }> }).rows["heap"] = { value: "n/a", pass: null };
    const md = renderReport(res);
    expect(md).toContain("C: fails dom (1 row(s) n/a or pending)");
    expect(md).toContain("12,000 (FAIL)");
  });

  test("a pass that fails the harder reading says so", () => {
    const res = fullResults();
    (res.candidates.A as { rows: Record<string, { value: string; pass: boolean | null; strict?: boolean }> }).rows["dom"] = { value: "1,900 / 617,000", pass: true, strict: false };
    const md = renderReport(res);
    expect(md).toContain("1,900 / 617,000 (pass on (a), FAIL on (b))");
    expect(md).toContain("passes on (a) but fails on (b): dom");
  });

  test("spliceTable replaces only the marked block", () => {
    const readme = `before\n${TABLE_START}\nold\n${TABLE_END}\nafter\n`;
    const out = spliceTable(readme, "NEW\n");
    expect(out).toBe(`before\n${TABLE_START}\nNEW\n${TABLE_END}\nafter\n`);
    expect(() => spliceTable("no markers", "x")).toThrow();
    // a README checked out with CRLF gets a CRLF table, not a mix
    const crlf = spliceTable(`a\r\n${TABLE_START}\r\nold\r\n${TABLE_END}\r\n`, "r1\nr2\n");
    expect(crlf).toBe(`a\r\n${TABLE_START}\r\nr1\r\nr2\r\n${TABLE_END}\r\n`);
  });
});
