import {
  dropLastPaneText,
  loadLastPaneText,
  loadLastSnapshot,
  saveLastPaneText,
  saveLastSnapshot,
} from "./last-seen";
import { fixtureSnapshot } from "@/test/handlers";

beforeEach(() => {
  sessionStorage.clear();
});

describe("the write-through last-seen cache", () => {
  it("reads back a snapshot with the time it was written", () => {
    saveLastSnapshot(fixtureSnapshot, 1_700_000_000_000);
    const got = loadLastSnapshot();
    expect(got?.at).toBe(1_700_000_000_000);
    expect(got?.value.agents).toHaveLength(fixtureSnapshot.agents.length);
  });

  it("reads back a pane mirror verbatim, newlines and all", () => {
    const text = "line one\nline two\n\n❯ ";
    saveLastPaneText("w1:p1", text, 42);
    expect(loadLastPaneText("w1:p1")).toEqual({ at: 42, value: text });
  });

  it("drops a pane on request", () => {
    saveLastPaneText("w1:p1", "hello");
    dropLastPaneText("w1:p1");
    expect(loadLastPaneText("w1:p1")).toBeNull();
  });

  it("keeps only the newest few panes", () => {
    for (let i = 0; i < 8; i++) saveLastPaneText(`w1:p${i}`, `pane ${i}`, 1000 + i);
    expect(loadLastPaneText("w1:p7")).not.toBeNull();
    expect(loadLastPaneText("w1:p0")).toBeNull();
  });

  // Every read is total: a hand-edited or format-drifted entry reads as a miss, never a throw — a
  // cache miss costs a stale render, an exception costs the whole boot this cache exists to save.
  it.each([
    ["not json at all", "sightr:last-snapshot:", "{{{"],
    ["a json array", "sightr:last-snapshot:", "[]"],
    ["an entry with no stamp", "sightr:last-snapshot:", JSON.stringify({ value: {} })],
    ["a pane with no stamp line", "sightr:last-pane:w1:p1", "just text"],
  ])("treats %s as a miss", (_name, key, raw) => {
    sessionStorage.setItem(key, raw);
    expect(loadLastSnapshot() ?? loadLastPaneText("w1:p1")).toBeNull();
  });

  it("survives a store that refuses to write", () => {
    const boom = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveLastSnapshot(fixtureSnapshot)).not.toThrow();
    boom.mockRestore();
  });
});
