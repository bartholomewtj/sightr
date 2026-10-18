import { afterEach, describe, expect, it } from "vitest";

import type { Thread } from "@shared/v2/contracts";
import { thread } from "@/test/fixtures";

import { __resetWoke, clearWoke, noteWokeTransitions, observeWoke, useWoke, WAKE_SLACK_MS, WOKE_TTL_MS } from "./woke";

const byId = (...ts: Thread[]) => Object.fromEntries(ts.map((t) => [t.id, t]));
const snoozed = (until: number) => thread("a", { shelf: "snoozed", snoozedUntil: until });
const active = () => thread("a", { shelf: "active" });
const NONE = { snoozed: {}, woke: {} };

afterEach(() => __resetWoke());

describe("noteWokeTransitions", () => {
  it("remembers a snoozed thread with its wake time", () => {
    expect(noteWokeTransitions(NONE, byId(snoozed(5_000)), 1_000)).toEqual({ snoozed: { a: 5_000 }, woke: {} });
  });

  it("a remembered thread that is active at or after its wake time woke by itself", () => {
    const seen = noteWokeTransitions(NONE, byId(snoozed(5_000)), 1_000);
    expect(noteWokeTransitions(seen, byId(active()), 6_000)).toEqual({ snoozed: {}, woke: { a: 6_000 } });
    // A little early is clock skew.
    expect(noteWokeTransitions(seen, byId(active()), 5_000 - WAKE_SLACK_MS).woke).toEqual({ a: 5_000 - WAKE_SLACK_MS });
  });

  it("an early wake (Wake now) and a move to another shelf are not 'Woke'", () => {
    const seen = noteWokeTransitions(NONE, byId(snoozed(500_000)), 1_000);
    expect(noteWokeTransitions(seen, byId(active()), 2_000).woke).toEqual({});
    const late = noteWokeTransitions(NONE, byId(snoozed(5_000)), 1_000);
    expect(noteWokeTransitions(late, byId(thread("a", { shelf: "pinned" })), 9_000).woke).toEqual({});
    expect(noteWokeTransitions(late, byId(thread("a", { shelf: "archived" })), 9_000).woke).toEqual({});
  });

  it("a thread never seen snoozed is never 'Woke'", () => {
    expect(noteWokeTransitions(NONE, byId(active()), 9_000)).toEqual(NONE);
  });

  it("keeps the label while the thread stays active, drops it when it leaves, snoozes again, or is stale", () => {
    const woke = { snoozed: {}, woke: { a: 6_000 } };
    expect(noteWokeTransitions(woke, byId(active()), 7_000).woke).toEqual({ a: 6_000 });
    expect(noteWokeTransitions(woke, byId(thread("a", { shelf: "settled" })), 7_000).woke).toEqual({});
    expect(noteWokeTransitions(woke, byId(), 7_000).woke).toEqual({});
    expect(noteWokeTransitions(woke, byId(snoozed(99_000)), 7_000).woke).toEqual({});
    expect(noteWokeTransitions(woke, byId(active()), 6_000 + WOKE_TTL_MS).woke).toEqual({});
  });
});

describe("the device memory", () => {
  it("survives a reload (localStorage) so a wake while the app was closed still shows, and opening clears it", () => {
    observeWoke(byId(snoozed(5_000)), 1_000);
    // A fresh store reads what the last page wrote.
    useWoke.setState({ snoozed: {}, woke: {} }, true);
    useWoke.setState(JSON.parse(localStorage.getItem("sightr:v2:woke:v1")!), true);
    observeWoke(byId(active()), 6_000);
    expect(useWoke.getState().woke).toEqual({ a: 6_000 });
    clearWoke("a");
    expect(useWoke.getState().woke).toEqual({});
    expect(JSON.parse(localStorage.getItem("sightr:v2:woke:v1")!).woke).toEqual({});
  });
});
