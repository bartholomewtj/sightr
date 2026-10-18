import { REVIEW_PATHS, type ReviewSide } from "@shared/v2/review";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";

import { DiffContentsCache, type DiffContentsTarget } from "./diffFileContents";

const text = (t: string): ReviewSide => ({ state: "text", text: t, crlf: false });
const target = (over: Partial<DiffContentsTarget> = {}): DiffContentsTarget => ({
  folder: "proj",
  scope: { kind: "working-tree" },
  diffHash: "h1",
  file: { path: "src/a.ts" },
  range: {},
  ...over,
});

function answer(handler: (url: URL) => Response | Promise<Response>) {
  const calls: URL[] = [];
  server.use(http.get(REVIEW_PATHS.contents, ({ request }) => { const url = new URL(request.url); calls.push(url); return handler(url); }));
  return calls;
}
const ok = (old: ReviewSide, now: ReviewSide) => HttpResponse.json({ available: true, old, new: now, diffHash: "c" });

describe("DiffContentsCache", () => {
  it("asks once per file however many times it is loaded, and shares the answer", async () => {
    const calls = answer(() => ok(text("a\n"), text("b\n")));
    const cache = new DiffContentsCache();
    const all = await Promise.all([cache.load(target()), cache.load(target()), cache.load(target())]);
    expect(await cache.load(target())).toEqual({ oldText: "a\n", newText: "b\n" });
    expect(all.every((r) => r !== null && "newText" in r)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(cache.requests).toBe(1);
    expect(calls[0]!.searchParams.get("file")).toBe("src/a.ts");
    expect(calls[0]!.searchParams.get("path")).toBe("proj");
  });

  it("keys the answer by scope, folder, path and the list's diffHash: a new hash reads the file again", async () => {
    const calls = answer(() => ok(text(""), text("x\n")));
    const cache = new DiffContentsCache();
    await cache.load(target());
    await cache.load(target({ diffHash: "h2" }));
    await cache.load(target({ file: { path: "src/b.ts" } }));
    await cache.load(target({ scope: { kind: "branch", base: "main" }, range: { from: "a".repeat(40), to: "b".repeat(40) } }));
    expect(calls).toHaveLength(4);
    const branch = calls[3]!;
    expect(branch.searchParams.get("scope")).toBe("branch");
    expect(branch.searchParams.get("base")).toBe("main");
    expect(branch.searchParams.get("from")).toBe("a".repeat(40));
    await cache.load(target());
    expect(calls).toHaveLength(4);
  });

  it("names a renamed file's old path, and never asks for whitespace to be ignored", async () => {
    const calls = answer(() => ok(text(""), text("x\n")));
    await new DiffContentsCache().load(target({ scope: { kind: "working-tree", ignoreWhitespace: true }, file: { path: "new.ts", oldPath: "old.ts" } }));
    expect(calls[0]!.searchParams.get("oldFile")).toBe("old.ts");
    expect(calls[0]!.searchParams.has("ignoreWhitespace")).toBe(false);
  });

  it.each([
    ["binary", { state: "binary", bytes: 5 }, { unavailable: "binary" }],
    ["too large", { state: "too-large", bytes: 5_000_000 }, { unavailable: "too-large" }],
    ["absent (deleted on disk)", { state: "absent" }, { unavailable: "absent" }],
  ] as const)("maps a %s new side to a state, and keeps it", async (_name, side, expected) => {
    const calls = answer(() => ok(text("old\n"), side));
    const cache = new DiffContentsCache();
    expect(await cache.load(target())).toEqual(expected);
    expect(await cache.load(target())).toEqual(expected);
    expect(calls).toHaveLength(1);
  });

  it("maps a refused name (404) to a state, and keeps it", async () => {
    const calls = answer(() => new HttpResponse("not found", { status: 404 }));
    const cache = new DiffContentsCache();
    expect(await cache.load(target())).toEqual({ unavailable: "refused" });
    expect(await cache.load(target())).toEqual({ unavailable: "refused" });
    expect(calls).toHaveLength(1);
  });

  it("answers null for a failure and does not cache it, so a retry asks again", async () => {
    let n = 0;
    const calls = answer(() => (++n === 1 ? new HttpResponse("boom", { status: 500 }) : ok(text(""), text("x\n"))));
    const cache = new DiffContentsCache();
    expect(await cache.load(target())).toBeNull();
    expect(await cache.load(target())).toEqual({ oldText: "", newText: "x\n" });
    expect(calls).toHaveLength(2);
    // An `available: false` answer is a failure too.
    answer(() => HttpResponse.json({ available: false, reason: "busy" }));
    expect(await new DiffContentsCache().load(target())).toBeNull();
  });

  it("aborts what is in flight when disposed (the panel unmounted)", async () => {
    let signal: AbortSignal | undefined;
    server.use(http.get(REVIEW_PATHS.contents, async ({ request }) => { signal = request.signal; await new Promise((r) => setTimeout(r, 200)); return ok(text(""), text("x\n")); }));
    const cache = new DiffContentsCache();
    const pending = cache.load(target());
    await new Promise((r) => setTimeout(r, 30));
    cache.dispose();
    expect(await pending).toBeNull();
    expect(signal?.aborted).toBe(true);
  });
});
