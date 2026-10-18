import { beforeEach, describe, expect, it } from "vitest";

import { setViewportWidth } from "@/test/media";

import {
  __resetDiffPanelStore,
  DIFF_SCOPE_THREAD_CAP,
  sameScope,
  sanitizeScope,
  scopeKey,
  useDiffPanelStore,
  WORKING_TREE,
} from "./diffPanelStore";
import { useRightPanelStore } from "./rightPanelStore";

const KEY = "sightr:v2:diff-panel:v1";
const state = () => useDiffPanelStore.getState();

beforeEach(() => {
  localStorage.clear();
  __resetDiffPanelStore();
});

describe("diffPanelStore", () => {
  it("keeps a scope per thread and persists it", () => {
    state().setScope("t1", { kind: "branch", baseRef: "origin/main" });
    state().setScope("t2", { kind: "run", runId: "r7" });
    expect(state().scopes).toEqual({ t1: { kind: "branch", baseRef: "origin/main" }, t2: { kind: "run", runId: "r7" } });
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as { state: { scopes: unknown } };
    expect(stored.state.scopes).toEqual(state().scopes);
    // The reveal is not persisted.
    state().openDiff("t1", WORKING_TREE, "src/a.ts");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").state).not.toHaveProperty("reveal");
  });

  it("keeps the newest 50 threads", () => {
    for (let i = 0; i < DIFF_SCOPE_THREAD_CAP + 5; i++) state().setScope(`t${i}`, { kind: "run", runId: `r${i}` });
    expect(Object.keys(state().scopes)).toHaveLength(DIFF_SCOPE_THREAD_CAP);
    expect(state().scopes["t0"]).toBeUndefined();
    expect(state().scopes["t4"]).toBeUndefined();
    expect(state().scopes["t5"]).toBeDefined();
    // Touching an old thread makes it the newest.
    state().setScope("t5", WORKING_TREE);
    state().setScope("new", WORKING_TREE);
    expect(state().scopes["t5"]).toBeDefined();
    expect(state().scopes["t6"]).toBeUndefined();
  });

  it("falls back to the working tree for corrupt or unknown stored values", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: { scopes: { a: { kind: "weird" }, b: "nope", c: { kind: "branch", baseRef: 5 }, d: { kind: "run" }, e: { kind: "run", runId: "r1" }, f: { kind: "branch", baseRef: " main " } }, recent: ["a", "b", "c", "d", "e", "f"] },
        version: 1,
      }),
    );
    await useDiffPanelStore.persist.rehydrate();
    expect(state().scopes).toEqual({
      a: WORKING_TREE,
      b: WORKING_TREE,
      c: { kind: "branch" },
      d: WORKING_TREE,
      e: { kind: "run", runId: "r1" },
      f: { kind: "branch", baseRef: "main" },
    });
  });

  it("survives storage that is not JSON at all", async () => {
    localStorage.setItem(KEY, "{not json");
    await useDiffPanelStore.persist.rehydrate();
    expect(state().scopes).toEqual({});
  });

  it("raises the reveal's requestId on every call, so a second tap on the same file scrolls again", () => {
    state().openDiff("t1", WORKING_TREE, "src/a.ts");
    const first = state().reveal;
    state().openDiff("t1", WORKING_TREE, "src/a.ts");
    const second = state().reveal;
    expect(first).toMatchObject({ threadId: "t1", filePath: "src/a.ts" });
    expect(second!.requestId).toBeGreaterThan(first!.requestId);
    state().openDiffForRun("t1", "r2", "src/b.ts");
    expect(state().reveal!.requestId).toBeGreaterThan(second!.requestId);
  });

  it("consumes a reveal once, and only the one asked for", () => {
    state().openDiff("t1", WORKING_TREE, "src/a.ts");
    const { requestId } = state().reveal!;
    state().consumeReveal(requestId + 1);
    expect(state().reveal).not.toBeNull();
    state().consumeReveal(requestId);
    expect(state().reveal).toBeNull();
  });

  it("opens with no file: the scope changes and nothing is revealed", () => {
    state().openDiff("t1", { kind: "branch" });
    expect(state().reveal).toBeNull();
    expect(state().scopes["t1"]).toEqual({ kind: "branch" });
  });

  it("opens the Diff sheet on a phone and the Diff tab on a desktop", () => {
    setViewportWidth(390);
    state().openDiffForRun("t1", "r1", "src/a.ts");
    expect(useRightPanelStore.getState()).toMatchObject({ sheet: "diff" });
    expect(state().scopes["t1"]).toEqual({ kind: "run", runId: "r1" });
    useRightPanelStore.getState().closeSheet();

    setViewportWidth(1280);
    useRightPanelStore.getState().close();
    state().openDiff("t1", WORKING_TREE);
    expect(useRightPanelStore.getState()).toMatchObject({ isOpen: true, activeSurfaceId: "diff", sheet: null });
  });
});

describe("scopes", () => {
  it("name themselves stably", () => {
    expect(scopeKey(WORKING_TREE)).toBe("w");
    expect(scopeKey({ kind: "branch" })).toBe("b:");
    expect(scopeKey({ kind: "branch", baseRef: "main" })).toBe("b:main");
    expect(scopeKey({ kind: "run", runId: "r1" })).toBe("r:r1");
    expect(sameScope({ kind: "branch", baseRef: "x" }, { kind: "branch", baseRef: "x" })).toBe(true);
    expect(sameScope({ kind: "branch", baseRef: "x" }, { kind: "branch" })).toBe(false);
  });

  it("are sanitised one by one", () => {
    expect(sanitizeScope(null)).toEqual(WORKING_TREE);
    expect(sanitizeScope({ kind: "branch", baseRef: "" })).toEqual({ kind: "branch" });
    expect(sanitizeScope({ kind: "run", runId: "" })).toEqual(WORKING_TREE);
  });
});
