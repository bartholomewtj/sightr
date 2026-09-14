import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { DesktopSidebar } from "@/components/desktop-sidebar";
import { tracesRepoFromPath } from "@/components/desktop-sidebar-slot";
import { __resetDesktop, setDesktop } from "@/lib/desktop";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AgentView, WorkspaceView } from "@/lib/types";
import { pickAutoOpen, TraceRoute, traceRows, TracesRoute } from "./traces";

const lastRun = { status: "success", startedAt: "2026-08-12T10:00:00+00:00" };

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

const pane = (paneId: string, runs?: AgentView["sssf"]): AgentView =>
  ({
    paneId,
    workspaceId: "w1",
    workspaceLabel: "home",
    workspaceNumber: 1,
    tabId: "t1",
    agent: "claude",
    status: "idle",
    cwd: "/x",
    focused: false,
    paneLabel: "coder",
    ...(runs ? { sssf: runs } : {}),
  }) as AgentView;

const home = (workspaces: WorkspaceView[], extra: Partial<HomeData> = {}): HomeData => ({
  bridge: "connected",
  device: undefined,
  agents: [],
  shellPanes: [],
  workspaces,
  tabs: [],
  files: false,
  error: false,
  authError: false,
  ...extra,
});

const sightrReady = {
  state: "ready" as const,
  token: "tok",
  repos: [
    { name: "paperfetch", state: "ready" as const, running: false, lastRun },
    { name: "sightr", state: "ready" as const, running: true, lastRun: { status: "running", startedAt: "2026-08-23T08:00:00+00:00" } },
    { name: "soon", state: "pending" as const, running: false },
  ],
  attached: { repo: "sightr", adwId: "run9" },
};

/** Repo rows start with the repo name; the header mark is "Sightr home". */
function repoButton(name: string) {
  return screen.getByRole("button", {
    name: (accessible) => {
      const n = accessible.toLowerCase();
      return n.startsWith(name.toLowerCase()) && !n.includes("home");
    },
  });
}

function renderTraces(data: HomeData, initial: string, desktop = true) {
  if (desktop) setDesktop(true);
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => data,
        element: (
          <>
            {desktop ? <DesktopSidebar data={data} /> : null}
            <Outlet />
          </>
        ),
        children: [
          { path: "traces", element: <TracesRoute /> },
          { path: "traces/:spaceId/:repo", element: <TraceRoute /> },
          { path: "pane/:paneId", element: <div>pane body</div> },
        ],
      },
    ],
    { initialEntries: [initial] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("desktop Traces", () => {
  beforeEach(() => __resetDesktop());
  afterEach(() => __resetDesktop());

  it("picks the running repo, else the first ready, else nothing", () => {
    const rows = traceRows({
      workspaces: [
        ws("w1", "home", {
          state: "ready",
          token: "t",
          repos: [
            { name: "soon", state: "pending", running: false },
            { name: "paperfetch", state: "ready", running: false, lastRun },
            { name: "sightr", state: "ready", running: true },
          ],
        }),
      ],
    });
    expect(pickAutoOpen(rows)?.repo).toBe("sightr");
    expect(pickAutoOpen(rows.filter((r) => !r.running))?.repo).toBe("paperfetch");
    expect(pickAutoOpen(rows.filter((r) => r.state === "pending"))).toBeUndefined();
    expect(pickAutoOpen([])).toBeUndefined();
  });

  it("reads the repo out of a traces path", () => {
    expect(tracesRepoFromPath("/traces")).toBeUndefined();
    expect(tracesRepoFromPath("/traces/w1/sightr")).toBe("sightr");
    expect(tracesRepoFromPath("/traces/w1/paper%20fetch")).toBe("paper fetch");
    expect(tracesRepoFromPath("/files")).toBeUndefined();
  });

  it("auto-opens the running repo, puts the list in the sidebar, and the iframe in main", async () => {
    const data = home([ws("w1", "home", sightrReady)]);
    const router = renderTraces(data, "/traces");
    await waitFor(() => expect(router.state.location.pathname).toBe("/traces/w1/sightr"));
    expect(router.state.location.search).toBe("");
    await waitFor(() => expect(repoButton("sightr")).toHaveAttribute("aria-current", "page"));
    expect(repoButton("paperfetch")).toBeInTheDocument();
    expect(screen.queryByLabelText("New space")).toBeNull();
    expect(screen.getByRole("button", { name: /^Traces/ })).toHaveAttribute("aria-current", "page");
    const frame = screen.getByTitle("SSSF traces — home");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("src", expect.stringContaining("repo=sightr"));
    expect(screen.queryByLabelText("Back")).toBeNull();
  });

  it("auto-opens the first ready repo when none are running", async () => {
    const data = home([
      ws("w1", "home", {
        state: "ready",
        token: "tok",
        repos: [
          { name: "soon", state: "pending", running: false },
          { name: "paperfetch", state: "ready", running: false, lastRun },
          { name: "older", state: "ready", running: false, lastRun: { status: "fail", startedAt: "2026-08-01T10:00:00+00:00" } },
        ],
      }),
    ]);
    const router = renderTraces(data, "/traces");
    await waitFor(() => expect(router.state.location.pathname).toBe("/traces/w1/paperfetch"));
    expect(screen.getByTitle("SSSF traces — home")).toHaveAttribute("src", expect.stringContaining("repo=paperfetch"));
  });

  it("stays on /traces with Pick a repo when every row is pending", async () => {
    const data = home([
      ws("w1", "home", {
        state: "pending",
        token: "tok",
        repos: [{ name: "soon", state: "pending", running: false }],
      }),
    ]);
    const router = renderTraces(data, "/traces");
    expect(await screen.findByText("Pick a repo")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/traces");
    expect(screen.queryByTitle(/SSSF traces/)).toBeNull();
    expect(repoButton("soon")).toBeDisabled();
  });

  it("stays on /traces with the empty copy when there are no repos", async () => {
    const data = home([]);
    const router = renderTraces(data, "/traces");
    expect(await screen.findByText("No SSSF traces near any space yet.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/traces");
    expect(screen.queryByTitle(/SSSF traces/)).toBeNull();
  });

  it("does not yank a repo the user already opened", async () => {
    const data = home([ws("w1", "home", sightrReady)]);
    const router = renderTraces(data, "/traces/w1/paperfetch");
    expect(await screen.findByTitle("SSSF traces — home")).toHaveAttribute("src", expect.stringContaining("repo=paperfetch"));
    expect(router.state.location.pathname).toBe("/traces/w1/paperfetch");
    await waitFor(() => expect(repoButton("paperfetch")).toHaveAttribute("aria-current", "page"));
  });

  it("keeps the space tree, run chips, and pane back on a pane-scoped trace", async () => {
    const data = home([ws("w1", "home", sightrReady)], {
      agents: [
        pane("w1:p1", {
          runs: [{ repo: "sightr", adwId: "a1", status: "success", startedAt: "2026-08-18T08:00:00+00:00" }],
        }),
      ],
    });
    const router = renderTraces(data, "/traces/w1/sightr?pane=w1:p1");
    expect(await screen.findByLabelText("New space")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "ADW runs from this pane" })).toBeInTheDocument();
    expect(screen.getByText("a1")).toBeInTheDocument();
    expect(screen.getByLabelText("Back")).toBeInTheDocument();
    expect(screen.getByTitle("SSSF traces — home")).toHaveAttribute("sandbox", "allow-scripts");
    fireEvent.click(screen.getByLabelText("Back"));
    await waitFor(() => expect(decodeURIComponent(router.state.location.pathname)).toBe("/pane/w1:p1"));
  });

  it("drops pane scope when the Traces dest is clicked and swaps the sidebar to the repo list", async () => {
    const data = home([ws("w1", "home", sightrReady)], {
      agents: [
        pane("w1:p1", {
          runs: [{ repo: "sightr", adwId: "a1", status: "success", startedAt: "2026-08-18T08:00:00+00:00" }],
        }),
      ],
    });
    const router = renderTraces(data, "/traces/w1/sightr?pane=w1:p1");
    expect(await screen.findByLabelText("New space")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Traces/ }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/traces/w1/sightr");
      expect(router.state.location.search).toBe("");
      expect(screen.queryByLabelText("New space")).toBeNull();
      expect(repoButton("sightr")).toHaveAttribute("aria-current", "page");
    });
    expect(screen.queryByRole("list", { name: "ADW runs from this pane" })).toBeNull();
    expect(screen.queryByLabelText("Back")).toBeNull();
  });

  it("phone Traces is a list hop — no auto-open, iframe after tapping a repo, back to the list", async () => {
    const data = home([ws("w1", "home", sightrReady)]);
    const router = renderTraces(data, "/traces", false);
    expect(await screen.findByRole("heading", { name: /Traces/ })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/traces");
    expect(screen.queryByTitle(/SSSF traces/)).toBeNull();
    fireEvent.click(repoButton("sightr"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/traces/w1/sightr"));
    expect(screen.getByTitle("SSSF traces — home")).toBeInTheDocument();
    expect(screen.getByLabelText("Back")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Trace repos" })).toBeNull();
  });
});
