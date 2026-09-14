import { fireEvent, render, screen, within, cleanup } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { PaneHeader } from "./pane-header";
import { __resetDesktop } from "@/lib/desktop";
import { fixtureAgents } from "@/test/handlers";
import type { AgentView } from "@/lib/types";

const working: AgentView = { ...fixtureAgents[0]!, status: "working" };

beforeEach(() => {
  localStorage.clear();
  __resetDesktop();
});
afterEach(() => {
  cleanup();
  __resetDesktop();
});

function show(overrides: Partial<ComponentProps<typeof PaneHeader>> = {}) {
  const props: ComponentProps<typeof PaneHeader> = {
    connection: { bridge: "connected", error: false, stalled: false, connecting: false },
    find: {
      open: false,
      query: "",
      count: 0,
      current: 0,
      onQueryChange: vi.fn(),
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onOpen: vi.fn(),
      onClose: vi.fn(),
    },
    pane: { paneId: working.paneId, tabLabel: "main", isShell: false, hasOutput: true },
    agent: working,
    runs: { latest: undefined, live: false },
    onBack: vi.fn(),
    onOpenSpace: vi.fn(),
    details: { statusLines: [], panes: [working], onSelectPane: vi.fn(), onSwitchPane: vi.fn() },
    ...overrides,
  };
  const router = createMemoryRouter(
    [
      { path: "/", element: <PaneHeader {...props} /> },
      { path: "/traces/:spaceId/:repo", element: <div data-testid="traces">TRACES</div> },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  return { props, router };
}

describe("PaneHeader — one line", () => {
  it("renders back, the agent logo, the title and a status dot, and nothing else", () => {
    show();
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(within(header).getByRole("img", { name: "claude logo" })).toHaveClass("size-6");
    expect(within(header).getByText("webapp › main")).toBeInTheDocument();
    expect(within(header).getByRole("img", { name: "working" })).toBeInTheDocument();
    // Gone from the row: the cwd subline, Find, Traces, and the status pill's text.
    expect(within(header).queryByText(/webapp$/)).toBeNull();
    expect(within(header).queryByText("~/webapp")).toBeNull();
    expect(within(header).queryByRole("button", { name: "Find in output" })).toBeNull();
    expect(within(header).queryByRole("button", { name: /traces/i })).toBeNull();
    expect(within(header).queryByText("working")).toBeNull();
  });

  it("prefers a user label, then the live agent name, then the session name, over space › tab", () => {
    show({ agent: { ...working, sessionName: "auth-refactor" } });
    expect(screen.getByText("auth-refactor")).toBeInTheDocument();
    cleanup();
    show({ agent: { ...working, sessionName: "auth-refactor", agentName: "planner-7dba2785" } });
    expect(screen.getByText("planner-7dba2785")).toBeInTheDocument();
    expect(screen.queryByText("auth-refactor")).toBeNull();
    cleanup();
    show({ agent: { ...working, sessionName: "auth-refactor", agentName: "planner-7dba2785", paneLabel: "deploy" } });
    expect(screen.getByText("deploy")).toBeInTheDocument();
    expect(screen.queryByText("planner-7dba2785")).toBeNull();
  });

  it("labels the status dot with the status text and dims it while connecting", () => {
    show({ agent: { ...working, status: "blocked" } });
    const dot = screen.getByRole("img", { name: "needs you" });
    expect(dot).toHaveAttribute("title", "needs you");
    expect(dot).not.toHaveClass("opacity-40");
    cleanup();
    show({
      agent: { ...working, status: "blocked" },
      connection: { bridge: "connected", error: true, stalled: false, connecting: true },
    });
    expect(screen.getByRole("img", { name: "needs you" })).toHaveClass("opacity-40");
  });

  it("shows the muted shell tag instead of a dot for a bare shell pane", () => {
    const shell: AgentView = { ...working, kind: "shell", agent: "shell", status: "unknown" };
    show({ agent: shell, pane: { paneId: shell.paneId, isShell: true, hasOutput: true } });
    expect(screen.getByText("shell")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "unknown" })).toBeNull();
  });

  it("says (agent gone) with no title button when the pane has vanished", () => {
    show({ agent: undefined });
    expect(screen.getByText("(agent gone)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pane details" })).toBeNull();
  });
});

describe("PaneHeader — title opens the details sheet", () => {
  it("opens on tap, with the cwd and the space overview row, and closes", () => {
    const { props } = show();
    const title = screen.getByRole("button", { name: "Pane details" });
    expect(title).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(title);
    const sheet = screen.getByRole("dialog", { name: "Pane details" });
    expect(screen.getByRole("button", { name: "Pane details" })).toHaveAttribute("aria-expanded", "true");
    expect(within(sheet).getByText("/home/you/webapp")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Open space overview" }));
    expect(props.onOpenSpace).toHaveBeenCalledExactlyOnceWith("w1");
    expect(screen.queryByRole("dialog", { name: "Pane details" })).toBeNull();
  });

  it("opens on a swipe up across the title too", () => {
    show();
    const title = screen.getByRole("button", { name: "Pane details" });
    fireEvent.touchStart(title, { touches: [{ clientX: 100, clientY: 40 }] });
    fireEvent.touchEnd(title, { changedTouches: [{ clientX: 102, clientY: 0 }] });
    expect(screen.getByRole("dialog", { name: "Pane details" })).toBeInTheDocument();
  });

  it("ignores a sideways drag on the title", () => {
    show();
    const title = screen.getByRole("button", { name: "Pane details" });
    fireEvent.touchStart(title, { touches: [{ clientX: 0, clientY: 40 }] });
    fireEvent.touchEnd(title, { changedTouches: [{ clientX: 120, clientY: 30 }] });
    expect(screen.queryByRole("dialog", { name: "Pane details" })).toBeNull();
  });

  it("Find in output in the sheet opens the find bar, which takes over the header row", () => {
    const { props } = show();
    fireEvent.click(screen.getByRole("button", { name: "Pane details" }));
    fireEvent.click(screen.getByRole("button", { name: "Find in output" }));
    expect(props.find.onOpen).toHaveBeenCalledOnce();
    cleanup();
    show({ find: { ...props.find, open: true } });
    expect(screen.getByRole("textbox")).toBeInTheDocument(); // the find bar's input
    expect(screen.queryByRole("button", { name: "Pane details" })).toBeNull();
  });

  it("Traces navigates to the pane-scoped trace page", () => {
    const { router } = show({
      runs: { latest: { repo: "sightr", adwId: "ab12cd34", status: "running", startedAt: "2026-08-18T08:00:00Z" }, live: true },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pane details" }));
    fireEvent.click(screen.getByRole("button", { name: /^Traces.*running$/ }));
    expect(router.state.location.pathname).toBe("/traces/w1/sightr");
    expect(router.state.location.search).toContain("pane=w1%3Ap1");
  });
});
