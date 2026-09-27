import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { containedRealpath, containedRealpathIn } from "./containment.ts";

// Spec 13: one containment rule for both filesystem readers (journal and Files tab).

async function tree() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sightr-contain-")));
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "sub", "in.txt"), "in");
  await writeFile(join(outside, "out.txt"), "out");
  return { base, root, outside };
}

describe("containedRealpath", () => {
  test("a path inside the root resolves; the root itself counts as inside", async () => {
    const { base, root } = await tree();
    expect(await containedRealpath(join(root, "sub", "in.txt"), root)).toBe(join(root, "sub", "in.txt"));
    expect(await containedRealpath(root, root)).toBe(root);
    await rm(base, { recursive: true, force: true });
  });

  test("outside, a `..` escape, a sibling sharing the prefix, and an absent file all answer null", async () => {
    const { base, root, outside } = await tree();
    expect(await containedRealpath(join(outside, "out.txt"), root)).toBeNull();
    expect(await containedRealpath(join(root, "..", "outside", "out.txt"), root)).toBeNull();
    await mkdir(`${root}-sibling`);
    expect(await containedRealpath(`${root}-sibling`, root)).toBeNull();
    expect(await containedRealpath(join(root, "missing.txt"), root)).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("containedRealpathIn asks each root in turn", async () => {
    const { base, root, outside } = await tree();
    expect(await containedRealpathIn(join(outside, "out.txt"), [root, outside])).toBe(join(outside, "out.txt"));
    expect(await containedRealpathIn(join(outside, "out.txt"), [root])).toBeNull();
    await rm(base, { recursive: true, force: true });
  });
});
