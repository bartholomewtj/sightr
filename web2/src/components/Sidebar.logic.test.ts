import { describe, expect, it } from "vitest";

import { THREAD_STATUS_RANK, type ThreadStatus } from "@shared/v2/contracts";
import { project, thread } from "@/test/fixtures";

import {
  applyShelfCommand,
  buildProjectTree,
  documentTitle,
  effectiveStatus,
  isNeedsYou,
  needsYouThreads,
  partitionShelves,
  planPinnedReorder,
  planSidebarDrop,
  resolveAdjacentThreadId,
  resolveSidebarDropVerb,
  restoreShelfCommands,
  rollUpStatus,
  searchSidebarThreads,
  shelfPlace,
  statusLabel,
} from "./Sidebar.logic";

const ids = (list: { id: string }[]) => list.map((t) => t.id);

describe("shelves", () => {
  it("partitions non-archived threads into the four shelves, each sorted", () => {
    const shelves = partitionShelves([
      thread("a1", { status: "idle", lastActivityAt: 5 }),
      thread("a2", { status: "approval", lastActivityAt: 1 }),
      thread("a3", { status: "idle", lastActivityAt: 9 }),
      thread("a4", { status: "working", lastActivityAt: 2 }),
      thread("p1", { shelf: "pinned", pinOrder: 2 }),
      thread("p2", { shelf: "pinned", pinOrder: 0.5 }),
      thread("s1", { shelf: "snoozed", snoozedUntil: 900 }),
      thread("s2", { shelf: "snoozed", snoozedUntil: 100 }),
      thread("d1", { shelf: "settled", settledAt: 10 }),
      thread("d2", { shelf: "settled", settledAt: 20 }),
      thread("x1", { shelf: "archived" }),
    ]);
    expect(ids(shelves.pinned)).toEqual(["p2", "p1"]);
    // Status rank first, then newest activity.
    expect(ids(shelves.active)).toEqual(["a2", "a4", "a3", "a1"]);
    expect(ids(shelves.snoozed)).toEqual(["s2", "s1"]);
    expect(ids(shelves.settled)).toEqual(["d2", "d1"]);
  });

  it("reads unreadDone into the status: read done is idle, an unread idle is done", () => {
    expect(effectiveStatus({ status: "done", unreadDone: false })).toBe("idle");
    expect(effectiveStatus({ status: "idle", unreadDone: true })).toBe("done");
    expect(effectiveStatus({ status: "working", unreadDone: true })).toBe("working");
  });

  it("rolls up to the worst status, in the contracts' order", () => {
    const order: ThreadStatus[] = ["approval", "input", "failed", "working", "done", "idle"];
    for (let i = 0; i < order.length; i++) {
      const list = order.slice(i).map((status, n) => thread(`t${n}`, { status, unreadDone: status === "done" }));
      expect(rollUpStatus(list)).toBe(order[i]);
    }
    expect(Object.keys(THREAD_STATUS_RANK)).toEqual([...order, "starting"]);
    expect(rollUpStatus([thread("a", { status: "approval", shelf: "archived" }), thread("b")])).toBe("idle");
    expect(rollUpStatus([])).toBeNull();
  });

  it("labels each status for screen readers", () => {
    expect(statusLabel("approval")).toBe("Needs approval");
    expect(statusLabel("working", "2:14")).toBe("Working, 2:14");
    expect(statusLabel("starting")).toBe("Starting");
  });
});

describe("project tree", () => {
  it("follows project order and nests a worktree under its primary checkout", () => {
    const tree = buildProjectTree(
      [
        project("wt", { order: 1, number: 2, repoKey: "/r/.git", worktreeOf: "/r/.git", label: "sightr-wt" }),
        project("main", { order: 0, number: 1, repoKey: "/r/.git", label: "sightr" }),
        project("other", { order: 2, number: 3 }),
      ],
      [thread("t1", { projectId: "wt", status: "input" }), thread("t2", { projectId: "main" })],
    );
    expect(tree.map((n) => n.project.id)).toEqual(["main", "other"]);
    expect(tree[0]!.worktrees.map((n) => n.project.id)).toEqual(["wt"]);
    expect(tree[0]!.worktrees[0]!.nested).toBe(true);
    // The primary's roll-up includes its worktrees, so a collapsed primary still shows the input dot.
    expect(tree[0]!.rollUp).toBe("input");
    expect(tree[0]!.count).toBe(1);
  });

  it("shows a worktree whose primary is missing at top level, in its own place", () => {
    const tree = buildProjectTree(
      [project("a", { order: 0 }), project("wt", { order: 1, repoKey: "/gone/.git", worktreeOf: "/gone/.git" }), project("b", { order: 2 })],
      [],
    );
    expect(tree.map((n) => [n.project.id, n.nested])).toEqual([
      ["a", false],
      ["wt", false],
      ["b", false],
    ]);
  });

  it("leaves out closed projects", () => {
    expect(buildProjectTree([project("a"), project("b", { closedAt: 5 })], []).map((n) => n.project.id)).toEqual(["a"]);
  });
});

describe("filters", () => {
  it("needs you: approval, input, failed, or done-and-unread, across shelves except settled and archived", () => {
    const yes = [
      thread("a", { status: "approval" }),
      thread("b", { status: "input", shelf: "snoozed", snoozedUntil: 9 }),
      thread("c", { status: "failed", shelf: "pinned", pinOrder: 1 }),
      thread("d", { status: "done", unreadDone: true }),
    ];
    const no = [
      thread("e", { status: "done", unreadDone: false }),
      thread("f", { status: "working" }),
      thread("g", { status: "approval", shelf: "settled" }),
      thread("h", { status: "approval", shelf: "archived" }),
      thread("i", { status: "idle" }),
    ];
    for (const t of yes) expect(isNeedsYou(t), t.id).toBe(true);
    for (const t of no) expect(isNeedsYou(t), t.id).toBe(false);
    expect(ids(needsYouThreads([...no, ...yes].reverse()))).toEqual(["a", "b", "c", "d"]);
  });

  it("search matches title, project label and harness, case-insensitively, as one flat list", () => {
    const projects = { w1: project("w1", { label: "Sightr" }), w2: project("w2", { label: "Bench" }) };
    const list = [
      thread("a", { title: "Fix the LOGIN", projectId: "w2" }),
      thread("b", { title: "other", projectId: "w1", shelf: "settled" }),
      thread("c", { title: "x", harness: "pi", projectId: "w2", shelf: "pinned", pinOrder: 1 }),
      thread("d", { title: "login again", shelf: "archived" }),
    ];
    expect(ids(searchSidebarThreads(list, projects, "login"))).toEqual(["a"]);
    expect(ids(searchSidebarThreads(list, projects, "SIGHTR"))).toEqual(["b"]);
    expect(ids(searchSidebarThreads(list, projects, "pi"))).toEqual(["c"]);
    expect(searchSidebarThreads(list, projects, "   ")).toEqual([]);
  });

  it("puts the needs-you count in the title", () => {
    expect(documentTitle(0)).toBe("Sightr");
    expect(documentTitle(3)).toBe("(3) Sightr");
  });
});

describe("commands", () => {
  it("applies a command the way the bridge will (optimistic view)", () => {
    const t = thread("t1");
    expect(applyShelfCommand(t, { type: "thread.pin", threadId: "t1" }, 5, 3)).toMatchObject({ shelf: "pinned", pinOrder: 4, pinnedAt: 5 });
    expect(applyShelfCommand(t, { type: "thread.pin", threadId: "t1", pinOrder: 0.5 }, 5, 3).pinOrder).toBe(0.5);
    expect(applyShelfCommand(t, { type: "thread.snooze", threadId: "t1", until: 99 }, 5, 0)).toMatchObject({ shelf: "snoozed", snoozedUntil: 99 });
    expect(applyShelfCommand(t, { type: "thread.snooze", threadId: "t1", until: 4 }, 5, 0)).toBe(t);
    expect(applyShelfCommand(t, { type: "thread.archive", threadId: "t1" }, 5, 0)).toMatchObject({ shelf: "archived", archiveReason: "user" });
    expect(applyShelfCommand(t, { type: "thread.markUnread", threadId: "t1" }, 5, 0).unreadDone).toBe(true);
    expect(applyShelfCommand(t, { type: "thread.rename", threadId: "t1", title: "  New " }, 5, 0)).toMatchObject({ title: "New", titleSource: "user" });
    const pinned = thread("t1", { shelf: "pinned", pinOrder: 2, pinnedAt: 1 });
    const unpinned = applyShelfCommand(pinned, { type: "thread.unpin", threadId: "t1" }, 5, 0);
    expect(unpinned.shelf).toBe("active");
    expect(unpinned.pinOrder).toBeUndefined();
    expect(applyShelfCommand(thread("t1", { shelf: "snoozed", snoozedUntil: 9 }), { type: "thread.unsnooze", threadId: "t1" }, 5, 0).shelf).toBe("active");
  });

  it("restores the previous place, not just the opposite flag", () => {
    const pinnedAt2 = shelfPlace(thread("t", { shelf: "pinned", pinOrder: 2 }));
    expect(restoreShelfCommands("t", "active", pinnedAt2, 0)).toEqual([{ type: "thread.pin", threadId: "t", pinOrder: 2 }]);
    expect(restoreShelfCommands("t", "settled", pinnedAt2, 0)).toEqual([{ type: "thread.pin", threadId: "t", pinOrder: 2 }]);
    expect(restoreShelfCommands("t", "archived", pinnedAt2, 0)).toEqual([
      { type: "thread.unarchive", threadId: "t" },
      { type: "thread.pin", threadId: "t", pinOrder: 2 },
    ]);
    expect(restoreShelfCommands("t", "settled", { shelf: "active" }, 0)).toEqual([{ type: "thread.unsettle", threadId: "t" }]);
    expect(restoreShelfCommands("t", "snoozed", { shelf: "active" }, 0)).toEqual([{ type: "thread.unsnooze", threadId: "t" }]);
    expect(restoreShelfCommands("t", "archived", { shelf: "active" }, 0)).toEqual([{ type: "thread.unarchive", threadId: "t" }]);
    expect(restoreShelfCommands("t", "settled", { shelf: "snoozed", snoozedUntil: 50 }, 10)).toEqual([
      { type: "thread.snooze", threadId: "t", until: 50 },
    ]);
    // A snooze that has run out comes back to Active.
    expect(restoreShelfCommands("t", "settled", { shelf: "snoozed", snoozedUntil: 50 }, 60)).toEqual([
      { type: "thread.unsettle", threadId: "t" },
    ]);
    expect(restoreShelfCommands("t", "active", { shelf: "settled" }, 0)).toEqual([{ type: "thread.settle", threadId: "t" }]);
  });
});

describe("drag and drop", () => {
  it("names each cross-section drop (T3's verbs)", () => {
    expect(resolveSidebarDropVerb("active", "pinned")).toBe("pin");
    expect(resolveSidebarDropVerb("pinned", "active")).toBe("unpin");
    expect(resolveSidebarDropVerb("active", "settled")).toBe("settle");
    expect(resolveSidebarDropVerb("settled", "active")).toBe("unsettle");
    expect(resolveSidebarDropVerb("snoozed", "active")).toBe("wake");
    expect(resolveSidebarDropVerb("active", "snoozed")).toBeNull();
    expect(resolveSidebarDropVerb("active", "active")).toBeNull();
  });

  it("places a pin halfway between its neighbours", () => {
    const orders = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    expect(planPinnedReorder({ orderedIds: ["a", "x", "b", "c"], ordersById: orders, movedId: "x" })).toBe(1.5);
    expect(planPinnedReorder({ orderedIds: ["x", "a", "b"], ordersById: orders, movedId: "x" })).toBe(0);
    expect(planPinnedReorder({ orderedIds: ["a", "b", "c", "x"], ordersById: orders, movedId: "x" })).toBe(4);
    expect(planPinnedReorder({ orderedIds: ["x"], ordersById: orders, movedId: "x" })).toBeUndefined();
  });

  it("plans each drop as one command; Snoozed refuses", () => {
    const t = thread("t", { shelf: "active" });
    const orders = new Map<string, number | undefined>([["p", 1]]);
    expect(planSidebarDrop({ thread: t, from: "active", to: "pinned", pinnedOrderAfterDrop: ["t", "p"], pinOrders: orders })).toEqual({
      kind: "command",
      verb: "pin",
      command: { type: "thread.pin", threadId: "t", pinOrder: 0 },
    });
    expect(planSidebarDrop({ thread: thread("t", { shelf: "pinned", pinOrder: 5 }), from: "pinned", to: "active" })).toMatchObject({
      command: { type: "thread.unpin", threadId: "t" },
    });
    expect(planSidebarDrop({ thread: t, from: "active", to: "settled" })).toMatchObject({ command: { type: "thread.settle" } });
    expect(planSidebarDrop({ thread: t, from: "settled", to: "active" })).toMatchObject({ command: { type: "thread.unsettle" } });
    expect(planSidebarDrop({ thread: t, from: "snoozed", to: "active" })).toMatchObject({ command: { type: "thread.unsnooze" } });
    expect(planSidebarDrop({ thread: t, from: "active", to: "snoozed" })).toEqual({ kind: "refused-snooze" });
    expect(planSidebarDrop({ thread: t, from: "active", to: "active" })).toEqual({ kind: "none" });
  });

  it("reorders within Pinned with a new pin order", () => {
    const p = (id: string, pinOrder: number) => thread(id, { shelf: "pinned", pinOrder });
    const orders = new Map<string, number | undefined>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    expect(planSidebarDrop({ thread: p("c", 3), from: "pinned", to: "pinned", pinnedOrderAfterDrop: ["a", "c", "b"], pinOrders: orders })).toEqual({
      kind: "command",
      verb: "reorder",
      command: { type: "thread.pin", threadId: "c", pinOrder: 1.5 },
    });
    expect(planSidebarDrop({ thread: p("a", 1), from: "pinned", to: "pinned", pinnedOrderAfterDrop: ["a", "b", "c"], pinOrders: orders })).toEqual({
      kind: "none",
    });
  });
});

describe("keyboard", () => {
  it("moves to the adjacent id, clamped at the ends", () => {
    const list = ["a", "b", "c"];
    expect(resolveAdjacentThreadId({ threadIds: list, currentThreadId: "a", direction: "next" })).toBe("b");
    expect(resolveAdjacentThreadId({ threadIds: list, currentThreadId: "a", direction: "previous" })).toBe("a");
    expect(resolveAdjacentThreadId({ threadIds: list, currentThreadId: "c", direction: "next" })).toBe("c");
    expect(resolveAdjacentThreadId({ threadIds: list, currentThreadId: null, direction: "previous" })).toBe("c");
  });
});
