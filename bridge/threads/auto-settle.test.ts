import { afterEach, describe, expect, test } from "bun:test";

import type { RuntimeRequest } from "../../shared/v2/contracts.ts";
import { createProject, createThread, project, thread } from "../test/thread-fixtures.ts";
import { autoSettleEvents, createAutoSettler, DAY_MS } from "./auto-settle.ts";
import type { ServerThread } from "./events.ts";
import { requestEvents } from "./request-items.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";

const NOW = 100 * DAY_MS;
const old = NOW - 8 * DAY_MS;
const t = (id: string, over: Partial<ServerThread> = {}) => thread(id, { lastActivityAt: old, ...over });

describe("autoSettleEvents", () => {
  test("settles active idle/done threads past the window; 0 days is off", () => {
    const threads = [t("idle"), t("done", { status: "done", unreadDone: true }), t("fresh", { lastActivityAt: NOW - DAY_MS })];
    const events = autoSettleEvents(threads, { now: NOW, days: 7, waiting: new Set() });
    expect(events).toEqual([
      { type: "thread.shelf-changed", threadId: "idle", payload: { shelf: "settled", at: NOW } },
      { type: "thread.shelf-changed", threadId: "done", payload: { shelf: "settled", at: NOW } },
    ]);
    expect(autoSettleEvents(threads, { now: NOW, days: 0, waiting: new Set() })).toEqual([]);
  });

  test("never pinned, snoozed, settled, archived, working, starting, failed or needs-you; never one with a request or queue", () => {
    const threads = [
      t("pinned", { shelf: "pinned" }),
      t("snoozed", { shelf: "snoozed" }),
      t("settled", { shelf: "settled" }),
      t("archived", { shelf: "archived" }),
      t("working", { status: "working" }),
      t("starting", { status: "starting" }),
      t("failed", { status: "failed" }),
      t("input", { status: "input" }),
      t("approval", { status: "approval" }),
      t("waiting"),
    ];
    expect(autoSettleEvents(threads, { now: NOW, days: 7, waiting: new Set(["waiting"]) })).toEqual([]);
  });
});

describe("createAutoSettler", () => {
  const stores: ThreadStore[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
  });

  test("reads the setting each tick, writes the settle, and runs on its timer", () => {
    const store = openThreadStore(":memory:", { now: () => NOW });
    stores.push(store);
    store.append([createProject(project()), createThread(t("a")), createThread(t("b")), createThread(t("c"))]);
    const request: RuntimeRequest = {
      id: "r1",
      threadId: "b",
      kind: "permission",
      prompt: "Allow?",
      options: [],
      status: "pending",
      bindingHash: "h",
      createdAt: 1,
      updatedAt: 1,
    };
    store.append(requestEvents(request, "Allow?"));
    let days = 0;
    const ticks: (() => void)[] = [];
    const settler = createAutoSettler({
      store,
      days: () => days,
      now: () => NOW,
      timers: { setInterval: (fn) => ticks.push(fn), clearInterval: () => {} },
      log: () => {},
    });
    settler.start();
    expect(store.getThread("a")?.shelf).toBe("active");
    days = 7;
    ticks[0]!();
    expect(store.getThread("a")).toMatchObject({ shelf: "settled", settledAt: NOW });
    expect(store.getThread("b")?.shelf).toBe("active"); // it has a pending request
    expect(store.getThread("c")?.shelf).toBe("settled");
    expect(settler.tick()).toBe(0);
    settler.stop();
  });
});
