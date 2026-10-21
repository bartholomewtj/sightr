import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HerdrClient } from "../herdr-client.ts";
import { createV2Gate, HERDR_FLOOR, meetsFloor, parseHerdrVersion } from "./herdr-floor.ts";

describe("parseHerdrVersion / meetsFloor", () => {
  test("reads the leading major.minor.patch and ignores a suffix", () => {
    expect(parseHerdrVersion("0.9.0")).toEqual([0, 9, 0]);
    expect(parseHerdrVersion("0.9.0-preview")).toEqual([0, 9, 0]);
    expect(parseHerdrVersion("0.9.0-preview.2026-09-16-2c29fb29e302")).toEqual([0, 9, 0]);
    expect(parseHerdrVersion("0.10.1+build.7")).toEqual([0, 10, 1]);
    expect(parseHerdrVersion("1.0.0")).toEqual([1, 0, 0]);
    expect(parseHerdrVersion("garbage")).toBeNull();
    expect(parseHerdrVersion("<0.7")).toBeNull();
    expect(parseHerdrVersion("0.9")).toBeNull();
  });

  test("compares numerically against 0.9.0", () => {
    expect(HERDR_FLOOR).toBe("0.9.0");
    expect(meetsFloor("0.9.0")).toBe(true);
    expect(meetsFloor("0.9.0-preview")).toBe(true);
    expect(meetsFloor("0.10.1")).toBe(true);
    expect(meetsFloor("1.0.0")).toBe(true);
    expect(meetsFloor("0.8.9")).toBe(false);
    expect(meetsFloor("0.7.5")).toBe(false);
    expect(meetsFloor("<0.7")).toBe(false);
    expect(meetsFloor("garbage")).toBe(false);
  });
});

function fakeHerdr(answers: (string | Error)[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    serverVersion: async () => {
      const a = answers[Math.min(calls++, answers.length - 1)]!;
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

describe("createV2Gate", () => {
  test("ok at or above the floor; whenOk runs then, and at once afterwards", async () => {
    const gate = createV2Gate({ log: () => {} });
    const ran: string[] = [];
    gate.whenOk(() => ran.push("early"));
    expect(gate.state()).toBe("pending");
    const herdr = fakeHerdr(["0.9.0-preview.x"]);
    await gate.check(herdr);
    expect(gate.state()).toBe("ok");
    expect(gate.version()).toBe("0.9.0-preview.x");
    expect(ran).toEqual(["early"]);
    gate.whenOk(() => ran.push("late"));
    expect(ran).toEqual(["early", "late"]);
  });

  test("too-old below the floor: whenOk never runs and the reason names both versions", async () => {
    const gate = createV2Gate({ log: () => {} });
    let ran = false;
    gate.whenOk(() => (ran = true));
    await gate.check(fakeHerdr(["0.8.9"]));
    expect(gate.state()).toBe("too-old");
    expect(gate.reason()).toBe("v2 needs herdr >= 0.9.0 (found 0.8.9)");
    gate.whenOk(() => (ran = true));
    expect(ran).toBe(false);
  });

  test("unreachable stays pending; the next check after the link comes up decides; then it is fixed", async () => {
    const gate = createV2Gate({ log: () => {} });
    const herdr = fakeHerdr([new Error("connect ENOENT"), "0.9.1", "0.1.0"]);
    await gate.check(herdr);
    expect(gate.state()).toBe("pending");
    await gate.check(herdr);
    expect(gate.state()).toBe("ok");
    await gate.check(herdr);
    expect(herdr.calls).toBe(2);
    expect(gate.state()).toBe("ok");
  });

  test("concurrent checks share one request", async () => {
    const gate = createV2Gate({ log: () => {} });
    const herdr = fakeHerdr(["0.9.0"]);
    await Promise.all([gate.check(herdr), gate.check(herdr), gate.check(herdr)]);
    expect(herdr.calls).toBe(1);
  });
});

describe("HerdrClient.serverVersion", () => {
  test("returns session.snapshot's version", async () => {
    const client = new HerdrClient("/nope");
    (client as unknown as { sessionSnapshot: () => Promise<unknown> }).sessionSnapshot = async () => ({ version: "0.9.0" });
    expect(await client.serverVersion()).toBe("0.9.0");
  });

  test("a server without session.snapshot reads as <0.7; other failures throw", async () => {
    const client = new HerdrClient("/nope");
    const stub = client as unknown as { sessionSnapshot: () => Promise<unknown> };
    stub.sessionSnapshot = async () => {
      throw new Error("herdr session.snapshot: unknown variant `session.snapshot`");
    };
    expect(await client.serverVersion()).toBe("<0.7");
    stub.sessionSnapshot = async () => {
      throw new Error("herdr session.snapshot: timed out after 2000ms");
    };
    await expect(client.serverVersion()).rejects.toThrow("timed out");
  });
});

describe("the advertised floor (spec 4.1)", () => {
  // The marketplace floor and the runtime floor disagreed once (0.7.0 vs 0.9.0). Pin them together.
  test("herdr-plugin.toml's min_herdr_version is not below HERDR_FLOOR", () => {
    const toml = readFileSync(join(import.meta.dir, "../../herdr-plugin.toml"), "utf8");
    const min = /^min_herdr_version\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
    expect(min).toBeDefined();
    expect(meetsFloor(min!)).toBe(true);
  });
});
