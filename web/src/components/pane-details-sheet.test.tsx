import { fireEvent, render, screen, within, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PaneDetailsSheet } from "./pane-details-sheet";
import { __resetDesktop, setDesktop } from "@/lib/desktop";
import { fixtureAgents } from "@/test/handlers";
import type { AgentView } from "@/lib/types";
import type { StyledLine } from "@/lib/blocks";

const agent = fixtureAgents[0]!; // claude @ /home/you/webapp, blocked
const sibling: AgentView = { ...agent, paneId: "w1:p2", agent: "grok", status: "idle" };
const seg = (text: string) => ({ text, style: {}, muted: false });
const statusLines: StyledLine[] = [
  { segments: [seg("[Opus 4.8] ~/webapp"), seg(" main")] },
  { segments: [seg("← for agents")] },
];

beforeEach(() => {
  localStorage.clear();
  __resetDesktop();
});
afterEach(() => {
  cleanup();
  __resetDesktop();
});

function show(overrides: Partial<Parameters<typeof PaneDetailsSheet>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    anchor: null,
    agent,
    statusLines,
    panes: [agent, sibling],
    currentPaneId: agent.paneId,
    onSelectPane: vi.fn(),
    onOpenSpace: vi.fn(),
    find: { available: true, onOpen: vi.fn() },
    traces: { available: true, live: false, onOpen: vi.fn() },
    onSwitchPane: vi.fn(),
    ...overrides,
  };
  render(<PaneDetailsSheet {...props} />);
  return props;
}

describe("PaneDetailsSheet", () => {
  it("renders nothing while closed", () => {
    show({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the full working directory in mono, wrapping allowed", () => {
    show();
    const cwd = within(screen.getByRole("dialog", { name: "Pane details" })).getByText("/home/you/webapp");
    expect(cwd).toHaveClass("font-mono", "break-all");
  });

  it("shows the agent statusline rows as text nodes, one row per line", () => {
    show();
    const first = screen.getByText("[Opus 4.8] ~/webapp");
    const second = screen.getByText("← for agents");
    expect(first.closest("pre")).toBeNull();
    const row = (el: HTMLElement) => el.closest("div.truncate");
    expect(row(second)).not.toBe(row(first));
    expect(row(second)?.parentElement).toBe(row(first)?.parentElement);
    // One <span> per ANSI segment, text nodes only — the same XSS boundary as the mirror.
    expect(screen.getByText("main").tagName).toBe("SPAN");
    expect(row(screen.getByText("main"))).toBe(row(first));
  });

  it("omits the statusline block when there are no lines", () => {
    show({ statusLines: [] });
    expect(screen.queryByText("[Opus 4.8] ~/webapp")).toBeNull();
  });

  it("lists the tab's panes as rows and switches on a tap, closing the sheet", () => {
    const { onSelectPane, onClose } = show();
    expect(screen.getByText("Panes")).toBeInTheDocument();
    const claude = screen.getByRole("button", { name: /claude/ });
    expect(claude).toHaveAttribute("aria-current", "true");
    expect(claude).toHaveClass("w-full");
    fireEvent.click(screen.getByRole("button", { name: /grok/ }));
    expect(onSelectPane).toHaveBeenCalledExactlyOnceWith("w1:p2");
    expect(onClose).toHaveBeenCalled();
  });

  it("hides the pane list when the tab holds a single pane", () => {
    show({ panes: [agent] });
    expect(screen.queryByText("Panes")).toBeNull();
  });

  it("opens the pane actions (rename / close) from a row's context menu when wired", () => {
    show({ onRenamed: vi.fn(), onClosed: vi.fn() });
    fireEvent.contextMenu(screen.getByRole("button", { name: /grok/ }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close pane" })).toBeInTheDocument();
  });

  it("shows Context with the fill level when the statusline painted ctx:N%", () => {
    const { onContext, onClose } = show({
      statusLines: [{ segments: [seg("[Opus 4.8] ~/webapp ctx:33% main")] }],
      onContext: vi.fn(),
    });
    const row = screen.getByRole("button", { name: /Context/ });
    expect(row).toHaveTextContent("33%");
    fireEvent.click(row);
    expect(onContext).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });

  it("offers Context without a fill level when only the /context action is wired", () => {
    const { onContext } = show({ statusLines: [], onContext: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    expect(onContext).toHaveBeenCalledOnce();
  });

  it("hides Context when there is no fill level and no action", () => {
    show({ statusLines: [], onContext: undefined });
    expect(screen.queryByText("Context")).toBeNull();
  });

  it("shows a non-button Context readout when there is a fill level and no action", () => {
    show({ statusLines: [{ segments: [seg("ctx:33%")] }] });
    expect(screen.queryByRole("button", { name: /Context/ })).toBeNull();
    expect(screen.getByText("Context")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
  });

  it("shows Grok's header used/window count from the dump when the statusline has none", () => {
    const { onContext } = show({
      statusLines: [{ segments: [seg("Grok 4.6 (high) · always-approve")] }],
      dumpText: "/tmp/sandbox                    20K / 500K",
      onContext: vi.fn(),
    });
    const row = screen.getByRole("button", { name: /Context/ });
    expect(row).toHaveTextContent("20K/500K");
    fireEvent.click(row);
    expect(onContext).toHaveBeenCalledOnce();
  });

  it("prefers ctx:N% over a dump used/window count", () => {
    show({
      statusLines: [{ segments: [seg("[Opus 4.8] ~/webapp ctx:33% main")] }],
      dumpText: "20K / 500K",
      onContext: vi.fn(),
    });
    expect(screen.getByRole("button", { name: /Context/ })).toHaveTextContent("33%");
    expect(screen.queryByText("20K/500K")).toBeNull();
  });

  it("shows Pi's footer fill/window count from the dump", () => {
    show({
      statusLines: [],
      dumpText: "↑1.5k ↓3.4k 4.1%/200k (auto)  muse-spark-1.3 • medium",
      onContext: vi.fn(),
    });
    expect(screen.getByRole("button", { name: /Context/ })).toHaveTextContent("4.1%/200k");
  });

  it("Open space overview fires the action and closes", () => {
    const { onOpenSpace, onClose } = show();
    fireEvent.click(screen.getByRole("button", { name: "Open space overview" }));
    expect(onOpenSpace).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });

  it("offers Find in output only when there is output, and opens the find bar", () => {
    const { find, onClose } = show();
    fireEvent.click(screen.getByRole("button", { name: "Find in output" }));
    expect(find.onOpen).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
    cleanup();
    show({ find: { available: false, onOpen: vi.fn() } });
    expect(screen.queryByRole("button", { name: "Find in output" })).toBeNull();
  });

  it("offers Traces only when the pane has ADW runs, marked running while one is live", () => {
    const { traces } = show();
    const row = screen.getByRole("button", { name: "Traces" });
    expect(within(row).queryByText("running")).toBeNull();
    fireEvent.click(row);
    expect(traces.onOpen).toHaveBeenCalledOnce();
    cleanup();
    show({ traces: { available: true, live: true, onOpen: vi.fn() } });
    expect(screen.getByRole("button", { name: /^Traces.*running$/ })).toBeInTheDocument();
    cleanup();
    show({ traces: { available: false, live: false, onOpen: vi.fn() } });
    expect(screen.queryByRole("button", { name: /^Traces/ })).toBeNull();
  });

  it("puts Switch pane… last and drops it when no switcher is wired", () => {
    const { onSwitchPane } = show();
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons[buttons.length - 1]).toBe("Switch pane…");
    fireEvent.click(screen.getByRole("button", { name: "Switch pane…" }));
    expect(onSwitchPane).toHaveBeenCalledOnce();
    cleanup();
    show({ onSwitchPane: undefined });
    expect(screen.queryByRole("button", { name: "Switch pane…" })).toBeNull();
  });

  it("closes from the sheet's Close button and on Escape", () => {
    const { onClose } = show();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("is a popover on desktop with the same rows", () => {
    setDesktop(true);
    show();
    const popover = screen.getByRole("dialog", { name: "Pane details" });
    expect(popover).toHaveAttribute("data-testid", "action-popover");
    expect(within(popover).getByText("/home/you/webapp")).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: "Open space overview" })).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: "Find in output" })).toBeInTheDocument();
  });
});
