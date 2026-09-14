import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { herdrErrorCode } from "./herdr-client.ts";
import {
  createWorktreeIndex,
  findGitRoot,
  normPath,
  pathContains,
  type WorktreeLister,
} from "./worktrees.ts";
import type { WorkspaceView } from "../shared/wire.ts";
import type { WorktreeList } from "./herdr-client.ts";

function ws(id: string, label: string, extra: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: id,
    number: 1,
    label,
    focused: false,
    activeTabId: `${id}:t1`,
    tabCount: 1,
    paneCount: 1,
    ...extra,
  };
}

function listed(overrides: Partial<WorktreeList> = {}): WorktreeList {
  return {
    source: {
      repo_key: "repo-sightr",
      repo_name: "sightr",
      repo_root: "C:/Users/alice/Projects/the-bridge",
      source_checkout_path: "C:/Users/alice/Projects/the-bridge",
    },
    worktrees: [
      {
        path: "C:/Users/alice/Projects/the-bridge",
        label: "sightr",
        branch: "main",
        is_bare: false,
        is_detached: false,
        is_prunable: false,
        is_linked_worktree: false,
        open_workspace_id: "w1",
      },
      {
        path: "C:/work-dir/Projects/bench-wt-foo",
        label: "foo",
        branch: "feat/foo",
        is_bare: false,
        is_detached: false,
        is_prunable: false,
        is_linked_worktree: true,
        open_workspace_id: "w2",
      },
      {
        path: "C:/work-dir/Projects/bench-wt-bar",
        label: "bar",
        branch: "feat/bar",
        is_bare: false,
        is_detached: false,
        is_prunable: false,
        is_linked_worktree: true,
        open_workspace_id: null,
      },
    ],
    ...overrides,
  };
}

describe("herdrErrorCode", () => {
  test("pulls the code out of a herdr throw", () => {
    expect(herdrErrorCode(new Error("herdr workspace.close: workspace_group_close_required: group is open")))
      .toBe("workspace_group_close_required");
  });
  test("undefined when the message is not a herdr error", () => {
    expect(herdrErrorCode(new Error("boom"))).toBeUndefined();
  });
});

describe("normPath / pathContains", () => {
  test("slash-normalizes and matches a cwd inside a checkout", () => {
    expect(pathContains("C:/repo", "C:/repo/web/src")).toBe(true);
    expect(pathContains("C:/repo", "C:/other")).toBe(false);
  });
});

describe("findGitRoot", () => {
  test("walks up to a .git dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-wt-"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "web", "src"), { recursive: true });
    expect(await findGitRoot(join(root, "web", "src"))).toBe(root);
  });
  test("accepts a .git file (linked worktree)", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-wt-"));
    await writeFile(join(root, ".git"), "gitdir: elsewhere");
    expect(await findGitRoot(root)).toBe(root);
  });
  test("returns null when nothing above has .git", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-wt-plain-"));
    expect(await findGitRoot(root)).toBeNull();
  });
});

describe("createWorktreeIndex", () => {
  async function gitDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "sightr-wt-idx-"));
    await mkdir(join(root, ".git"));
    return root;
  }

  test("stamps branch, linked flag, and closed siblings from worktree.list", async () => {
    const root = await gitDir();
    const child = join(root, "wt-foo");
    const closed = join(root, "wt-bar");
    const calls: string[] = [];
    const herdr: WorktreeLister = {
      listWorktrees: async ({ cwd }) => {
        calls.push(cwd ?? "");
        return listed({
          source: {
            repo_key: "repo-sightr",
            repo_name: "sightr",
            repo_root: root,
            source_checkout_path: root,
          },
          worktrees: [
            {
              path: root,
              label: "sightr",
              branch: "main",
              is_bare: false,
              is_detached: false,
              is_prunable: false,
              is_linked_worktree: false,
              open_workspace_id: "w1",
            },
            {
              path: child,
              label: "foo",
              branch: "feat/foo",
              is_bare: false,
              is_detached: false,
              is_prunable: false,
              is_linked_worktree: true,
              open_workspace_id: "w2",
            },
            {
              path: closed,
              label: "bar",
              branch: "feat/bar",
              is_bare: false,
              is_detached: false,
              is_prunable: false,
              is_linked_worktree: true,
              open_workspace_id: null,
            },
          ],
        });
      },
    };
    const index = createWorktreeIndex(herdr);
    const out = await index.decorate(
      [ws("w1", "sightr"), ws("w2", "foo")],
      [
        { workspaceId: "w1", cwd: root },
        { workspaceId: "w2", cwd: child },
      ],
    );
    expect(out[0]!.worktree).toMatchObject({
      repoKey: "repo-sightr",
      repoName: "sightr",
      isLinkedWorktree: false,
      branch: "main",
    });
    expect(out[1]!.worktree?.isLinkedWorktree).toBe(true);
    expect(out[1]!.worktree?.branch).toBe("feat/foo");
    expect(out[0]!.closedWorktrees?.map((c) => c.label)).toEqual(["bar"]);
    expect(calls).toHaveLength(1);
  });

  test("skips the RPC when the cwd is not a git checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "sightr-wt-plain-"));
    let listedN = 0;
    const index = createWorktreeIndex({
      listWorktrees: async () => {
        listedN += 1;
        return listed();
      },
    });
    const out = await index.decorate([ws("w1", "usage")], [{ workspaceId: "w1", cwd: root }]);
    expect(listedN).toBe(0);
    expect(out[0]!.worktree).toBeUndefined();
  });

  test("treats not_git_worktree as a miss, not a throw", async () => {
    const root = await gitDir();
    const index = createWorktreeIndex({
      listWorktrees: async () => {
        throw new Error("herdr worktree.list: not_git_worktree: not a git worktree");
      },
    });
    const out = await index.decorate([ws("w1", "x")], [{ workspaceId: "w1", cwd: root }]);
    expect(out[0]!.worktree).toBeUndefined();
  });

  test("invalidate drops the cache so the next decorate re-lists", async () => {
    const root = await gitDir();
    let n = 0;
    const index = createWorktreeIndex({
      listWorktrees: async () => {
        n += 1;
        return listed();
      },
    });
    const panes = [{ workspaceId: "w1", cwd: root }];
    await index.decorate([ws("w1", "sightr")], panes);
    await index.decorate([ws("w1", "sightr")], panes);
    expect(n).toBe(1);
    index.invalidate();
    await index.decorate([ws("w1", "sightr")], panes);
    expect(n).toBe(2);
  });
});

void normPath;
