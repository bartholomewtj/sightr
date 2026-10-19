import { describe, expect, it } from "vitest";

import type { Thread } from "@shared/v2/contracts";
import { NO_CAPABILITIES } from "@shared/v2/contracts";
import { project, thread } from "@/test/fixtures";

import {
  applies,
  buildActionItems,
  buildCommandPaletteRows,
  buildFileItems,
  buildNeedsYouItems,
  buildOpenPaneItems,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  filterCommandPaletteGroups,
  findHighlightedCommandPaletteItem,
  isSafeFilesRelPath,
  isSubsequence,
  rankFileResults,
  type CommandPaletteActionSpec,
} from "./CommandPalette.logic";

const projects = { w1: project("w1", { label: "Sightr" }), w2: project("w2", { label: "Bench", order: 1 }) };
const threads: Thread[] = [
  thread("a", { title: "Fix the build", lastActivityAt: 10 }),
  thread("b", { title: "Write docs", lastActivityAt: 50, projectId: "w2", harness: "pi" }),
  thread("c", { title: "Build pipeline", lastActivityAt: 30, status: "approval" }),
  thread("d", { title: "Old work", lastActivityAt: 90, shelf: "archived" }),
  thread("e", { title: "Finished", lastActivityAt: 20, status: "done", unreadDone: true }),
];
const input = { threads, projects, icon: null, runThread: () => {} };

const values = (items: ReadonlyArray<{ value: string }>) => items.map((i) => i.value);

describe("palette threads", () => {
  it("lists Needs you first on an empty query, then recent threads by last activity, never archived", () => {
    const groups = buildRootGroups({
      needsYouItems: buildNeedsYouItems(input),
      recentThreadItems: buildThreadActionItems({ ...input, limit: 12 }),
      actionItems: [],
    });
    expect(groups.map((g) => g.label)).toEqual(["Needs you", "Recent threads"]);
    expect(values(groups[0]!.items)).toEqual(["thread:c", "thread:e"]);
    expect(values(groups[1]!.items)).toEqual(["thread:b", "thread:a"]);
  });

  it("matches title, project label and harness, ranking a title match first", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "build",
      projectSearchItems: [],
      threadSearchItems: buildThreadActionItems(input),
    });
    expect(groups.map((g) => g.label)).toEqual(["Threads"]);
    // Both titles match; "Build pipeline" starts with the query but T3 ranks title matches equally
    // and breaks the tie by recency.
    expect(values(groups[0]!.items)).toEqual(["thread:c", "thread:a"]);
    const byProject = filterCommandPaletteGroups({ activeGroups: [], query: "bench", projectSearchItems: [], threadSearchItems: buildThreadActionItems(input) });
    expect(values(byProject[0]!.items)).toEqual(["thread:b"]);
    const byHarness = filterCommandPaletteGroups({ activeGroups: [], query: "pi", projectSearchItems: [], threadSearchItems: buildThreadActionItems(input) });
    expect(values(byHarness[0]!.items)).toContain("thread:b");
  });

  it("falls back to a subsequence match, ranked below a token match", () => {
    expect(isSubsequence("fxbld", "fixthebuild")).toBe(true);
    expect(isSubsequence("bx", "build")).toBe(false);
    const groups = filterCommandPaletteGroups({ activeGroups: [], query: "fxbld", projectSearchItems: [], threadSearchItems: buildThreadActionItems(input) });
    expect(values(groups[0]!.items)).toEqual(["thread:a"]);
  });
});

describe("palette open Herdr panes", () => {
  const withPanes: Thread[] = [
    thread("a", { title: "Fix the build", lastActivityAt: 10, paneAlive: true }),
    thread("b", { title: "Write docs", lastActivityAt: 50, paneAlive: false }),
    thread("d", { title: "Old work", lastActivityAt: 90, shelf: "archived", archiveReason: "user", paneAlive: true }),
    thread("e", { title: "No flag", lastActivityAt: 20 }),
  ];
  const panes = { ...input, threads: withPanes };

  it("lists threads whose pane is open, archived ones included, newest first", () => {
    expect(values(buildOpenPaneItems(panes))).toEqual(["thread:d", "thread:a"]);
    expect(buildOpenPaneItems(panes)[0]!.description).toContain("Archived");
  });

  it("filters by every word of the query", () => {
    expect(values(buildOpenPaneItems(panes, "old"))).toEqual(["thread:d"]);
    expect(buildOpenPaneItems(panes, "nothing")).toEqual([]);
  });
});

describe("palette projects", () => {
  it("offers a jump and a new thread per open project", () => {
    const jump = buildProjectActionItems({ projects: Object.values(projects), valuePrefix: "project", icon: () => null, runProject: () => {} });
    const fresh = buildProjectActionItems({
      projects: Object.values(projects),
      valuePrefix: "new-thread-in",
      titleFor: (p) => `New thread in ${p.label}`,
      icon: () => null,
      runProject: () => {},
    });
    expect(values(jump)).toEqual(["project:w1", "project:w2"]);
    const groups = filterCommandPaletteGroups({ activeGroups: [], query: "new thread in bench", projectSearchItems: [...jump, ...fresh], threadSearchItems: [] });
    expect(groups.map((g) => g.label)).toEqual(["Projects"]);
    expect(values(groups[0]!.items)).toEqual(["new-thread-in:w2"]);
  });
});

describe("palette actions", () => {
  const specs: CommandPaletteActionSpec[] = [
    { value: "new", title: "New thread", icon: null, run: () => {} },
    { value: "stop", title: "Stop run", icon: null, applies: applies.running, run: () => {} },
    { value: "unread", title: "Mark thread unread", icon: null, applies: applies.canMarkUnread, run: () => {} },
    { value: "unpin", title: "Unpin thread", icon: null, applies: applies.shelf("pinned"), run: () => {} },
    { value: "sidebar", title: "Toggle sidebar", icon: null, applies: applies.desktop, run: () => {} },
  ];

  it("offers only the actions that apply now", () => {
    const idle = buildActionItems(specs, { thread: thread("a"), desktop: false, readOnly: false });
    expect(values(idle)).toEqual(["action:new", "action:unread"]);
    const working = buildActionItems(specs, {
      thread: thread("a", { status: "working", shelf: "pinned", capabilities: { ...NO_CAPABILITIES, canInterrupt: true } }),
      desktop: true,
      readOnly: false,
    });
    expect(values(working)).toEqual(["action:new", "action:stop", "action:unread", "action:unpin", "action:sidebar"]);
    const none = buildActionItems(specs, { thread: null, desktop: false, readOnly: false });
    expect(values(none)).toEqual(["action:new"]);
    const readOnly = buildActionItems(specs, { thread: thread("a", { shelf: "pinned" }), desktop: false, readOnly: true });
    expect(values(readOnly)).toEqual(["action:new", "action:unread"]);
  });

  it("keeps actions under a query and filters them with '>'", () => {
    const actions = buildActionItems(specs, { thread: null, desktop: true, readOnly: false });
    const root = buildRootGroups({ needsYouItems: [], recentThreadItems: buildThreadActionItems(input), actionItems: actions });
    const groups = filterCommandPaletteGroups({ activeGroups: root, query: ">side", projectSearchItems: [], threadSearchItems: buildThreadActionItems(input) });
    expect(groups.map((g) => g.label)).toEqual(["Actions"]);
    expect(values(groups[0]!.items)).toEqual(["action:sidebar"]);
  });
});

describe("palette rows", () => {
  it("numbers enabled items and finds the highlighted one", () => {
    const groups = buildRootGroups({ needsYouItems: buildNeedsYouItems(input), recentThreadItems: [], actionItems: [] });
    const { rows, itemValues } = buildCommandPaletteRows(groups);
    expect(rows[0]).toMatchObject({ kind: "label", label: "Needs you" });
    expect(itemValues).toEqual(["thread:c", "thread:e"]);
    expect(findHighlightedCommandPaletteItem(groups, "thread:e")?.value).toBe("thread:e");
    expect(findHighlightedCommandPaletteItem(groups, "nope")).toBeNull();
  });
});

describe("palette Open file… mode", () => {
  const f = (path: string, kind: "file" | "dir" = "file") => ({ path, name: path.split("/").pop()!, kind });

  it("refuses a path that is not a Files rel path", () => {
    const bad = ["", "/etc/passwd", "../x", "a/../../x", "C:\\x", "C:/x", "a\\b", "a//b", "a/\u0000b"];
    for (const path of bad) expect(isSafeFilesRelPath(path)).toBe(false);
    for (const ok of ["a.ts", "src/a.ts", "dir with space/a b.md", ".github/ci.yml"]) expect(isSafeFilesRelPath(ok)).toBe(true);
  });

  it("ranks the name match first, files before folders, shorter paths first, and drops unsafe paths", () => {
    const ranked = rankFileResults([f("docs/readme-notes.md"), f("src/app", "dir"), f("../escape/app.ts"), f("deep/er/app.ts"), f("app.ts"), f("lib/app", "dir")], "app").map((r) => r.path);
    // An exact name ("app") first (folders last among equals), then the prefix "app.ts" by path length, then the rest.
    expect(ranked).toEqual(["src/app", "lib/app", "app.ts", "deep/er/app.ts", "docs/readme-notes.md"]);
  });

  it("an exact name beats a prefix, a prefix beats a substring", () => {
    expect(rankFileResults([f("x/my-app.ts"), f("x/app-core.ts"), f("x/app")], "app").map((r) => r.path)).toEqual(["x/app", "x/app-core.ts", "x/my-app.ts"]);
  });

  it("builds items with the folder as the description and the pick as the run", () => {
    const opened: string[] = [];
    const items = buildFileItems({ results: [f("src/a.ts"), f("b.ts")], query: "ts", icon: () => null, openFile: (r) => void opened.push(`${r.kind}:${r.path}`) });
    expect(items.map((i) => [i.value, i.title, i.description])).toEqual([
      ["file:b.ts", "b.ts", "Files root"],
      ["file:src/a.ts", "a.ts", "src"],
    ]);
    void items[1]!.run();
    expect(opened).toEqual(["file:src/a.ts"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 80 }, (_, i) => f(`d/f${i}.ts`));
    expect(buildFileItems({ results: many, query: "f", icon: () => null, openFile: () => {} })).toHaveLength(50);
    expect(buildFileItems({ results: many, query: "f", icon: () => null, openFile: () => {}, limit: 5 })).toHaveLength(5);
  });
});

describe("palette thread actions apply", () => {
  const spec = (value: string, applyTest: (typeof applies)["thread"]) => ({ value, title: value, icon: null, applies: applyTest, run: () => {} });
  const ctx = (over: Partial<Parameters<typeof buildActionItems>[1]> = {}) => ({ thread: threads[0]!, desktop: true, readOnly: false, ...over });

  it("Find in thread needs a thread on its timeline, not the CLI", () => {
    const specs = [spec("find", applies.findable)];
    expect(buildActionItems(specs, ctx()).map((i) => i.value)).toEqual(["action:find"]);
    expect(buildActionItems(specs, ctx({ timeline: true })).length).toBe(1);
    expect(buildActionItems(specs, ctx({ timeline: false }))).toEqual([]);
    expect(buildActionItems(specs, ctx({ thread: null }))).toEqual([]);
  });

  it("Copy folder path needs a pane (a thread still spawning has none)", () => {
    const specs = [spec("folder", applies.hasPane)];
    expect(buildActionItems(specs, ctx()).length).toBe(1);
    expect(buildActionItems(specs, ctx({ thread: thread("s", { paneId: "" }) }))).toEqual([]);
  });

  it("a keepOpen action says so", () => {
    const items = buildActionItems([{ ...spec("open-file", applies.thread), keepOpen: true }], ctx());
    expect(items[0]?.keepOpen).toBe(true);
  });
});
