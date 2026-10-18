// Adapted from T3 Code apps/web/src/components/diffs/diffFileTree.logic.test.ts @ 3a4d118a518a (MIT, see THIRD_PARTY.md).
// Verified at build: T3's tests are the two `diffFileTreeEntries` cases, `collectDirectoryPaths`, and the
// Pierre-bound reading-order and batch-update cases. The first three are ported (statuses are Sightr's kinds,
// and paths carry no trailing slash); the Pierre-bound ones are not, since they test `@pierre/trees`. Sightr's own
// cases cover the tree built over T24's `buildTurnDiffTree`: single-child folder compression, sort order,
// folder totals, and `treeOrder`. The test imports vitest, not vite-plus/test.
import { describe, expect, it } from "vitest";

import { buildDiffTree, collectDirectoryPaths, diffFileTreeEntries, diffTotals, treeDirectoryPaths, treeOrder } from "./diffFileTree.logic";
import type { DiffFileEntry } from "./diffTypes";

const file = (path: string, over: Partial<DiffFileEntry> = {}): DiffFileEntry => ({ path, kind: "modified", added: 1, removed: 0, countsKnown: true, rev: path, ...over });

describe("diffFileTreeEntries", () => {
  it("keeps each change kind under the file's current path", () => {
    expect(
      diffFileTreeEntries([
        { path: "a/src/a.ts", kind: "added" },
        { path: "src/b.ts", kind: "deleted" },
        { path: "src/c.ts", kind: "renamed" },
        { path: "README.md", kind: "modified" },
        { path: "notes.md", kind: "untracked" },
      ]),
    ).toEqual([
      { path: "a/src/a.ts", status: "added" },
      { path: "src/b.ts", status: "deleted" },
      { path: "src/c.ts", status: "renamed" },
      { path: "README.md", status: "modified" },
      { path: "notes.md", status: "untracked" },
    ]);
  });

  it("folds a file-to-symlink type change into one modified entry", () => {
    expect(
      diffFileTreeEntries([
        { path: "CLAUDE.md", kind: "modified" },
        { path: "AGENTS.md", kind: "deleted" },
        { path: "AGENTS.md", kind: "added" },
        { path: "docs/new.md", kind: "added" },
      ]),
    ).toEqual([
      { path: "CLAUDE.md", status: "modified" },
      { path: "AGENTS.md", status: "modified" },
      { path: "docs/new.md", status: "added" },
    ]);
  });
});

describe("collectDirectoryPaths", () => {
  it("lists every ancestor once, parents first (no trailing slash: Pierre's is not used)", () => {
    expect(collectDirectoryPaths(["apps/web/src/a.ts", "apps/web/b.ts", "README.md"])).toEqual(["apps", "apps/web", "apps/web/src"]);
  });
});

describe("buildDiffTree", () => {
  it("compresses single-child folders into one row and keeps a folder that branches", () => {
    const nodes = buildDiffTree([file("apps/mobile/src/state/shell.ts"), file("apps/mobile/src/features/route.ts"), file("apps/mobile/src/features/screen.tsx")]);
    expect(nodes).toHaveLength(1);
    const root = nodes[0]!;
    expect(root.kind).toBe("directory");
    expect(root.name).toBe("apps/mobile/src");
    const kids = root.kind === "directory" ? root.children : [];
    expect(kids.map((k) => k.name)).toEqual(["features", "state/shell.ts".split("/")[0]]);
    // `state` has one child directory-less file, so it stays a folder of one file.
    expect(kids[1]).toMatchObject({ kind: "directory", name: "state" });
  });

  it("sorts folders before files, each by name with numbers read as numbers", () => {
    const nodes = buildDiffTree([file("z.ts"), file("b/file10.ts"), file("b/file2.ts"), file("a.ts"), file("c/x.ts")]);
    expect(nodes.map((n) => `${n.kind}:${n.name}`)).toEqual(["directory:b", "directory:c", "file:a.ts", "file:z.ts"]);
    const b = nodes[0]!;
    expect(b.kind === "directory" ? b.children.map((c) => c.name) : []).toEqual(["file2.ts", "file10.ts"]);
  });

  it("totals +N/-M for every folder from its files, and skips a file with no counts", () => {
    const nodes = buildDiffTree([file("src/a.ts", { added: 5, removed: 2 }), file("src/lib/b.ts", { added: 3, removed: 1 }), file("src/c.ts", { countsKnown: false, added: 9, removed: 9 })]);
    const src = nodes[0]!;
    expect(src).toMatchObject({ kind: "directory", name: "src", stat: { additions: 8, deletions: 3 } });
    const c = src.kind === "directory" ? src.children.find((n) => n.name === "c.ts") : undefined;
    expect(c).toMatchObject({ kind: "file", stat: null });
  });

  it("lists every folder path (what a collapse-all would close)", () => {
    expect(treeDirectoryPaths(buildDiffTree([file("a/b/c.ts"), file("a/d/e.ts"), file("f.ts")]))).toEqual(["a", "a/b", "a/d"]);
  });
});

describe("treeOrder", () => {
  it("is the order the tree reads top to bottom, so the tree and the page agree", () => {
    const order = treeOrder([file("z.ts"), file("src/b.ts"), file("a.ts"), file("src/a.ts"), file("docs/x.md")]).map((f) => f.path);
    expect(order).toEqual(["docs/x.md", "src/a.ts", "src/b.ts", "a.ts", "z.ts"]);
  });

  it("keeps a path the tree cannot place, and a path listed twice", () => {
    const out = treeOrder([file("a.ts"), file("a.ts", { rev: "2" }), file("/")]);
    expect(out.map((f) => f.path).sort()).toEqual(["/", "a.ts", "a.ts"]);
  });
});

describe("diffTotals", () => {
  it("sums counts of files that have them", () => {
    expect(diffTotals([file("a", { added: 4, removed: 1 }), file("b", { added: 2, removed: 2 }), file("c", { countsKnown: false, added: 50 })])).toEqual({ files: 3, added: 6, removed: 3 });
  });
});
