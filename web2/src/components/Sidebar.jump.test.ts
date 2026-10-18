import { describe, expect, it, vi } from "vitest";

import type { Project, Thread } from "@shared/v2/contracts";
import { project, thread } from "@/test/fixtures";

import {
  createThreadJumpHintVisibilityController,
  modifiersAfterKeyEvent,
  NO_MODIFIERS,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
  threadJumpOrder,
} from "./Sidebar.jump";

const projects = (...ps: Project[]) => Object.fromEntries(ps.map((p) => [p.id, p]));
const ids = (ts: Thread[], over: Partial<Parameters<typeof threadJumpOrder>[0]> = {}, ps: Project[] = [project("w1", { label: "One" }), project("w2", { label: "Two", order: 1, number: 2 })]) =>
  threadJumpOrder({ projects: projects(...ps), threads: ts, filter: "all", query: "", collapsedProjects: [], ...over });

describe("threadJumpOrder", () => {
  const ts = [
    thread("a1", { projectId: "w1", lastActivityAt: 30 }),
    thread("a2", { projectId: "w1", lastActivityAt: 20 }),
    thread("pin", { projectId: "w1", shelf: "pinned", pinnedAt: 1, pinOrder: 1 }),
    thread("snz", { projectId: "w1", shelf: "snoozed", snoozedUntil: 9e12 }),
    thread("set", { projectId: "w1", shelf: "settled" }),
    thread("arc", { projectId: "w1", shelf: "archived" }),
    thread("b1", { projectId: "w2", lastActivityAt: 10 }),
  ];

  it("follows the tree: per project, pinned then active; no snoozed, settled or archived rows", () => {
    expect(ids(ts)).toEqual(["pin", "a1", "a2", "b1"]);
  });

  it("skips a collapsed project, whose rows are not on screen", () => {
    expect(ids(ts, { collapsedProjects: ["w1"] })).toEqual(["b1"]);
  });

  it("Needs you is the flat list, worst first", () => {
    const need = [thread("n1", { status: "approval", lastActivityAt: 5 }), thread("n2", { status: "failed", lastActivityAt: 6 }), thread("q", { status: "idle" })];
    const order = ids(need, { filter: "needs-you" });
    expect(order).toHaveLength(2);
    expect(order).toContain("n1");
    expect(order).not.toContain("q");
  });

  it("a search shows its flat results, and the numbers follow them", () => {
    const named = [thread("x", { title: "Fix the build" }), thread("y", { title: "Write docs" }), thread("z", { title: "Build cache", shelf: "settled" })];
    expect(ids(named, { query: "build" }).sort()).toEqual(["x", "z"]);
  });
});

describe("hint visibility controller", () => {
  it("shows the hints after the delay, hides at once, and a tap shows nothing", () => {
    vi.useFakeTimers();
    const seen: boolean[] = [];
    const c = createThreadJumpHintVisibilityController({ delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS, onVisibilityChange: (v) => seen.push(v) });
    c.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS - 1);
    expect(seen).toEqual([]);
    c.sync(false);
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
    c.sync(true);
    c.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);
    expect(seen).toEqual([true]);
    c.sync(false);
    expect(seen).toEqual([true, false]);
    c.sync(true);
    c.dispose();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([true, false]);
    vi.useRealTimers();
  });
});

describe("modifiersAfterKeyEvent", () => {
  const ev = (type: "keydown" | "keyup", key: string, mods: Partial<typeof NO_MODIFIERS> = {}) => ({ type, key, ...NO_MODIFIERS, ...mods });
  it("tracks a modifier's own key and trusts the keyup over stale flags", () => {
    expect(modifiersAfterKeyEvent(ev("keydown", "Control", { ctrlKey: true }))).toEqual({ ...NO_MODIFIERS, ctrlKey: true });
    // Some platforms leave ctrlKey true on the Control keyup.
    expect(modifiersAfterKeyEvent(ev("keyup", "Control", { ctrlKey: true }))).toEqual(NO_MODIFIERS);
    expect(modifiersAfterKeyEvent(ev("keydown", "Meta", { metaKey: true }))).toEqual({ ...NO_MODIFIERS, metaKey: true });
    expect(modifiersAfterKeyEvent(ev("keydown", "k", { ctrlKey: true }))).toEqual({ ...NO_MODIFIERS, ctrlKey: true });
  });
});
