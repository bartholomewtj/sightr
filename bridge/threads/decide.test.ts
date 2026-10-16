import { describe, expect, test } from "bun:test";

import type { Command } from "../../shared/v2/contracts.ts";
import { project, thread } from "../test/thread-fixtures.ts";
import { decide, type DecideState, type Decision } from "./decide.ts";

const NOW = 50_000;
const ctx = { now: NOW, newId: () => "id-1" };
const live = (over: Partial<DecideState> = {}): DecideState => ({ thread: thread(), paneAlive: true, ...over });
const c = (cmd: Record<string, unknown>) => ({ commandId: "c1", threadId: "t1", ...cmd }) as Command;

interface Row {
  name: string;
  state: DecideState;
  command: Command;
  expected: Decision;
}

const shelf = (payload: Record<string, unknown>) => ({
  ok: true,
  events: [{ type: "thread.shelf-changed", threadId: "t1", payload: { ...payload, at: NOW } }],
}) as Decision;
const none: Decision = { ok: true, events: [] };
const reject = (code: "not_found" | "invalid" | "conflict", reason: string): Decision => ({ ok: false, code, reason });

const rows: Row[] = [
  // rename
  {
    name: "rename sets the title and flips the source to user",
    state: live(),
    command: c({ type: "thread.rename", title: "  New name " }),
    expected: {
      ok: true,
      events: [{ type: "thread.updated", threadId: "t1", payload: { patch: { title: "New name", titleSource: "user" }, at: NOW } }],
    },
  },
  { name: "rename refuses an empty title", state: live(), command: c({ type: "thread.rename", title: "   " }), expected: reject("invalid", "empty-title") },
  { name: "rename refuses a long title", state: live(), command: c({ type: "thread.rename", title: "x".repeat(201) }), expected: reject("invalid", "title-too-long") },
  { name: "rename refuses an archived thread", state: live({ thread: thread("t1", { shelf: "archived" }) }), command: c({ type: "thread.rename", title: "a" }), expected: reject("conflict", "archived") },
  { name: "rename of an unknown thread", state: live({ thread: null }), command: c({ type: "thread.rename", title: "a" }), expected: reject("not_found", "no-such-thread") },
  { name: "a state row for another thread is not found", state: live({ thread: thread("t9") }), command: c({ type: "thread.pin" }), expected: reject("not_found", "no-such-thread") },
  // pin / unpin
  { name: "pin takes the next pin order", state: live({ maxPinOrder: 4 }), command: c({ type: "thread.pin" }), expected: shelf({ shelf: "pinned", pinOrder: 5 }) },
  { name: "pin with no pins starts at 1", state: live(), command: c({ type: "thread.pin" }), expected: shelf({ shelf: "pinned", pinOrder: 1 }) },
  { name: "pin of a pinned thread is a no-op", state: live({ thread: thread("t1", { shelf: "pinned", pinOrder: 2 }) }), command: c({ type: "thread.pin" }), expected: none },
  { name: "pin refuses an archived thread", state: live({ thread: thread("t1", { shelf: "archived" }) }), command: c({ type: "thread.pin" }), expected: reject("conflict", "archived") },
  { name: "unpin returns to active", state: live({ thread: thread("t1", { shelf: "pinned" }) }), command: c({ type: "thread.unpin" }), expected: shelf({ shelf: "active" }) },
  { name: "unpin of an unpinned thread is a no-op", state: live(), command: c({ type: "thread.unpin" }), expected: none },
  // snooze
  { name: "snooze until a future time", state: live(), command: c({ type: "thread.snooze", until: NOW + 1 }), expected: shelf({ shelf: "snoozed", snoozedUntil: NOW + 1 }) },
  { name: "snooze refuses a past time", state: live(), command: c({ type: "thread.snooze", until: NOW - 1 }), expected: reject("invalid", "snooze-in-past") },
  { name: "snooze refuses now", state: live(), command: c({ type: "thread.snooze", until: NOW }), expected: reject("invalid", "snooze-in-past") },
  { name: "snooze refuses a non-number", state: live(), command: c({ type: "thread.snooze", until: Number.NaN }), expected: reject("invalid", "bad-time") },
  { name: "snooze refuses an archived thread", state: live({ thread: thread("t1", { shelf: "archived" }) }), command: c({ type: "thread.snooze", until: NOW + 1 }), expected: reject("conflict", "archived") },
  // settle / unsettle
  { name: "settle", state: live(), command: c({ type: "thread.settle" }), expected: shelf({ shelf: "settled" }) },
  { name: "settle of a settled thread is a no-op", state: live({ thread: thread("t1", { shelf: "settled" }) }), command: c({ type: "thread.settle" }), expected: none },
  { name: "settle refuses an archived thread", state: live({ thread: thread("t1", { shelf: "archived" }) }), command: c({ type: "thread.settle" }), expected: reject("conflict", "archived") },
  { name: "unsettle", state: live({ thread: thread("t1", { shelf: "settled" }) }), command: c({ type: "thread.unsettle" }), expected: shelf({ shelf: "active" }) },
  { name: "unsettle of an active thread is a no-op", state: live(), command: c({ type: "thread.unsettle" }), expected: none },
  // archive / unarchive
  {
    name: "archive",
    state: live(),
    command: c({ type: "thread.archive" }),
    expected: { ok: true, events: [{ type: "thread.archived", threadId: "t1", payload: { reason: "user", at: NOW } }] },
  },
  { name: "archive of an archived thread is a no-op", state: live({ thread: thread("t1", { shelf: "archived" }) }), command: c({ type: "thread.archive" }), expected: none },
  { name: "unarchive with the pane alive", state: live({ thread: thread("t1", { shelf: "archived" }) }), command: c({ type: "thread.unarchive" }), expected: shelf({ shelf: "active" }) },
  { name: "unarchive refuses a closed pane", state: live({ thread: thread("t1", { shelf: "archived" }), paneAlive: false }), command: c({ type: "thread.unarchive" }), expected: reject("conflict", "pane-closed") },
  { name: "unarchive of a live thread is a no-op", state: live(), command: c({ type: "thread.unarchive" }), expected: none },
  // read / unread
  {
    name: "markRead clears unreadDone",
    state: live({ thread: thread("t1", { unreadDone: true, status: "done" }) }),
    command: c({ type: "thread.markRead" }),
    expected: { ok: true, events: [{ type: "thread.updated", threadId: "t1", payload: { patch: { unreadDone: false }, at: NOW } }] },
  },
  { name: "markRead of a read thread is a no-op", state: live(), command: c({ type: "thread.markRead" }), expected: none },
  {
    name: "markUnread sets unreadDone",
    state: live(),
    command: c({ type: "thread.markUnread" }),
    expected: { ok: true, events: [{ type: "thread.updated", threadId: "t1", payload: { patch: { unreadDone: true }, at: NOW } }] },
  },
  { name: "markUnread of an unread thread is a no-op", state: live({ thread: thread("t1", { unreadDone: true }) }), command: c({ type: "thread.markUnread" }), expected: none },
  // project.rename
  {
    name: "project.rename sets the label and its source",
    state: { project: project(), paneAlive: false },
    command: { commandId: "c1", type: "project.rename", projectId: "w1", label: " Home " },
    expected: { ok: true, events: [{ type: "project.upserted", payload: { project: { ...project(), label: "Home", labelSource: "user" } } }] },
  },
  { name: "project.rename refuses an empty label", state: { project: project(), paneAlive: false }, command: { commandId: "c1", type: "project.rename", projectId: "w1", label: " " }, expected: reject("invalid", "empty-label") },
  { name: "project.rename of an unknown project", state: { project: null, paneAlive: false }, command: { commandId: "c1", type: "project.rename", projectId: "w1", label: "a" }, expected: reject("not_found", "no-such-project") },
  // effectful commands are routed elsewhere
  ...(
    [
      c({ type: "message.dispatch", text: "hi", mode: "start" }),
      c({ type: "run.interrupt" }),
      c({ type: "queue.resume" }),
      c({ type: "queued.reorder", ids: [] }),
      { commandId: "c1", type: "queued.edit", id: "q", text: "x" },
      { commandId: "c1", type: "queued.cancel", id: "q" },
      { commandId: "c1", type: "runtime-request.respond", requestId: "r", optionIndex: 0 },
      c({ type: "thread.permissionMode.set", mode: "plan" }),
      c({ type: "thread.model.set", model: "opus" }),
      { commandId: "c1", type: "project.create", cwd: "C:/x" },
      { commandId: "c1", type: "thread.create", projectId: "w1", harness: "claude", placement: "tab" },
    ] as Command[]
  ).map((command) => ({
    name: `${command.type} is unsupported here`,
    state: live(),
    command,
    expected: reject("invalid", "unsupported"),
  })),
];

describe("decide", () => {
  for (const row of rows) {
    test(row.name, () => {
      expect(decide(row.state, row.command, ctx)).toEqual(row.expected);
    });
  }

  test("is pure: the same input gives a deep-equal decision", () => {
    for (const row of rows) {
      expect(decide(row.state, row.command, ctx)).toEqual(decide(row.state, row.command, ctx));
    }
  });

  test("does not mutate its input", () => {
    const state = live({ thread: thread("t1", { shelf: "pinned" }) });
    const copy = structuredClone(state);
    decide(state, c({ type: "thread.unpin" }), ctx);
    expect(state).toEqual(copy);
  });
});
