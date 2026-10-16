import { describe, expect, test } from "bun:test";

import { HerdrClient, type PaneRead } from "./herdr-client.ts";

/** A client whose wire is a list of pending calls the test settles by hand. */
function stubbed() {
  const client = new HerdrClient("unused");
  const calls: Array<{ method: string; params: Record<string, unknown>; settle: (value: unknown) => void }> = [];
  (client as unknown as { request: (method: string, params: Record<string, unknown>) => Promise<unknown> }).request = (method, params) =>
    new Promise((resolve) => calls.push({ method, params, settle: resolve }));
  const reads = () => calls.filter((c) => c.method === "pane.read");
  const answer = (i: number, text: string) => reads()[i]!.settle({ read: { pane_id: "w1:p1", text, truncated: false, revision: 0 } satisfies PaneRead });
  return { client, calls, reads, answer };
}

describe("HerdrClient pane reads", () => {
  test("the same read in flight is shared, a different shape is not", async () => {
    const { client, reads, answer } = stubbed();
    const a = client.readPane("w1:p1", "recent", 200, "ansi");
    const b = client.readPane("w1:p1", "recent", 200, "ansi");
    client.readPane("w1:p1", "visible", 40, "text");
    expect(reads().length).toBe(2);
    answer(0, "screen");
    expect((await a).text).toBe("screen");
    expect((await b).text).toBe("screen");
  });

  test("nothing is kept once a read settles", async () => {
    const { client, reads, answer } = stubbed();
    const first = client.readPane("w1:p1", "recent", 200, "ansi");
    answer(0, "old");
    await first;
    client.readPane("w1:p1", "recent", 200, "ansi");
    expect(reads().length).toBe(2);
  });

  test("a read after a keystroke never joins one from before it", async () => {
    const { client, calls, reads, answer } = stubbed();
    const before = client.readPane("w1:p1", "recent", 200, "ansi");
    const keys = client.sendPaneKeys("w1:p1", ["a"]);
    const during = client.readPane("w1:p1", "recent", 200, "ansi");
    calls.find((c) => c.method === "pane.send_keys")!.settle(undefined);
    await keys;
    const after = client.readPane("w1:p1", "recent", 200, "ansi");
    expect(reads().length).toBe(3);
    answer(0, "before a");
    answer(1, "during");
    answer(2, "after a");
    expect((await before).text).toBe("before a");
    expect((await during).text).toBe("during");
    expect((await after).text).toBe("after a");
  });

  test("a write to another pane leaves this pane's read shared", () => {
    const { client, reads } = stubbed();
    client.readPane("w1:p1", "recent", 200, "ansi");
    void client.sendPaneText("w1:p2", "hi");
    client.readPane("w1:p1", "recent", 200, "ansi");
    expect(reads().length).toBe(1);
  });
});
