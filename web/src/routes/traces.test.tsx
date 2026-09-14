import { describe, expect, it } from "vitest";

import type { AgentView, PaneSssfRun, WorkspaceView } from "@/lib/types";
import { lastRunLine, liveTraceRepos, openOnRun, scopedPane, traceRows } from "./traces";

const ws = (id: string, label: string, sssf?: WorkspaceView["sssf"]): WorkspaceView => ({
  workspaceId: id,
  number: 1,
  label,
  focused: false,
  activeTabId: "t1",
  tabCount: 1,
  paneCount: 1,
  sssf,
});

describe("traceRows — the Traces list is one row per repo across every space", () => {
  it("skips spaces without traces, dedupes a repo seen under two spaces, and puts running first", () => {
    const rows = traceRows({
      workspaces: [
        ws("w0", "plain"),
        ws("w1", "home", {
          state: "ready",
          token: "t",
          repos: [
            { name: "sightr", state: "ready", running: false, lastRun: { status: "success", startedAt: "2026-08-10T10:00:00+00:00" } },
            { name: "soon", state: "pending", running: false },
            { name: "newer", state: "ready", running: false, lastRun: { status: "fail", startedAt: "2026-08-12T10:00:00+00:00" } },
          ],
        }),
        ws("w2", "lab", {
          state: "ready",
          token: "t",
          repos: [
            { name: "sightr", state: "ready", running: false }, // duplicate — first space wins
            { name: "gene", state: "ready", running: true },
          ],
          attached: { repo: "gene", adwId: "run9" },
        }),
      ],
    });
    expect(rows.map((r) => [r.repo, r.spaceLabel, r.running, r.liveAdwId])).toEqual([
      ["gene", "lab", true, "run9"],
      ["newer", "home", false, undefined], // ready rows: newest run first
      ["sightr", "home", false, undefined],
      ["soon", "home", false, undefined],
    ]);
    expect(rows[2]?.lastRun).toEqual({ status: "success", startedAt: "2026-08-10T10:00:00+00:00" });
  });

  it("names every live repo, in the same order as the list", () => {
    expect(liveTraceRepos({
      workspaces: [
        ws("w1", "home", {
          state: "ready",
          token: "t",
          repos: [
            { name: "sightr", state: "ready", running: true },
            { name: "soon", state: "pending", running: false },
          ],
        }),
        ws("w2", "lab", {
          state: "ready",
          token: "t",
          repos: [
            { name: "sightr", state: "ready", running: true },
            { name: "bench", state: "ready", running: true, lastRun: { status: "running", startedAt: "2026-08-12T10:00:00+00:00" } },
          ],
        }),
      ],
    })).toEqual(["bench", "sightr"]);
    expect(liveTraceRepos({ workspaces: [ws("w0", "plain")] })).toEqual([]);
  });
});

describe("lastRunLine — the second line says what the newest run did and when", () => {
  const now = Date.parse("2026-08-10T12:00:00+00:00");
  it("names the status and the age, or how long a live run has been going", () => {
    expect(lastRunLine({ running: false, lastRun: { status: "success", startedAt: "2026-08-10T10:00:00+00:00" } }, now)).toBe("success · 2h ago");
    expect(lastRunLine({ running: false, lastRun: { status: "fail", startedAt: "2026-08-10T11:59:50+00:00" } }, now)).toBe("fail · just now");
    expect(lastRunLine({ running: true, lastRun: { status: "running", startedAt: "2026-08-10T11:55:00+00:00" } }, now)).toBe("started 5m ago");
  });
  it("is silent for a repo with no run yet, and survives a start it cannot parse", () => {
    expect(lastRunLine({ running: false }, now)).toBeNull();
    expect(lastRunLine({ running: false, lastRun: { status: "success", startedAt: "" } }, now)).toBe("success");
  });
});

const run = (repo: string, adwId: string, status = "success"): PaneSssfRun => ({
  repo,
  adwId,
  status,
  startedAt: "2026-08-18T08:00:00+00:00",
});
const pane = (paneId: string, runs?: PaneSssfRun[]): AgentView =>
  ({ paneId, workspaceId: "w1", workspaceLabel: "home", workspaceNumber: 1, tabId: "t1", agent: "claude", status: "idle", cwd: "/x", focused: false, ...(runs ? { sssf: { runs } } : {}) }) as AgentView;

describe("a trace screen scoped to a pane", () => {
  it("finds the pane in either list, and nothing for a closed pane or no scope", () => {
    const data = { agents: [pane("w1:p1", [run("sightr", "a1")])], shellPanes: [pane("w1:p2")] };
    expect(scopedPane(data, "w1:p1")?.sssf?.runs.map((r) => r.adwId)).toEqual(["a1"]);
    expect(scopedPane(data, "w1:p2")?.paneId).toBe("w1:p2");
    expect(scopedPane(data, "w1:p9")).toBeUndefined();
    expect(scopedPane(data, undefined)).toBeUndefined();
  });

  it("opens on the pinned run, else the pane's newest run in this repo, else the live run", () => {
    const runs = [run("gene", "g2", "running"), run("sightr", "c1"), run("sightr", "c0")];
    expect(openOnRun("c0", runs, "sightr", "live")).toBe("c0");
    expect(openOnRun(undefined, runs, "sightr", "live")).toBe("c1");
    expect(openOnRun(undefined, runs, "gene", undefined)).toBe("g2");
    expect(openOnRun(undefined, runs, "other", "live")).toBe("live");
    expect(openOnRun(undefined, [], "sightr", undefined)).toBeUndefined();
  });
});
