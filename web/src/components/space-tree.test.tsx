import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

vi.mock("@/components/push-onboarding", () => ({ PushOnboarding: () => <div data-testid="push-onboarding" /> }));

import { SpaceTree } from "./space-tree";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";

function ws(id: string, label: string, partial: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    workspaceId: id,
    number: 1,
    label,
    focused: false,
    activeTabId: `${id}:t1`,
    tabCount: 1,
    paneCount: 1,
    ...partial,
  };
}

function tab(id: string, workspaceId: string, label = "tab 1", paneCount = 1): TabView {
  return {
    tabId: id,
    workspaceId,
    number: 1,
    label,
    focused: false,
    paneCount,
  };
}

function agent(
  id: string,
  workspaceId: string,
  tabId: string,
  partial: Partial<AgentView> = {},
): AgentView {
  return {
    paneId: id,
    workspaceId,
    tabId,
    workspaceLabel: "ws",
    workspaceNumber: 1,
    agent: "claude",
    status: "idle",
    cwd: "/home/you/demo",
    focused: false,
    ...partial,
  };
}

function inboxCards(inbox: HTMLElement): HTMLElement[] {
  return within(inbox)
    .getAllByRole("button")
    .filter((button) => !button.getAttribute("aria-label"));
}

function renderTree(
  props: Partial<Parameters<typeof SpaceTree>[0]> = {},
  initialPath = "/",
) {
  const treeProps: Parameters<typeof SpaceTree>[0] = {
    workspaces: [],
    tabs: [],
    agents: [],
    shellPanes: [],
    onNewSpace: vi.fn(),
    onNewTab: vi.fn(),
    onRenamed: vi.fn(),
    ...props,
  };

  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <SpaceTree {...treeProps} />,
      },
      {
        path: "/pane/:paneId",
        element: <div data-testid="pane-cli">PANE CLI</div>,
      },
      {
        path: "/traces/:spaceId/:repo",
        element: <div data-testid="trace-view">TRACE VIEW</div>,
      },
    ],
    { initialEntries: [initialPath] },
  );

  const result = render(<RouterProvider router={router} />);
  return { ...result, router, treeProps };
}

describe("SpaceTree — one-child shortcuts and tree expansion", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("one-tab/one-pane shortcut: tapping space row navigates directly to pane CLI without expanding", async () => {
    const user = userEvent.setup();
    const w = ws("w1", "my-space", { paneCount: 1, tabCount: 1 });
    const t = tab("w1:t1", "w1", "main-tab", 1);
    const p = agent("w1:p1", "w1", "w1:t1");

    const { router } = renderTree({
      workspaces: [w],
      tabs: [t],
      agents: [p],
    });

    // Space row button (tap row body, not chevron)
    const spaceBtn = screen.getByText("my-space").closest("button")!;
    await user.click(spaceBtn);

    // Navigates directly to pane CLI
    expect(router.state.location.pathname).toBe("/pane/w1%3Ap1");
  });

  it("multi-pane tab expands rather than opens: tapping a 1-tab/2-pane space expands space and tab", async () => {
    const user = userEvent.setup();
    const w = ws("w1", "my-space", { paneCount: 2, tabCount: 1 });
    const t = tab("w1:t1", "w1", "main-tab", 2);
    const p1 = agent("w1:p1", "w1", "w1:t1", { paneLabel: "pane-one" });
    const p2 = agent("w1:p2", "w1", "w1:t1", { paneLabel: "pane-two" });

    const { router } = renderTree({
      workspaces: [w],
      tabs: [t],
      agents: [p1, p2],
    });

    // Tapping the space row should expand the space and tab
    const spaceBtn = screen.getByText("my-space").closest("button")!;
    await user.click(spaceBtn);

    // Did not navigate away
    expect(router.state.location.pathname).toBe("/");

    // Both panes are now visible
    expect(await screen.findByText("pane-one")).toBeInTheDocument();
    expect(screen.getByText("pane-two")).toBeInTheDocument();

    // Tapping the tab row (multi-pane) toggles expansion
    const tabBtn = screen.getByText("main-tab").closest("button")!;
    await user.click(tabBtn);

    // Panes collapsed
    expect(screen.queryByText("pane-one")).not.toBeInTheDocument();
  });

  it("chevron tap toggles expansion and does NOT fire row action or navigation", async () => {
    const user = userEvent.setup();
    const w = ws("w1", "my-space", { paneCount: 1, tabCount: 1 });
    const t = tab("w1:t1", "w1", "main-tab", 1);
    const p = agent("w1:p1", "w1", "w1:t1");

    const { router } = renderTree({
      workspaces: [w],
      tabs: [t],
      agents: [p],
    });

    // Tap chevron button
    const chevron = screen.getByRole("button", { name: /expand space my-space/i });
    expect(chevron).toHaveClass("size-11");
    await user.click(chevron);

    // Should stay at "/" (no navigation)
    expect(router.state.location.pathname).toBe("/");

    // Space is now expanded, showing main-tab and New tab
    expect(await screen.findByRole("button", { name: /collapse space my-space/i })).toBeInTheDocument();
    expect(screen.getByText("main-tab")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New tab" })).toBeInTheDocument();
  });

  it("tab with 1 pane navigates to pane CLI on tap and shows no chevron", async () => {
    const user = userEvent.setup();
    // 2 tabs in the space so clicking the space row toggles expansion
    const w = ws("w1", "my-space", { paneCount: 2, tabCount: 2 });
    const t1 = tab("w1:t1", "w1", "tab-one", 1);
    const t2 = tab("w1:t2", "w1", "tab-two", 1);
    const p1 = agent("w1:p1", "w1", "w1:t1");
    const p2 = agent("w1:p2", "w1", "w1:t2");

    const { router } = renderTree({
      workspaces: [w],
      tabs: [t1, t2],
      agents: [p1, p2],
    });

    // Expand space
    await user.click(screen.getByText("my-space").closest("button")!);
    expect(screen.getByText("tab-one")).toBeInTheDocument();

    // No chevron for single-pane tab
    expect(screen.queryByRole("button", { name: /expand tab tab-one/i })).not.toBeInTheDocument();

    // Tapping tab-one navigates to p1
    await user.click(screen.getByText("tab-one").closest("button")!);
    expect(router.state.location.pathname).toBe("/pane/w1%3Ap1");
  });

  it("tab with 0 panes renders (empty tab) inertly", async () => {
    const user = userEvent.setup();
    const w = ws("w1", "my-space", { paneCount: 0, tabCount: 1 });
    const t1 = tab("w1:t1", "w1", "empty-tab", 0);

    const { router } = renderTree({
      workspaces: [w],
      tabs: [t1],
      agents: [],
    });

    // Expand space
    await user.click(screen.getByRole("button", { name: /expand space my-space/i }));
    expect(screen.getByText("empty-tab")).toBeInTheDocument();
    expect(screen.getByText("(empty tab)")).toBeInTheDocument();

    // Tapping empty tab is inert
    await user.click(screen.getByText("empty-tab"));
    expect(router.state.location.pathname).toBe("/");
  });

  it("New tab button fires onNewTab with workspaceId", async () => {
    const user = userEvent.setup();
    const onNewTab = vi.fn();
    const w = ws("w1", "my-space", { paneCount: 0, tabCount: 1 });
    const t1 = tab("w1:t1", "w1", "empty-tab", 0);

    renderTree({
      workspaces: [w],
      tabs: [t1],
      agents: [],
      onNewTab,
    });

    await user.click(screen.getByRole("button", { name: /expand space my-space/i }));
    await user.click(screen.getByRole("button", { name: "New tab" }));

    expect(onNewTab).toHaveBeenCalledWith("w1");
  });

  it("shows row overflow actions and clicking them opens the sheet without navigating", async () => {
    const user = userEvent.setup();
    const w = ws("w1", "my-space", { paneCount: 2, tabCount: 1 });
    const t = tab("w1:t1", "w1", "main-tab", 2);
    const p1 = agent("w1:p1", "w1", "w1:t1", { paneLabel: "pane-one" });
    const p2 = agent("w1:p2", "w1", "w1:t1", { paneLabel: "pane-two" });
    const { router } = renderTree({ workspaces: [w], tabs: [t], agents: [p1, p2] });

    expect(screen.getByRole("button", { name: "Space actions" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Space actions" }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    fireEvent.keyDown(window, { key: "Escape" });

    await user.click(screen.getByRole("button", { name: /expand space my-space/i }));
    expect(screen.getByRole("button", { name: "Tab actions" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tab actions" }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    const tabChevron = screen.getByRole("button", { name: /expand tab main-tab/i });
    expect(tabChevron).toHaveClass("size-11");
    await user.click(tabChevron);
    expect(screen.getAllByRole("button", { name: "Pane actions" })).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: "Pane actions" })[0]!);
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("SpaceTree — row ⋯ overflow", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("opens actions for a one-child space without taking its shortcut", async () => {
    const user = userEvent.setup();
    const w = ws("w1", "space", { paneCount: 1 });
    const t = tab("w1:t1", "w1", "tab", 1);
    const p = agent("w1:p1", "w1", "w1:t1");
    const { router } = renderTree({ workspaces: [w], tabs: [t], agents: [p] });

    await user.click(screen.getByRole("button", { name: "Space actions" }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("opens tab actions", async () => {
    const user = userEvent.setup();
    const w = ws("w1", "space", { paneCount: 2 });
    const t = tab("w1:t1", "w1", "tab", 2);
    const p1 = agent("w1:p1", "w1", "w1:t1");
    const p2 = agent("w1:p2", "w1", "w1:t1");
    renderTree({ workspaces: [w], tabs: [t], agents: [p1, p2] });

    await user.click(screen.getByRole("button", { name: /expand space/i }));
    await user.click(screen.getByRole("button", { name: "Tab actions" }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("opens pane actions", async () => {
    const user = userEvent.setup();
    const w = ws("w1", "space", { paneCount: 2 });
    const t = tab("w1:t1", "w1", "tab", 2);
    const p1 = agent("w1:p1", "w1", "w1:t1");
    const p2 = agent("w1:p2", "w1", "w1:t1");
    renderTree({ workspaces: [w], tabs: [t], agents: [p1, p2] });

    await user.click(screen.getByRole("button", { name: /expand space/i }));
    await user.click(screen.getByRole("button", { name: /expand tab/i }));
    await user.click(screen.getAllByRole("button", { name: "Pane actions" })[0]!);
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("keeps an empty tab name disabled while its actions remain available", async () => {
    const user = userEvent.setup();
    const w = ws("w1", "space", { paneCount: 0 });
    const t = tab("w1:t1", "w1", "empty", 0);
    renderTree({ workspaces: [w], tabs: [t], agents: [] });

    await user.click(screen.getByRole("button", { name: /expand space/i }));
    expect(screen.getByText("empty").closest("button")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Tab actions" }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("keeps the overflow button outside the row button", () => {
    const w = ws("w1", "space", { paneCount: 1 });
    renderTree({ workspaces: [w], tabs: [], agents: [] });
    const more = screen.getByRole("button", { name: "Space actions" });
    expect(more.closest("button")).toBe(more);
    expect(more.parentElement?.querySelectorAll("button")).toHaveLength(3);
  });

  it("opens inbox pane actions without navigating", async () => {
    const user = userEvent.setup();
    const p = agent("w1:p1", "w1", "w1:t1", { status: "blocked" });
    const { router } = renderTree({ agents: [p] });
    await user.click(screen.getByRole("button", { name: "Pane actions" }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("keeps space right-click actions", () => {
    const w = ws("w1", "space", { paneCount: 1 });
    renderTree({ workspaces: [w], tabs: [], agents: [] });
    fireEvent.contextMenu(screen.getByText("space").closest("button")!);
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });
});

describe("SpaceTree — triage ordering and auto-expand vs explicit collapse", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("blocked spaces render in snapshot order, show blocked state, and start expanded by default", () => {
    const wNormal = ws("w1", "normal-space", { paneCount: 1, tabCount: 1 });
    const wBlocked = ws("w2", "blocked-space", { paneCount: 1, tabCount: 1 });
    const t1 = tab("w1:t1", "w1", "tab-norm", 1);
    const t2 = tab("w2:t1", "w2", "tab-block", 1);
    const pNormal = agent("w1:p1", "w1", "w1:t1", { status: "idle", lastSeenAt: 500 });
    const pBlocked = agent("w2:p1", "w2", "w2:t1", { status: "blocked", lastSeenAt: 100 });

    renderTree({
      workspaces: [wNormal, wBlocked],
      tabs: [t1, t2],
      agents: [pNormal, pBlocked],
    });

    // Renders in snapshot order: normal-space listed first renders before blocked-space
    const normal = screen.getByText("normal-space").closest("div")!;
    const blocked = screen.getByText("blocked-space").closest("div")!;
    expect(
      normal.compareDocumentPosition(blocked) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Blocked space chevron indicates it is expanded
    expect(screen.getByRole("button", { name: /collapse space blocked-space/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand space normal-space/i })).toBeInTheDocument();

    // Blocked space starts expanded by default
    expect(screen.getByText("tab-block")).toBeInTheDocument();
    // Normal space is not expanded by default
    expect(screen.queryByText("tab-norm")).not.toBeInTheDocument();

    // Blocked state shows in place
    expect(screen.getByLabelText(/1 space needs you/i)).toBeInTheDocument();
  });

  it("explicit collapse beats the auto-expand rule and persists", async () => {
    const user = userEvent.setup();
    const wBlocked = ws("w2", "blocked-space", { paneCount: 1, tabCount: 1 });
    const t2 = tab("w2:t1", "w2", "tab-block", 1);
    const pBlocked = agent("w2:p1", "w2", "w2:t1", { status: "blocked" });

    const { unmount } = renderTree({
      workspaces: [wBlocked],
      tabs: [t2],
      agents: [pBlocked],
    });

    // Starts expanded
    expect(screen.getByText("tab-block")).toBeInTheDocument();

    // Collapse it explicitly
    await user.click(screen.getByRole("button", { name: /collapse space blocked-space/i }));
    expect(screen.queryByText("tab-block")).not.toBeInTheDocument();

    unmount();

    // Remount with a fresh snapshot — explicit collapse should win
    renderTree({
      workspaces: [wBlocked],
      tabs: [t2],
      agents: [pBlocked],
    });

    expect(screen.queryByText("tab-block")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand space blocked-space/i })).toBeInTheDocument();
  });
});

describe("SpaceTree — Ready · unseen inbox", () => {
  beforeEach(() => localStorage.clear());

  it("renders unseen done agents newest first and after Needs you", () => {
    const older = agent("w1:old", "w1", "w1:t1", { status: "done", lastActiveAt: 100, lastSeenAt: 10, paneLabel: "older" });
    const newer = agent("w1:new", "w1", "w1:t1", { status: "done", lastActiveAt: 300, lastSeenAt: 10, paneLabel: "newer" });
    const blocked = agent("w1:block", "w1", "w1:t1", { status: "blocked", paneLabel: "blocked" });
    renderTree({ agents: [older, newer, blocked] });
    expect(screen.getByTestId("push-onboarding")).toBeInTheDocument();
    expect(document.querySelector("section")?.firstElementChild).toBe(screen.getByTestId("push-onboarding"));
    expect(screen.getByTestId("needs-inbox")).toBeInTheDocument();
    const ready = screen.getByTestId("ready-inbox");
    expect(ready).toHaveTextContent("Ready · unseen");
    const cards = inboxCards(ready);
    expect(cards[0]).toHaveTextContent("newer");
    expect(cards[1]).toHaveTextContent("older");
    expect(screen.getByTestId("needs-inbox").compareDocumentPosition(ready) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides Ready · unseen when done agents have been seen", () => {
    renderTree({ agents: [agent("w1:p1", "w1", "w1:t1", { status: "done", lastActiveAt: 10, lastSeenAt: 20 })] });
    expect(screen.queryByTestId("ready-inbox")).toBeNull();
  });

  it("hides Ready · unseen on an empty herd", () => {
    renderTree({ agents: [] });
    expect(screen.queryByTestId("ready-inbox")).toBeNull();
  });

  it("navigates when a Ready card is tapped", async () => {
    const user = userEvent.setup();
    const ready = agent("w1:ready", "w1", "w1:t1", { status: "done", lastActiveAt: 200, lastSeenAt: 100, paneLabel: "ready-pane" });
    const { router } = renderTree({ agents: [ready] });
    await user.click(inboxCards(screen.getByTestId("ready-inbox"))[0]!);
    expect(router.state.location.pathname).toBe("/pane/w1%3Aready");
  });

  it("opens Pane actions from the Ready card overflow menu", async () => {
    const user = userEvent.setup();
    const ready = agent("w1:ready", "w1", "w1:t1", { status: "done", lastActiveAt: 200, lastSeenAt: 100 });
    renderTree({ agents: [ready] });
    await user.click(screen.getByRole("button", { name: "Pane actions" }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });
});

describe("SpaceTree — Needs you inbox", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows blocked agents first in the inbox, while keeping the blocked pane in the tree", () => {
    const w = ws("w1", "idle-space", { paneCount: 2, tabCount: 1 });
    const t = tab("w1:t1", "w1", "main", 2);
    const older = agent("w1:older", "w1", "w1:t1", {
      status: "blocked",
      paneLabel: "older-blocked",
      lastActiveAt: 10,
    });
    const newer = agent("w1:newer", "w1", "w1:t1", {
      status: "blocked",
      paneLabel: "newer-blocked",
      lastActiveAt: 20,
    });

    renderTree({ workspaces: [w], tabs: [t], agents: [older, newer] });

    const inbox = screen.getByTestId("needs-inbox");
    const cards = inboxCards(inbox);
    expect(cards[0]).toHaveTextContent("newer-blocked");
    expect(cards[1]).toHaveTextContent("older-blocked");
    expect(screen.getByRole("heading", { name: /needs you/i })).toBeInTheDocument();
    expect(screen.getByText("idle-space")).toBeInTheDocument();
  });

  it("omits the inbox when no agent is blocked", () => {
    renderTree({ agents: [agent("w1:p1", "w1", "w1:t1", { status: "idle" })] });

    expect(screen.queryByTestId("needs-inbox")).not.toBeInTheDocument();
  });

  it("shows a working grok agent with dialogPresent in the inbox with a 'needs you' space row", () => {
    const w = ws("w1", "grok-space");
    const t = tab("w1:t1", "w1", "main");
    const grok = agent("w1:p1", "w1", "w1:t1", {
      agent: "grok",
      status: "working",
      dialogPresent: true,
      paneLabel: "grok-ask",
    });

    renderTree({ workspaces: [w], tabs: [t], agents: [grok] });

    const inbox = screen.getByTestId("needs-inbox");
    expect(within(inbox).getByText("grok-ask")).toBeInTheDocument();

    const spaceRow = screen.getByRole("button", { name: /needs you.*grok-space/i });
    expect(within(spaceRow).getByText("needs you")).toBeInTheDocument();
  });

  it("navigates to the blocked pane when its card is clicked", async () => {
    const user = userEvent.setup();
    const p = agent("w1:p1", "w1", "w1:t1", { status: "blocked", paneLabel: "waiting-pane" });
    const { router } = renderTree({ agents: [p] });

    await user.click(inboxCards(screen.getByTestId("needs-inbox"))[0]!);

    expect(router.state.location.pathname).toBe("/pane/w1%3Ap1");
  });

  it("opens pane actions on a blocked card context menu", () => {
    const p = agent("w1:p1", "w1", "w1:t1", { status: "blocked", paneLabel: "waiting-pane" });
    renderTree({ agents: [p] });

    fireEvent.contextMenu(inboxCards(screen.getByTestId("needs-inbox"))[0]!);

    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });
});

describe("SpaceTree — traces and filter", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("does not show traces button on space rows even when sssf data is present", () => {
    const w = ws("w1", "my-space", {
      sssf: {
        state: "ready",
        token: "tok",
        repos: [{ name: "repo-a", state: "ready", running: true }],
      },
    });
    const t = tab("w1:t1", "w1", "tab 1");
    const p = agent("w1:p1", "w1", "w1:t1");

    renderTree({
      workspaces: [w],
      tabs: [t],
      agents: [p],
    });

    expect(screen.queryByRole("button", { name: /ADW runs in this space/i })).not.toBeInTheDocument();
  });

  it("does not show traces button on tab rows even when pane has sssf runs", async () => {
    const user = userEvent.setup();
    // 2 tabs so expanding space shows tab row without navigating
    const w = ws("w1", "my-space", { paneCount: 2, tabCount: 2 });
    const t1 = tab("w1:t1", "w1", "tab-one", 1);
    const t2 = tab("w1:t2", "w1", "tab-two", 1);
    const p1 = agent("w1:p1", "w1", "w1:t1", {
      sssf: {
        runs: [
          {
            repo: "repo-a",
            adwId: "adw-1",
            status: "running",
            startedAt: "2025-01-01T00:00:00Z",
          },
        ],
      },
    });
    const p2 = agent("w1:p2", "w1", "w1:t2");

    renderTree({
      workspaces: [w],
      tabs: [t1, t2],
      agents: [p1, p2],
    });

    // Expand space
    await user.click(screen.getByRole("button", { name: /expand space my-space/i }));
    expect(screen.getByText("tab-one")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /ADW runs in this tab/i })).not.toBeInTheDocument();
  });

  it("filter is hidden until header icon is tapped; typing filters spaces", async () => {
    const user = userEvent.setup();
    const w1 = ws("w1", "alpha-space");
    const w2 = ws("w2", "beta-space");

    renderTree({
      workspaces: [w1, w2],
      tabs: [],
      agents: [],
    });

    // Filter input is not shown by default
    expect(screen.queryByPlaceholderText("Filter spaces…")).not.toBeInTheDocument();

    // Filter button is in the header
    const filterBtn = screen.getByRole("button", { name: "Filter spaces" });
    expect(filterBtn).toBeInTheDocument();

    // Tap filter button to open
    await user.click(filterBtn);
    const input = screen.getByPlaceholderText("Filter spaces…");
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();

    // Type filter query
    await user.type(input, "alp");
    expect(screen.getByText("alpha-space")).toBeInTheDocument();
    expect(screen.queryByText("beta-space")).not.toBeInTheDocument();

    // Toggle button now acts as close & clear
    await user.click(screen.getByRole("button", { name: "Filter spaces" }));
    expect(screen.queryByPlaceholderText("Filter spaces…")).not.toBeInTheDocument();
    expect(screen.getByText("alpha-space")).toBeInTheDocument();
    expect(screen.getByText("beta-space")).toBeInTheDocument();
  });

  it("filter button is omitted when there is only 1 workspace", () => {
    const w = ws("w1", "only-space");

    renderTree({
      workspaces: [w],
      tabs: [],
      agents: [],
    });

    expect(screen.queryByRole("button", { name: "Filter spaces" })).not.toBeInTheDocument();
  });

  it("nests a linked worktree under its primary checkout and shows a closed sibling", () => {
    const parent = ws("w1", "sightr", {
      worktree: {
        repoKey: "repo-sightr",
        repoName: "sightr",
        repoRoot: "/sightr",
        checkoutPath: "/sightr",
        isLinkedWorktree: false,
        branch: "main",
      },
      closedWorktrees: [{ path: "/sightr-bar", label: "bar", branch: "feat/bar", isDetached: false }],
    });
    const child = ws("w2", "foo", {
      worktree: {
        repoKey: "repo-sightr",
        repoName: "sightr",
        repoRoot: "/sightr",
        checkoutPath: "/sightr-foo",
        isLinkedWorktree: true,
        branch: "feat/foo",
      },
    });
    renderTree({
      workspaces: [parent, child],
      tabs: [tab("w1:t1", "w1"), tab("w2:t1", "w2")],
      agents: [agent("w1:p1", "w1", "w1:t1"), agent("w2:p1", "w2", "w2:t1")],
    });
    expect(screen.getByRole("button", { name: "Expand space sightr" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand space foo" })).toBeInTheDocument();
    expect(screen.getByText("closed")).toBeInTheDocument();
    expect(screen.getByText("feat/bar")).toBeInTheDocument();
    expect(screen.getByText("feat/foo")).toBeInTheDocument();
  });
});

