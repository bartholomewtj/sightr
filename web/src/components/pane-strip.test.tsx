import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PaneStrip } from "./pane-strip";
import type { AgentView } from "@/lib/types";

function pane(
  paneId: string,
  agent: string,
  kind: "agent" | "shell" = "agent",
  extra: Partial<AgentView> = {},
): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent,
    status: "idle",
    cwd: "/home/proj",
    focused: false,
    kind,
    ...extra,
  };
}

describe("PaneStrip", () => {
  it("renders nothing when the tab holds fewer than two panes", () => {
    const { container } = render(
      <PaneStrip panes={[pane("w1:p1", "claude")]} currentPaneId="w1:p1" onSelect={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every pane in the tab and marks the current one", () => {
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "grok"), pane("w1:p3", "shell", "shell")]}
        currentPaneId="w1:p2"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByText("grok")).toBeInTheDocument();
    expect(screen.getByText("proj")).toBeInTheDocument(); // bare shell: cwd basename before "shell"
    // The current pane (grok / w1:p2) is the one marked active.
    expect(screen.getByRole("button", { name: /grok/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /claude/ })).not.toHaveAttribute("aria-current");
  });

  it("shows Claude's /rename session name on a pill when no user label is set", () => {
    render(
      <PaneStrip
        panes={[
          pane("w1:p1", "claude", "agent", { sessionName: "auth-refactor" }),
          // A user label still wins over the session name.
          pane("w1:p2", "claude", "agent", { sessionName: "ignored", paneLabel: "deploy" }),
        ]}
        currentPaneId="w1:p1"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("auth-refactor")).toBeInTheDocument();
    expect(screen.getByText("deploy")).toBeInTheDocument();
    expect(screen.queryByText("ignored")).toBeNull();
  });

  it("shows Herdr's live agent name on a pill ahead of the session name", () => {
    render(
      <PaneStrip
        panes={[
          pane("w1:p1", "pi", "agent", { agentName: "planner-7dba2785", sessionName: "ignored" }),
          pane("w1:p2", "claude", "agent"),
        ]}
        currentPaneId="w1:p1"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("planner-7dba2785")).toBeInTheDocument();
    expect(screen.queryByText("ignored")).toBeNull();
  });

  it("fires onSelect with the pane id when a pane is tapped", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "grok")]}
        currentPaneId="w1:p1"
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: /grok/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p2");
  });

  // A contextmenu on a pill (Android Chrome / right-click) reaches the DOM as expected;
  // with the write actions wired it opens the actions sheet. This is the path the on-device bug broke.
  it("opens the actions sheet on contextmenu when actions are wired", () => {
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "grok")]}
        currentPaneId="w1:p1"
        onSelect={vi.fn()}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: /grok/ }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("stays inert on contextmenu when the write actions are not wired", () => {
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "grok")]}
        currentPaneId="w1:p1"
        onSelect={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: /grok/ }));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("does not open a sheet after holding a pill, and still selects on click", () => {
    vi.useFakeTimers();
    try {
      const onSelect = vi.fn();
      render(
        <PaneStrip
          panes={[pane("w1:p1", "claude"), pane("w1:p2", "grok")]}
          currentPaneId="w1:p1"
          onSelect={onSelect}
          onRenamed={vi.fn()}
          onClosed={vi.fn()}
        />,
      );
      const pill = screen.getByRole("button", { name: /grok/ });
      fireEvent.pointerDown(pill);
      vi.advanceTimersByTime(1000);
      expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
      fireEvent.click(pill);
      expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p2");
    } finally {
      vi.useRealTimers();
    }
  });

  // Tapping the already-active pill used to be a dead re-navigate (onSelect with the same id it's
  // already on). With actions wired, that tap now opens the same actions sheet — so the
  // pill is never a dead tap.
  it("opens the actions sheet on a plain tap of the ACTIVE pill when actions are wired", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "grok")]}
        currentPaneId="w1:p1"
        onSelect={onSelect}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /claude/ }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still navigates on a tap of an INACTIVE pill even when actions are wired", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "grok")]}
        currentPaneId="w1:p1"
        onSelect={onSelect}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /grok/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p2");
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("a tap of the ACTIVE pill still just re-selects (no-op) when actions are NOT wired", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "grok")]}
        currentPaneId="w1:p1"
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: /claude/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p1");
  });
});
