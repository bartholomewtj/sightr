import { describe, expect, it } from "vitest";

import {
  clusterSpaces,
  filterClusters,
  filterSpaces,
  groupedChildDisplayLabel,
  groupPanesByTab,
  isWorktreeFamily,
  shortWorktreeBranch,
  sortPanesInTab,
  spaceBranchLine,
  spaceLastSeenMap,
  spaceRowLabel,
  spaceTriageMap,
  worstBucket,
} from "./spaces";
import { worstTriage } from "./triage";
import type { AgentStatus, AgentView, TabView, WorkspaceView } from "./types";

function agent(
  partial: Partial<AgentView> & { paneId: string; workspaceId: string; tabId: string },
): AgentView {
  return {
    workspaceLabel: "ws",
    workspaceNumber: 1,
    agent: "claude",
    status: "idle",
    cwd: "/home/you/demo",
    focused: false,
    ...partial,
  };
}

const tab = (tabId: string, workspaceId: string, number: number): TabView => ({
  tabId,
  workspaceId,
  number,
  label: String(number),
  focused: false,
  paneCount: 1,
});

describe("groupPanesByTab", () => {
  const tabs = [tab("w1:t2", "w1", 2), tab("w1:t1", "w1", 1)]; // differs from stable number order

  it("preserves snapshot tab order when grouping panes", () => {
    const a1 = agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" });
    const a2 = agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t2" });
    const groups = groupPanesByTab("w1", tabs, [a1, a2], []);
    expect(groups.map((g) => g.tabId)).toEqual(["w1:t2", "w1:t1"]);
    expect(groups[0]!.panes).toEqual([a2]);
    expect(groups[1]!.panes).toEqual([a1]);
  });

  it("includes shell panes alongside agents in their tab", () => {
    const a1 = agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" });
    const shell = agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1", kind: "shell" });
    const group = groupPanesByTab("w1", tabs, [a1], [shell]).find((item) => item.tabId === "w1:t1");
    expect(group!.panes).toEqual([a1, shell]);
  });

  it("sorts tab panes with the focused pane first, then pane id", () => {
    const a1 = agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1" });
    const a2 = agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", focused: true });
    expect(sortPanesInTab([a1, a2])).toEqual([a2, a1]);
  });

  it("collects panes whose tab isn't listed yet into a trailing '…' group", () => {
    const orphan = agent({ paneId: "w1:p9", workspaceId: "w1", tabId: "w1:tX" });
    const groups = groupPanesByTab("w1", tabs, [orphan], []);
    const last = groups.at(-1)!;
    expect(last.tabId).toBe("w1:other");
    expect(last.label).toBe("…");
    expect(last.panes).toEqual([orphan]);
  });

  it("ignores panes from other workspaces", () => {
    const other = agent({ paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1" });
    const groups = groupPanesByTab("w1", tabs, [other], []);
    expect(groups.every((g) => g.panes.length === 0)).toBe(true);
  });
});

describe("worstBucket", () => {
  const mk = (id: string, ws: string, status: AgentStatus, extra: Partial<AgentView> = {}) =>
    agent({ paneId: id, workspaceId: ws, tabId: `${ws}:t1`, status, ...extra });

  it("returns null for empty pane list", () => {
    expect(worstBucket([])).toBeNull();
  });

  it("reduces a pane list to the worst bucket", () => {
    expect(worstBucket([mk("p1", "w1", "idle"), mk("p2", "w1", "blocked")])).toBe("needs");
    expect(worstBucket([mk("p1", "w1", "working"), mk("p2", "w1", "idle")])).toBe("working");
  });
});

describe("spaceTriageMap — one classifier for rows and chips", () => {
  const mk = (id: string, ws: string, status: AgentStatus, extra: Partial<AgentView> = {}) =>
    agent({ paneId: id, workspaceId: ws, tabId: `${ws}:t1`, status, ...extra });

  it("keeps the most urgent bucket per workspace and omits spaces with no agent", () => {
    const m = spaceTriageMap([
      mk("w1:p1", "w1", "idle"),
      mk("w1:p2", "w1", "blocked"),
      mk("w2:p1", "w2", "working"),
    ]);
    expect(m.get("w1")).toBe("needs");
    expect(m.get("w2")).toBe("working");
    // Not the same as idle: an empty space has nothing to report.
    expect(m.get("w3")).toBeUndefined();
  });

  it("ranks an unseen-done agent ABOVE a working one — the disagreement this replaced", () => {
    // STATUS_RANK put working (1) ahead of done (4), so the old space row said "working" while the
    // space chip, which already routed through bucketOf, said "ready". Same input, one answer now.
    const m = spaceTriageMap([
      mk("w1:p1", "w1", "working"),
      mk("w1:p2", "w1", "done", { lastActiveAt: 2000, lastSeenAt: 1000 }),
    ]);
    expect(m.get("w1")).toBe("ready");
  });

  it("agrees with worstTriage, which is the point of sharing bucketOf", () => {
    const agents = [
      mk("w1:p1", "w1", "done", { lastActiveAt: 2000, lastSeenAt: 1000 }),
      mk("w1:p2", "w1", "working"),
      mk("w1:p3", "w1", "idle"),
    ];
    expect(spaceTriageMap(agents).get("w1")).toBe(worstTriage(agents));
  });

  it("a done agent you have already seen is not 'ready'", () => {
    const m = spaceTriageMap([mk("w1:p1", "w1", "done", { lastActiveAt: 1000, lastSeenAt: 2000 })]);
    expect(m.get("w1")).toBe("recent");
  });
});

const ws = (workspaceId: string, label: string, number: number): WorkspaceView => ({
  workspaceId,
  number,
  label,
  focused: false,
  activeTabId: `${workspaceId}:t1`,
  tabCount: 1,
  paneCount: 1,
});

describe("filterSpaces", () => {
  const spaces = [ws("w1", "moonward_os", 1), ws("w2", "trader", 2), ws("w3", "MOON_probe", 3)];

  it("matches case-insensitively, anywhere in the label", () => {
    expect(filterSpaces(spaces, "moon").map((w) => w.workspaceId)).toEqual(["w1", "w3"]);
    expect(filterSpaces(spaces, "RAD").map((w) => w.workspaceId)).toEqual(["w2"]);
  });

  it("returns everything for an empty or whitespace query", () => {
    expect(filterSpaces(spaces, "")).toHaveLength(3);
    expect(filterSpaces(spaces, "   ")).toHaveLength(3);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterSpaces(spaces, "zzz")).toEqual([]);
  });
});

describe("spaceLastSeenMap", () => {
  it("agrees with spaceLastSeen for every space, in one pass", () => {
    const panes = [
      agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", lastSeenAt: 100 }),
      agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1", lastSeenAt: 900 }),
      agent({ paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1", lastSeenAt: 400 }),
    ];
    const map = spaceLastSeenMap(panes);
    expect(map.get("w1")).toBe(900);
    expect(map.get("w2")).toBe(400);
  });

  it("omits spaces with no panes, which callers read as 0", () => {
    expect(spaceLastSeenMap([]).get("w1")).toBeUndefined();
  });
});

const wt = (
  workspaceId: string,
  label: string,
  linked: boolean,
  extra: Partial<WorkspaceView> = {},
): WorkspaceView => ({
  ...ws(workspaceId, label, 1),
  worktree: {
    repoKey: "repo-sighter",
    repoName: "sighter",
    repoRoot: "/sighter",
    checkoutPath: linked ? `/sighter-${label}` : "/sighter",
    isLinkedWorktree: linked,
    branch: linked ? label : "main",
  },
  ...extra,
});

describe("clusterSpaces", () => {
  it("nests linked worktrees under the primary checkout, in snapshot order of the parent", () => {
    const child = wt("w2", "foo", true);
    const parent = wt("w1", "sighter", false);
    const other = ws("w3", "usage", 3);
    const clusters = clusterSpaces([child, parent, other]);
    expect(clusters.map((c) => c.key)).toEqual(["repo-sighter", "w3"]);
    expect(clusters[0]!.parent?.workspaceId).toBe("w1");
    expect(clusters[0]!.children.map((c) => c.workspaceId)).toEqual(["w2"]);
    expect(clusters[1]!.parent?.workspaceId).toBe("w3");
  });

  it("groups linked children with no open primary under a null parent", () => {
    const clusters = clusterSpaces([wt("w2", "foo", true), wt("w3", "bar", true)]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.parent).toBeNull();
    expect(clusters[0]!.children.map((c) => c.workspaceId)).toEqual(["w2", "w3"]);
    expect(clusters[0]!.repoName).toBe("sighter");
  });

  it("dedupes closed checkouts onto the family", () => {
    const closed = [{ path: "/wt/x", label: "x", branch: "x", isDetached: false }];
    const parent = wt("w1", "sighter", false, { closedWorktrees: closed });
    const child = wt("w2", "foo", true, { closedWorktrees: closed });
    const clusters = clusterSpaces([parent, child]);
    expect(clusters[0]!.closed).toEqual(closed);
  });
});

describe("filterClusters", () => {
  it("keeps a parent when only a child label matches", () => {
    const clusters = clusterSpaces([wt("w1", "sighter", false), wt("w2", "foo", true)]);
    const hit = filterClusters(clusters, "foo");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.parent?.label).toBe("sighter");
    expect(hit[0]!.children[0]!.label).toBe("foo");
  });
});

describe("worktree row labels", () => {
  it("strips worktree/ from branch lines", () => {
    expect(shortWorktreeBranch("worktree/issue-137")).toBe("issue-137");
    expect(shortWorktreeBranch("main")).toBe("main");
  });

  it("uses the branch for auto-named linked children", () => {
    expect(groupedChildDisplayLabel("foo", "feat/foo", "/sighter-foo")).toBe("feat/foo");
    expect(groupedChildDisplayLabel("herdr-issue", "worktree/issue-137", "/repo/herdr-issue")).toBe(
      "issue-137",
    );
  });

  it("keeps a renamed linked child label", () => {
    expect(groupedChildDisplayLabel("renamed issue", "worktree/issue-137", "/repo/x")).toBe(
      "renamed issue",
    );
  });

  it("puts branch on its own row for parents only", () => {
    const parent = wt("w1", "sighter", false);
    const child = wt("w2", "foo", true);
    expect(spaceRowLabel(parent, false)).toBe("sighter");
    expect(spaceBranchLine(parent, false)).toBe("main");
    expect(spaceRowLabel(child, true)).toBe("foo");
    expect(spaceBranchLine(child, true)).toBeNull();
  });

  it("detects worktree families for framing", () => {
    const family = clusterSpaces([wt("w1", "sighter", false), wt("w2", "foo", true)])[0]!;
    expect(isWorktreeFamily(family)).toBe(true);
    expect(isWorktreeFamily(clusterSpaces([ws("w1", "solo", 1)])[0]!)).toBe(false);
  });
});
