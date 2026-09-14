import { describe, expect, test } from "bun:test";

import {
  closeWorkspace,
  openWorktree,
  removeWorktree,
} from "./tree-routes.ts";
import type { HerdrClient } from "./herdr-client.ts";

function jsonReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("closeWorkspace", () => {
  test("posts close_group when asked and returns ok", async () => {
    const calls: Array<{ id: string; group?: boolean }> = [];
    const herdr = {
      closeWorkspace: async (id: string, opts: { closeGroup?: boolean } = {}) => {
        calls.push({ id, group: opts.closeGroup });
      },
    } as unknown as HerdrClient;
    const res = await closeWorkspace(herdr, "w1", jsonReq("http://x/api/workspace/w1/close", { closeGroup: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ id: "w1", group: true }]);
  });

  test("maps workspace_group_close_required", async () => {
    const herdr = {
      closeWorkspace: async () => {
        throw new Error("herdr workspace.close: workspace_group_close_required: group is open");
      },
    } as unknown as HerdrClient;
    const res = await closeWorkspace(herdr, "w1", jsonReq("http://x/api/workspace/w1/close", {}));
    expect(await res.json()).toEqual({
      ok: false,
      error: "close the worktree group",
      code: "workspace_group_close_required",
    });
  });
});

describe("removeWorktree", () => {
  test("maps a dirty checkout to worktree_dirty", async () => {
    const herdr = {
      removeWorktree: async () => {
        throw new Error("herdr worktree.remove: failed: use --force to delete it");
      },
    } as unknown as HerdrClient;
    const res = await removeWorktree(herdr, "w2", jsonReq("http://x/api/workspace/w2/worktree/remove", {}));
    expect(await res.json()).toEqual({ ok: false, error: "checkout is dirty", code: "worktree_dirty" });
  });

  test("forwards force", async () => {
    const calls: Array<{ id: string; force?: boolean }> = [];
    const herdr = {
      removeWorktree: async (id: string, opts: { force?: boolean } = {}) => {
        calls.push({ id, force: opts.force });
      },
    } as unknown as HerdrClient;
    const res = await removeWorktree(herdr, "w2", jsonReq("http://x/api/workspace/w2/worktree/remove", { force: true }));
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ id: "w2", force: true }]);
  });
});

describe("openWorktree", () => {
  test("returns the new shell pane", async () => {
    const herdr = {
      openWorktree: async () => ({
        paneId: "w9:p1",
        workspaceId: "w9",
        workspaceLabel: "foo",
        tabId: "w9:t1",
        cwd: "C:/wt/foo",
      }),
    } as unknown as HerdrClient;
    const res = await openWorktree(
      herdr,
      jsonReq("http://x/api/worktree/open", { workspaceId: "w1", path: "C:/wt/foo" }),
    );
    expect(await res.json()).toEqual({
      ok: true,
      pane: {
        paneId: "w9:p1",
        workspaceId: "w9",
        workspaceLabel: "foo",
        tabId: "w9:t1",
        cwd: "C:/wt/foo",
      },
    });
  });

  test("400s without a target", async () => {
    const herdr = {} as HerdrClient;
    const res = await openWorktree(herdr, jsonReq("http://x/api/worktree/open", { path: "/x" }));
    expect(await res.json()).toEqual({ ok: false, error: "workspaceId or cwd required" });
  });
});
