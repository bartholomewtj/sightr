import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  budgetViolations,
  formatReport,
  measureThreadRoute,
  moduleClosure,
  staticSpecifiers,
  THREAD_ROUTE_CHUNK,
} from "./web2-budget.ts";

describe("staticSpecifiers", () => {
  test("reads static imports and re-exports, minified or spaced", () => {
    expect(staticSpecifiers(`import{r as e}from"./a.js";`)).toEqual(["./a.js"]);
    expect(staticSpecifiers(`import {\n x\n} from "./b.js";`)).toEqual(["./b.js"]);
    expect(staticSpecifiers(`export{a as b}from'./c.js'`)).toEqual(["./c.js"]);
    expect(staticSpecifiers(`import"./side.js"`)).toEqual(["./side.js"]);
  });

  test("ignores dynamic imports and import.meta", () => {
    expect(staticSpecifiers(`const p=import("./lazy.js")`)).toEqual([]);
    expect(staticSpecifiers(`const u=import.meta.url;const v="from \`x\`"`)).toEqual([]);
  });

  test("does not bridge across a statement separator", () => {
    expect(staticSpecifiers(`const a=1;const b="from \\"./nope.js\\""`)).toEqual([]);
  });
});

describe("web2 bundle budget", () => {
  let dist: string;

  const write = async (rel: string, body: string): Promise<void> => {
    const full = join(dist, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  };

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), "web2-budget-"));
    await write(
      "index.html",
      `<!doctype html><html><head>` +
        `<script src="/theme-init.js"></script>` +
        `<link rel="stylesheet" href="/assets/index-aaa.css">` +
        `<link rel="modulepreload" href="/assets/shared-bbb.js">` +
        `</head><body><script type="module" src="/assets/index-ccc.js"></script></body></html>`,
    );
    // The entry statically imports shared and pulls in its stylesheet; the lazy route is dynamic.
    await write("assets/index-ccc.js", `import{a}from"./shared-bbb.js";import("./lazy-eee.js");`);
    await write("assets/shared-bbb.js", `export const a=1;`);
    await write("assets/lazy-eee.js", `export const lazy=1;`);
    // The thread route pulls in a shared + its own chunk.
    await write("assets/_chat.thread._threadId-ddd.js", `import{b}from"./shared-bbb.js";import{c}from"./itemJump-fff.js";`);
    await write("assets/itemJump-fff.js", `import{d}from"./shared-bbb.js";`);
    await write("assets/index-aaa.css", `:root{color:red}`);
    await write("theme-init.js", `document.documentElement.classList.add("dark");`);
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  test("finds the thread route chunk by its fixed prefix", () => {
    expect(THREAD_ROUTE_CHUNK.test("_chat.thread._threadId-abc123.js")).toBe(true);
    expect(THREAD_ROUTE_CHUNK.test("_chat.index-abc123.js")).toBe(false);
  });

  test("the closure is eager only: the lazy route stays out", () => {
    const closure = moduleClosure([
      join(dist, "assets/index-ccc.js"),
      join(dist, "assets/_chat.thread._threadId-ddd.js"),
    ]).map((f) => f.slice(dist.length + 1).replace(/\\/g, "/"));
    expect(closure).toContain("assets/shared-bbb.js");
    expect(closure).toContain("assets/itemJump-fff.js");
    expect(closure).not.toContain("assets/lazy-eee.js");
  });

  test("normalises paths so a relative start and an absolute import are one file", () => {
    const abs = join(dist, "assets/shared-bbb.js");
    const rel = relative(process.cwd(), abs);
    expect(moduleClosure([rel, abs])).toHaveLength(1);
  });

  test("measures the entry + thread route, including the entry CSS", () => {
    const m = measureThreadRoute(dist);
    const rels = m.files.map((f) => f.rel);
    expect(rels).toContain("assets/index-ccc.js");
    expect(rels).toContain("assets/_chat.thread._threadId-ddd.js");
    expect(rels).toContain("assets/index-aaa.css");
    expect(rels).toContain("theme-init.js");
    expect(rels).not.toContain("assets/lazy-eee.js");
    expect(m.files).toHaveLength(rels.length); // no duplicate entries
    expect(m.raw).toBeGreaterThan(0);
    expect(m.gzip).toBeGreaterThan(0);
  });

  test("reports within budget and over it", () => {
    const m = measureThreadRoute(dist);
    expect(budgetViolations(m, { rawBytes: m.raw, gzipBytes: m.gzip })).toEqual([]);
    const over = budgetViolations(m, { rawBytes: m.raw - 1, gzipBytes: m.gzip - 1 });
    expect(over).toHaveLength(2);
    expect(formatReport(m, { rawBytes: m.raw, gzipBytes: m.gzip })).toContain("OK");
    expect(formatReport(m, { rawBytes: 0, gzipBytes: 0 })).toContain("OVER BUDGET");
  });
});
