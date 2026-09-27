import { render, screen } from "@testing-library/react";
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

  it("a tap of the open pane is a no-op", async () => {
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
    expect(onSelect).not.toHaveBeenCalled();
  });
});
