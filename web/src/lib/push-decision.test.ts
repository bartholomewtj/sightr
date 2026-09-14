import { describe, expect, test } from "vitest";

import { decidePush, tagFor } from "@/lib/push-decision";

describe("decidePush", () => {
  test("a clear retracts the slot regardless of client visibility", () => {
    const expected = { kind: "clear", tag: "sightr:herd" };
    expect(decidePush({ type: "clear", tag: "sightr:herd" }, false)).toEqual(expected);
    expect(decidePush({ type: "clear", tag: "sightr:herd" }, true)).toEqual(expected);
  });

  test("suppresses a show when a Sightr tab is visible", () => {
    expect(decidePush({ title: "claude needs you", tag: "sightr:herd" }, true)).toEqual({
      kind: "suppress",
    });
  });

  test("shows with the bridge-provided tag, renotify, and deep-link paneId", () => {
    expect(
      decidePush(
        {
          title: "2 agents need you",
          body: "claude, grok",
          tag: "sightr:herd",
          renotify: true,
          data: { paneId: "p1" },
        },
        false,
      ),
    ).toEqual({
      kind: "show",
      title: "2 agents need you",
      body: "claude, grok",
      tag: "sightr:herd",
      paneId: "p1",
      renotify: true,
    });
  });

  test("falls back to a per-pane tag, default title, empty body, and renotify off", () => {
    expect(decidePush({ data: { paneId: "test" } }, false)).toEqual({
      kind: "show",
      title: "Sightr",
      body: "",
      tag: "sightr:test",
      paneId: "test",
      renotify: false,
    });
  });

  test("a push with no paneId and no tag shares the generic 'sightr' slot", () => {
    expect(decidePush({ title: "hi" }, false)).toMatchObject({
      kind: "show",
      tag: "sightr",
      paneId: undefined,
    });
  });

  test("an agent push carries its paneId for the tap deep-link", () => {
    const decision = decidePush({ title: "claude needs you", data: { paneId: "p1" } }, false);
    expect(decision).toMatchObject({ kind: "show", paneId: "p1" });
  });
});

describe("tagFor", () => {
  test("per-pane vs generic slot", () => {
    expect(tagFor("p1")).toBe("sightr:p1");
    expect(tagFor(undefined)).toBe("sightr");
  });
});
