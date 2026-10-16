import { describe, expect, test } from "bun:test";

import type { Config } from "./config.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { createPaneQueue } from "./pane-queue.ts";
import { keysPane, sendTypedKeys, typedSegments } from "./pane-write-routes.ts";
import { FakeHerdrClient } from "./test/fake-herdr.ts";

const cfg = { submitKeys: ["Enter"], readLines: 100 } as unknown as Config;
const noSleep = async () => {};

function keysReq(body: unknown): Request {
  return new Request("http://127.0.0.1:8787/api/pane/w1:p1/keys", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" },
    body: JSON.stringify(body),
  });
}

describe("typed keys", () => {
  test("runs of characters group; named keys stand alone", () => {
    expect(typedSegments(["h", "i", "Space", "y", "o", "u", "Enter", "Backspace", "x", "é", "😀"])).toEqual([
      { text: "hi you" },
      { key: "Enter" },
      { key: "Backspace" },
      { text: "xé😀" },
    ]);
    expect(typedSegments(["ctrl+c", "Tab", "Up"])).toEqual([{ key: "ctrl+c" }, { key: "Tab" }, { key: "Up" }]);
    expect(typedSegments(["\u0003"])).toEqual([{ key: "\u0003" }]);
  });

  test("text runs go as one write, keys one RPC each", async () => {
    const herdr = new FakeHerdrClient();
    await sendTypedKeys(herdr, "w1:p1", ["l", "s", "Space", "-", "a", "Enter"], noSleep);
    expect(herdr.texts).toEqual([["w1:p1", "ls -a"]]);
    expect(herdr.keys).toEqual([["w1:p1", ["Enter"]]]);
  });

  test("the keys route groups only when the batch says it was typed", async () => {
    const typed = new FakeHerdrClient();
    const res = await keysPane(typed as unknown as HerdrClient, cfg, "w1:p1", keysReq({ keys: ["o", "k"], typed: true }), createPaneQueue(), undefined, noSleep);
    expect(res.status).toBe(200);
    expect(typed.texts).toEqual([["w1:p1", "ok"]]);
    expect(typed.keys).toEqual([]);

    const recipe = new FakeHerdrClient();
    await keysPane(recipe as unknown as HerdrClient, cfg, "w1:p1", keysReq({ keys: ["o", "k"] }), createPaneQueue(), undefined, noSleep);
    expect(recipe.texts).toEqual([]);
    expect(recipe.keys).toEqual([["w1:p1", ["o"]], ["w1:p1", ["k"]]]);
  });

  test("a non-boolean typed flag is refused", async () => {
    const herdr = new FakeHerdrClient();
    const res = await keysPane(herdr as unknown as HerdrClient, cfg, "w1:p1", keysReq({ keys: ["a"], typed: "yes" }), createPaneQueue(), undefined, noSleep);
    expect(res.status).toBe(400);
    expect(herdr.texts).toEqual([]);
  });
});
