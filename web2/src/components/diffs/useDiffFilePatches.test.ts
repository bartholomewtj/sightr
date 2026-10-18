// The Diff panel's reads against a fake of T26's API (src/test/diffServer.ts): the file list with its ETag, a
// patch only for the files asked for, never more than 4 in flight, unfolded and revealed files first, and a
// refresh that keeps what is on screen.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDiffServer, fakePatch, SHA_FROM, SHA_TO, type FakeFile } from "@/test/diffServer";
import { server } from "@/test/setup";

import { PATCH_CONCURRENCY, PatchEngine, useDiffFilePatches, type Wants } from "./useDiffFilePatches";

const files = (n: number): FakeFile[] => Array.from({ length: n }, (_, i) => ({ path: `src/f${String(i).padStart(2, "0")}.ts` }));
const set = (...paths: string[]): ReadonlySet<string> => new Set(paths);
const wants = (over: Partial<Wants> = {}): Wants => ({ unfolded: set(), near: set(), reveal: null, ...over });

let fake = createDiffServer();
const engines: PatchEngine[] = [];
function engine(): PatchEngine {
  const e = new PatchEngine();
  engines.push(e);
  return e;
}
const stateOf = (e: PatchEngine, path: string) => e.getSnapshot().entries.get(path)?.state;
const ready = async (e: PatchEngine) => waitFor(() => expect(e.getSnapshot().summary.status).toBe("ready"));

beforeEach(() => {
  fake = createDiffServer();
  server.use(...fake.handlers);
});
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

describe("PatchEngine", () => {
  it("reads the file list for a scope, and no patch until a file is wanted", async () => {
    fake.files = files(3);
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    expect(e.getSnapshot().summary.status).toBe("loading");
    await ready(e);
    const s = e.getSnapshot().summary;
    expect(s.status === "ready" && s.files.map((f) => f.path)).toEqual(["src/f00.ts", "src/f01.ts", "src/f02.ts"]);
    expect(fake.listCalls[0]?.searchParams.get("path")).toBe("proj");
    expect(fake.listCalls[0]?.searchParams.get("scope")).toBe("working-tree");
    expect(fake.patchCalls).toHaveLength(0);
  });

  it("never has more than 4 patch requests in flight", async () => {
    fake.files = files(10);
    fake.hold = true;
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await ready(e);
    e.want(wants({ unfolded: set(...fake.files.map((f) => f.path)) }));
    await waitFor(() => expect(fake.inflight).toBe(PATCH_CONCURRENCY));
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.inflight).toBe(4);
    expect(e.inFlight).toBe(4);
    expect(fake.patchCalls).toHaveLength(4);
    act(() => fake.release());
    await waitFor(() => expect(fake.patchCalls).toHaveLength(10));
    await waitFor(() => expect(fake.files.every((f) => stateOf(e, f.path)?.state === "ready")).toBe(true));
    expect(fake.maxInflight).toBeLessThanOrEqual(PATCH_CONCURRENCY);
  });

  it("asks for the revealed file first, then unfolded files in list order, then files near the screen", async () => {
    fake.files = files(8);
    fake.hold = true;
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await ready(e);
    e.want(wants({ reveal: "src/f07.ts", unfolded: set("src/f05.ts", "src/f03.ts"), near: set("src/f01.ts", "src/f02.ts", "src/f03.ts") }));
    await waitFor(() => expect(fake.patchCalls).toHaveLength(4));
    expect(fake.patchPaths()).toEqual(["src/f07.ts", "src/f03.ts", "src/f05.ts", "src/f01.ts"]);
    act(() => fake.release());
    // The one that did not fit comes after.
    await waitFor(() => expect(fake.patchPaths()).toContain("src/f02.ts"));
    // A file nobody wants is never asked for.
    expect(fake.patchPaths()).not.toContain("src/f00.ts");
    expect(fake.patchPaths()).not.toContain("src/f06.ts");
  });

  it("makes no request for a folded file that is off the screen", async () => {
    fake.files = files(5);
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await ready(e);
    e.want(wants({ unfolded: set("src/f01.ts") }));
    await waitFor(() => expect(stateOf(e, "src/f01.ts")?.state).toBe("ready"));
    expect(fake.patchPaths()).toEqual(["src/f01.ts"]);
  });

  it("aborts every request in flight on a scope change", async () => {
    fake.files = files(6);
    fake.hold = true;
    const signals: AbortSignal[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).includes("/review/patch") && init?.signal) signals.push(init.signal);
      return real(input, init);
    });
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await ready(e);
    e.want(wants({ unfolded: set(...fake.files.map((f) => f.path)) }));
    await waitFor(() => expect(signals).toHaveLength(4));
    e.target("proj", { kind: "branch" });
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(e.inFlight).toBe(0);
    expect(e.getSnapshot().summary.status).toBe("loading");
    expect(e.getSnapshot().entries.size).toBe(0);
    act(() => fake.release());
    // The old requests' answers land nowhere: what the engine holds now was asked for under the new scope.
    await ready(e);
    await waitFor(() => expect(fake.patchCalls.some((u) => u.searchParams.get("scope") === "branch")).toBe(true));
    await waitFor(() => expect(fake.files.every((f) => stateOf(e, f.path)?.state === "ready")).toBe(true));
    expect(fake.patchCalls.filter((u) => u.searchParams.get("scope") === "working-tree")).toHaveLength(4);
    const s = e.getSnapshot().summary;
    expect(s.status === "ready" && s.preview.scope).toBe("branch");
  });

  it("aborts every request in flight on dispose (unmount)", async () => {
    fake.files = files(5);
    fake.hold = true;
    const signals: AbortSignal[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (String(input).includes("/review/patch") && init?.signal) signals.push(init.signal);
      return real(input, init);
    });
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await ready(e);
    e.want(wants({ unfolded: set(...fake.files.map((f) => f.path)) }));
    await waitFor(() => expect(fake.inflight).toBe(4));
    expect(signals).toHaveLength(4);
    e.dispose();
    expect(signals.filter((s) => !s.aborted)).toHaveLength(0);
    expect(e.inFlight).toBe(0);
    act(() => fake.release());
  });

  it("retries a file after an error, and only that file", async () => {
    fake.files = [{ path: "a.ts", failTimes: 1 }, { path: "b.ts" }];
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await ready(e);
    e.want(wants({ unfolded: set("a.ts", "b.ts") }));
    await waitFor(() => expect(stateOf(e, "a.ts")?.state).toBe("error"));
    expect(stateOf(e, "b.ts")?.state).toBe("ready");
    // An error is not retried by itself.
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.patchPaths().filter((p) => p === "a.ts")).toHaveLength(1);
    e.retry("a.ts");
    await waitFor(() => expect(stateOf(e, "a.ts")?.state).toBe("ready"));
    expect(fake.patchPaths()).toEqual(["a.ts", "b.ts", "a.ts"]);
  });

  it("gives each kind of file its own state: unavailable, truncated, binary and too large", async () => {
    fake.files = [
      { path: "busy.ts", unavailable: "busy" },
      { path: "cut.ts", truncated: true, patch: fakePatch("cut.ts") },
      { path: "logo.png", binary: true },
      { path: "huge.log", tooLarge: true },
    ];
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await ready(e);
    e.want(wants({ unfolded: set(...fake.files.map((f) => f.path)) }));
    await waitFor(() => expect(stateOf(e, "cut.ts")?.state).toBe("truncated"));
    expect(stateOf(e, "busy.ts")).toMatchObject({ state: "error", retryable: true, message: expect.stringContaining("busy") });
    expect(stateOf(e, "cut.ts")).toMatchObject({ state: "truncated", patch: expect.stringContaining("@@"), message: expect.stringContaining("only the first part") });
    expect(stateOf(e, "logo.png")).toEqual({ state: "binary" });
    expect(stateOf(e, "huge.log")).toMatchObject({ state: "truncated", patch: null });
    // Binary and too-large files are never requested.
    expect(fake.patchPaths().sort()).toEqual(["busy.ts", "cut.ts"]);
  });

  it("treats an HTTP failure as an error with a Retry", async () => {
    fake.files = [{ path: "a.ts", failTimes: 5 }];
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await ready(e);
    e.want(wants({ unfolded: set("a.ts") }));
    await waitFor(() => expect(stateOf(e, "a.ts")).toMatchObject({ state: "error", retryable: true, message: "Couldn't load this diff." }));
  });

  it("sends the list the last diffHash, and a 304 changes nothing", async () => {
    fake.files = files(2);
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await ready(e);
    e.want(wants({ unfolded: set("src/f00.ts") }));
    await waitFor(() => expect(stateOf(e, "src/f00.ts")?.state).toBe("ready"));
    const before = e.getSnapshot();
    await e.refresh();
    expect(fake.listHeaders.at(-1)?.ifNoneMatch).toBe('"h1"');
    expect(e.getSnapshot()).toBe(before); // not even a new object
    expect(fake.patchCalls).toHaveLength(1);
  });

  it("on a new diffHash keeps the old patches on screen and refetches only the unfolded and near files", async () => {
    fake.files = files(4);
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await ready(e);
    // f00 and f01 get a patch, then f01 is folded away and off the screen.
    e.want(wants({ unfolded: set("src/f00.ts", "src/f01.ts") }));
    await waitFor(() => expect(stateOf(e, "src/f01.ts")?.state).toBe("ready"));
    await waitFor(() => expect(stateOf(e, "src/f00.ts")?.state).toBe("ready"));
    e.want(wants({ unfolded: set("src/f00.ts"), near: set("src/f02.ts") }));
    await waitFor(() => expect(stateOf(e, "src/f02.ts")?.state).toBe("ready"));
    const calls = fake.patchCalls.length;

    fake.setFiles(fake.files.map((f) => ({ ...f, version: 1 })));
    fake.hold = true;
    await e.refresh();
    // The old patch is still there while the new one loads.
    await waitFor(() => expect(stateOf(e, "src/f00.ts")).toMatchObject({ state: "loading", patch: expect.stringContaining("old 0") }));
    act(() => fake.release());
    await waitFor(() => expect(stateOf(e, "src/f00.ts")).toMatchObject({ state: "ready", patch: expect.stringContaining("old 1") }));
    await waitFor(() => expect(stateOf(e, "src/f02.ts")).toMatchObject({ state: "ready", patch: expect.stringContaining("old 1") }));
    expect(fake.patchCalls.length - calls).toBe(2); // f00 and f02; f01 (folded, off screen) and f03 (never wanted) are not asked for
    expect(stateOf(e, "src/f01.ts")).toMatchObject({ state: "ready", patch: expect.stringContaining("old 0") });
  });

  it("drops a file that left the list, and says when the list is not available", async () => {
    fake.files = files(3);
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await ready(e);
    e.want(wants({ unfolded: set("src/f01.ts") }));
    await waitFor(() => expect(stateOf(e, "src/f01.ts")?.state).toBe("ready"));
    fake.setFiles(fake.files.filter((f) => f.path !== "src/f01.ts"));
    await e.refresh();
    expect(e.getSnapshot().entries.has("src/f01.ts")).toBe(false);
    fake.listUnavailable = "not-a-repo";
    await e.refresh();
    expect(e.getSnapshot().summary).toEqual({ status: "unavailable", reason: "not-a-repo" });
  });

  it("names a branch scope's base and range in the requests", async () => {
    fake.files = [{ path: "a.ts" }];
    const e = engine();
    e.target("proj", { kind: "branch", baseRef: "develop" });
    await ready(e);
    expect(fake.listCalls[0]?.searchParams.get("scope")).toBe("branch");
    expect(fake.listCalls[0]?.searchParams.get("base")).toBe("develop");
    e.want(wants({ unfolded: set("a.ts") }));
    await waitFor(() => expect(fake.patchCalls).toHaveLength(1));
    const q = fake.patchCalls[0]!.searchParams;
    expect([q.get("scope"), q.get("base"), q.get("from"), q.get("to"), q.get("file")]).toEqual(["branch", "develop", SHA_FROM, SHA_TO, "a.ts"]);
  });

  it("sends a rename's old path", async () => {
    fake.files = [{ path: "new.ts", oldPath: "old.ts", kind: "renamed" }];
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await ready(e);
    e.want(wants({ unfolded: set("new.ts") }));
    await waitFor(() => expect(fake.patchCalls).toHaveLength(1));
    expect(fake.patchCalls[0]!.searchParams.get("oldFile")).toBe("old.ts");
  });

  it("reports a failed list as an error, not an empty one", async () => {
    server.use(...[]);
    fake.listUnavailable = null;
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => (String(input).includes("/review?") ? Promise.reject(new TypeError("offline")) : real(input, init)));
    const e = engine();
    e.target("proj", { kind: "workingTree" });
    await waitFor(() => expect(e.getSnapshot().summary.status).toBe("error"));
  });

  it("does nothing without a folder or a scope", () => {
    const e = engine();
    e.target(null, { kind: "workingTree" });
    e.target("proj", null);
    expect(e.getSnapshot().summary.status).toBe("idle");
    expect(fake.listCalls).toHaveLength(0);
  });
});

describe("useDiffFilePatches", () => {
  it("fetches the list, the unfolded file's patch, and again on a refresh token", async () => {
    fake.files = files(3);
    const { result, rerender, unmount } = renderHook((p: { unfolded: ReadonlySet<string>; token: number }) => useDiffFilePatches({ folderPath: "proj", scope: { kind: "workingTree" }, unfolded: p.unfolded, near: set(), revealPath: null, refreshToken: p.token }), {
      initialProps: { unfolded: set("src/f01.ts"), token: 0 },
    });
    await waitFor(() => expect(result.current.files).toHaveLength(3));
    await waitFor(() => expect(result.current.patchFor("src/f01.ts").state).toBe("ready"));
    expect(result.current.patchFor("src/f00.ts").state).toBe("idle");
    expect(fake.listCalls).toHaveLength(1);
    rerender({ unfolded: set("src/f01.ts"), token: 1 });
    await waitFor(() => expect(fake.listCalls).toHaveLength(2));
    expect(fake.listHeaders[1]?.ifNoneMatch).toBe('"h1"');
    unmount();
  });

  it("waits for the folder, then starts; and starts over for another scope", async () => {
    fake.files = files(1);
    const { result, rerender } = renderHook((p: { folder: string | undefined; baseRef?: string }) => useDiffFilePatches({ folderPath: p.folder, scope: p.baseRef ? { kind: "branch", baseRef: p.baseRef } : { kind: "workingTree" }, unfolded: set(), near: set(), revealPath: null, refreshToken: 0 }), {
      initialProps: { folder: undefined, baseRef: undefined } as { folder: string | undefined; baseRef?: string },
    });
    expect(result.current.summary.status).toBe("idle");
    expect(fake.listCalls).toHaveLength(0);
    rerender({ folder: "proj" });
    await waitFor(() => expect(result.current.summary.status).toBe("ready"));
    rerender({ folder: "proj", baseRef: "develop" });
    await waitFor(() => expect(fake.listCalls).toHaveLength(2));
    expect(fake.listCalls[1]?.searchParams.get("base")).toBe("develop");
    await waitFor(() => expect(result.current.summary.status === "ready" && result.current.summary.preview.scope).toBe("branch"));
  });

  it("marks a file whose rev changed as loading (old patch kept) until its refetch lands", async () => {
    fake.files = [{ path: "a.ts" }];
    const { result, rerender } = renderHook((p: { token: number }) => useDiffFilePatches({ folderPath: "proj", scope: { kind: "workingTree" }, unfolded: set("a.ts"), near: set(), revealPath: null, refreshToken: p.token }), { initialProps: { token: 0 } });
    await waitFor(() => expect(result.current.patchFor("a.ts").state).toBe("ready"));
    fake.setFiles([{ path: "a.ts", version: 1 }]);
    fake.hold = true;
    rerender({ token: 1 });
    await waitFor(() => expect(result.current.patchFor("a.ts")).toMatchObject({ state: "loading", patch: expect.stringContaining("old 0") }));
    act(() => fake.release());
    await waitFor(() => expect(result.current.patchFor("a.ts")).toMatchObject({ state: "ready", patch: expect.stringContaining("old 1") }));
  });
});
