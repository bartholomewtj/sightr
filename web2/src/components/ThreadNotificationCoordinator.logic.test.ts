import { describe, expect, it, vi } from "vitest";

import { thread } from "@/test/fixtures";

import { alertStatus, alertText, needsYouCount, planThreadAlerts, setAppBadge, type AlertStatus } from "./ThreadNotificationCoordinator.logic";

const seen = (entries: Record<string, AlertStatus | null>) => new Map(Object.entries(entries));
const plan = (over: Partial<Parameters<typeof planThreadAlerts>[0]>) =>
  planThreadAlerts({ previous: seen({}), raised: new Set(), threads: [], openThreadId: null, ...over });

describe("alertStatus", () => {
  it("alerts on approval, input, failed and a bridge-finished unread thread", () => {
    expect(alertStatus(thread("a", { status: "approval" }))).toBe("approval");
    expect(alertStatus(thread("a", { status: "input" }))).toBe("input");
    expect(alertStatus(thread("a", { status: "failed" }))).toBe("failed");
    expect(alertStatus(thread("a", { status: "done", unreadDone: true }))).toBe("done");
  });

  it("stays quiet for working, idle, read, operator-marked-unread, and put-away threads", () => {
    expect(alertStatus(thread("a", { status: "working" }))).toBeNull();
    expect(alertStatus(thread("a", { status: "done", unreadDone: false }))).toBeNull();
    expect(alertStatus(thread("a", { status: "idle", unreadDone: true }))).toBeNull();
    for (const shelf of ["settled", "archived", "snoozed"] as const) {
      expect(alertStatus(thread("a", { status: "approval", shelf }))).toBeNull();
    }
  });
});

describe("planThreadAlerts", () => {
  it("records the first look without alerting", () => {
    const p = plan({ previous: null, threads: [thread("a", { status: "approval" })] });
    expect(p.alerts).toEqual([]);
    expect(p.next.get("a")).toBe("approval");
  });

  it("alerts when another thread moves into approval, and not again for the same status", () => {
    const a = thread("a", { title: "Alpha", status: "approval" });
    const first = plan({ previous: seen({ a: null }), threads: [a] });
    expect(first.alerts.map((x) => x.key)).toEqual(["a:approval"]);
    // A later update to the same thread (a rename, a new timestamp) is not a new alert.
    const again = plan({ previous: first.next, raised: first.raised, threads: [{ ...a, updatedAt: 9 }] });
    expect(again.alerts).toEqual([]);
  });

  it("alerts again after the thread left the status and came back", () => {
    const first = plan({ previous: seen({ a: null }), threads: [thread("a", { status: "input" })] });
    const working = plan({ previous: first.next, raised: first.raised, threads: [thread("a", { status: "working" })] });
    expect(working.raised.size).toBe(0);
    const back = plan({ previous: working.next, raised: working.raised, threads: [thread("a", { status: "input" })] });
    expect(back.alerts).toHaveLength(1);
  });

  it("alerts on a change from one needs-you status to another", () => {
    const p = plan({ previous: seen({ a: "approval" }), raised: new Set(["a:approval"]), threads: [thread("a", { status: "failed" })] });
    expect(p.alerts.map((x) => x.status)).toEqual(["failed"]);
  });

  it("never alerts for the open thread, and does not alert for it later either", () => {
    const a = thread("a", { status: "approval" });
    const open = plan({ previous: seen({ a: null }), threads: [a], openThreadId: "a" });
    expect(open.alerts).toEqual([]);
    const left = plan({ previous: open.next, raised: open.raised, threads: [a], openThreadId: "b" });
    expect(left.alerts).toEqual([]);
  });

  it("treats a thread it has not seen before as new, not as an alert", () => {
    const p = plan({ previous: seen({}), threads: [thread("new", { status: "approval" })] });
    expect(p.alerts).toEqual([]);
  });

  it("alerts for a finished thread", () => {
    const p = plan({ previous: seen({ a: null }), threads: [thread("a", { status: "done", unreadDone: true })] });
    expect(p.alerts.map((x) => x.status)).toEqual(["done"]);
  });
});

describe("alertText and the badge", () => {
  it("words each status and trims a long title", () => {
    expect(alertText({ title: "Fix the build", status: "approval" })).toBe("Fix the build needs you");
    expect(alertText({ title: "Fix the build", status: "input" })).toBe("Fix the build needs you");
    expect(alertText({ title: "Fix the build", status: "done" })).toBe("Fix the build finished");
    expect(alertText({ title: "Fix the build", status: "failed" })).toBe("Fix the build failed");
    expect(alertText({ title: "x".repeat(100), status: "done" })).toHaveLength(60 + " finished".length);
  });

  it("counts the Needs you threads", () => {
    expect(
      needsYouCount([
        thread("a", { status: "approval" }),
        thread("b", { status: "done", unreadDone: true }),
        thread("c", { status: "working" }),
        thread("d", { status: "approval", shelf: "settled" }),
      ]),
    ).toBe(2);
  });

  it("sets the badge to the count and clears it at 0, and survives a missing or throwing API", () => {
    const set = vi.fn(() => Promise.resolve());
    const clear = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { setAppBadge: set, clearAppBadge: clear });
    try {
      setAppBadge(3);
      expect(set).toHaveBeenCalledWith(3);
      setAppBadge(0);
      expect(clear).toHaveBeenCalledTimes(1);
      Object.assign(navigator, {
        setAppBadge: () => {
          throw new Error("no");
        },
        clearAppBadge: undefined,
      });
      expect(() => setAppBadge(2)).not.toThrow();
      Object.assign(navigator, { setAppBadge: () => Promise.reject(new Error("denied")) });
      expect(() => setAppBadge(2)).not.toThrow();
    } finally {
      Reflect.deleteProperty(navigator, "setAppBadge");
      Reflect.deleteProperty(navigator, "clearAppBadge");
    }
  });
});
