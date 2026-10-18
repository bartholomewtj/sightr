// Adapted from T3 Code apps/web/src/lib/turnDiffTree.test.ts @ 3a4d118a518a (MIT, see THIRD_PARTY.md).
// Changes: imports vitest instead of vite-plus/test; the last describe block (empty input, sort order,
// files with no counts) is Sightr's (T24). The other cases are upstream's.
import { describe, expect, it } from "vitest";

import { buildTurnDiffTree, summarizeTurnDiffStats } from "./turnDiffTree";

describe("summarizeTurnDiffStats", () => {
  it("sums only files with numeric additions/deletions", () => {
    const stat = summarizeTurnDiffStats([
      { path: "README.md", kind: "modified", additions: 3, deletions: 1 },
      { path: "docs/notes.md", kind: "modified", additions: 0, deletions: 0 },
      { path: "src/index.ts", kind: "modified", additions: 5, deletions: 2 },
    ]);

    expect(stat).toEqual({ additions: 8, deletions: 3 });
  });
});

describe("buildTurnDiffTree", () => {
  it("builds nested directory nodes with aggregated stats", () => {
    const tree = buildTurnDiffTree([
      { path: "src/index.ts", kind: "modified", additions: 2, deletions: 1 },
      { path: "src/components/Button.tsx", kind: "modified", additions: 4, deletions: 2 },
      { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "src",
        path: "src",
        stat: { additions: 6, deletions: 3 },
        children: [
          {
            kind: "directory",
            name: "components",
            path: "src/components",
            stat: { additions: 4, deletions: 2 },
            children: [
              {
                kind: "file",
                name: "Button.tsx",
                path: "src/components/Button.tsx",
                stat: { additions: 4, deletions: 2 },
              },
            ],
          },
          {
            kind: "file",
            name: "index.ts",
            path: "src/index.ts",
            stat: { additions: 2, deletions: 1 },
          },
        ],
      },
      {
        kind: "file",
        name: "README.md",
        path: "README.md",
        stat: { additions: 1, deletions: 0 },
      },
    ]);
  });

  it("keeps zero-valued file stats and includes only their numeric contribution", () => {
    const tree = buildTurnDiffTree([
      { path: "docs/notes.md", kind: "modified", additions: 0, deletions: 0 },
      { path: "docs/todo.md", kind: "modified", additions: 1, deletions: 1 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "docs",
        path: "docs",
        stat: { additions: 1, deletions: 1 },
        children: [
          {
            kind: "file",
            name: "notes.md",
            path: "docs/notes.md",
            stat: { additions: 0, deletions: 0 },
          },
          {
            kind: "file",
            name: "todo.md",
            path: "docs/todo.md",
            stat: { additions: 1, deletions: 1 },
          },
        ],
      },
    ]);
  });

  it("normalizes file paths with windows separators", () => {
    const tree = buildTurnDiffTree([
      { path: "apps\\web\\src\\index.ts", kind: "modified", additions: 2, deletions: 1 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "apps/web/src",
        path: "apps/web/src",
        stat: { additions: 2, deletions: 1 },
        children: [
          {
            kind: "file",
            name: "index.ts",
            path: "apps/web/src/index.ts",
            stat: { additions: 2, deletions: 1 },
          },
        ],
      },
    ]);
  });

  it("compacts only single-directory chains and stops at branch points", () => {
    const tree = buildTurnDiffTree([
      { path: "apps/server/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
      { path: "apps/server/main.ts", kind: "modified", additions: 4, deletions: 0 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "apps/server",
        path: "apps/server",
        stat: { additions: 6, deletions: 1 },
        children: [
          {
            kind: "directory",
            name: "src",
            path: "apps/server/src",
            stat: { additions: 2, deletions: 1 },
            children: [
              {
                kind: "file",
                name: "index.ts",
                path: "apps/server/src/index.ts",
                stat: { additions: 2, deletions: 1 },
              },
            ],
          },
          {
            kind: "file",
            name: "main.ts",
            path: "apps/server/main.ts",
            stat: { additions: 4, deletions: 0 },
          },
        ],
      },
    ]);
  });

  it("preserves leading/trailing whitespace in path segments", () => {
    const tree = buildTurnDiffTree([
      { path: "a/file.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: " a/file.ts", kind: "modified", additions: 2, deletions: 0 },
    ]);

    expect(tree).toHaveLength(2);
    const directoryNodes = tree.filter(
      (node): node is Extract<(typeof tree)[number], { kind: "directory" }> =>
        node.kind === "directory",
    );
    expect(directoryNodes.map((node) => node.name).toSorted()).toEqual([" a", "a"]);
    expect(directoryNodes.map((node) => node.path).toSorted()).toEqual([" a", "a"]);
  });
});

describe("buildTurnDiffTree (Sightr, T24)", () => {
  it("returns no nodes for no files", () => {
    expect(buildTurnDiffTree([])).toEqual([]);
    expect(summarizeTurnDiffStats([])).toEqual({ additions: 0, deletions: 0 });
  });

  it("sorts directories before files, each by name with numbers in order", () => {
    const tree = buildTurnDiffTree([
      { path: "z.ts", additions: 1, deletions: 0 },
      { path: "a10.ts", additions: 1, deletions: 0 },
      { path: "a2.ts", additions: 1, deletions: 0 },
      { path: "lib/x.ts", additions: 1, deletions: 0 },
      { path: "app/x.ts", additions: 1, deletions: 0 },
    ]);
    expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual([
      "directory:app",
      "directory:lib",
      "file:a2.ts",
      "file:a10.ts",
      "file:z.ts",
    ]);
  });

  it("gives a file with no counts a null stat and leaves it out of the roll-up", () => {
    const tree = buildTurnDiffTree([{ path: "src/a.ts", additions: 2, deletions: 1 }, { path: "src/b.ts" }]);
    expect(tree).toEqual([
      {
        kind: "directory",
        name: "src",
        path: "src",
        stat: { additions: 2, deletions: 1 },
        children: [
          { kind: "file", name: "a.ts", path: "src/a.ts", stat: { additions: 2, deletions: 1 } },
          { kind: "file", name: "b.ts", path: "src/b.ts", stat: null },
        ],
      },
    ]);
  });
});
