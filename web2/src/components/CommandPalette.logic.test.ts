import { describe, expect, it } from "vitest";

import type { Thread } from "@shared/v2/contracts";
import { NO_CAPABILITIES } from "@shared/v2/contracts";
import { project, thread } from "@/test/fixtures";

import {
  applies,
  buildActionItems,
  buildCommandPaletteRows,
  buildNeedsYouItems,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  filterCommandPaletteGroups,
  findHighlightedCommandPaletteItem,
  isSubsequence,
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
