import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { NO_CAPABILITIES } from "@shared/v2/contracts";
import { setPanelLeaveGuard } from "@/components/right-panel/leaveGuard";
import { PanelToolbar } from "@/components/shell/PanelToolbar";
import { SidebarToggle } from "@/components/shell/SidebarToggle";
import { useRightPanelStore } from "@/rightPanelStore";
import { useThreadStore } from "@/stream/stores";
import { useUiState } from "@/uiStateStore";
import { useDraftThread } from "@/state/draft-thread";
import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot, thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));
const region = (name: string) => document.querySelector(`[data-region="${name}"]`);

beforeEach(() => {
  useThreadStore.setState({ current: null, missing: null });
  setPanelLeaveGuard(null);
  server.use(
    http.get("/api/pane/:id", () =>
      HttpResponse.json({ paneId: "p-t1", text: "$ mirror\n", truncated: false, revision: 1 }),
    ),
  );
  useRightPanelStore.setState({
    isOpen: true,
    activeSurfaceId: "terminal",
    sheet: null,
  });
});

describe("PanelToolbar unit", () => {
  it("renders buttons in normal flow (not absolute) and in RIGHT_PANEL_KINDS order", () => {
    setViewportWidth(1280);
    render(<PanelToolbar />);
    const group = screen.getByRole("group", { name: "Right panel" });
    expect(group.classList.contains("absolute")).toBe(false);

    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Terminal", "Files", "Git", "Diff"]);
    for (const b of buttons) {
      expect(b.classList.contains("absolute")).toBe(false);
    }
  });

  it("includes shortcuts in titles where defined", () => {
    setViewportWidth(1280);
    render(<PanelToolbar />);
    const group = screen.getByRole("group", { name: "Right panel" });
    const terminal = within(group).getByRole("button", { name: "Terminal" });
    const diff = within(group).getByRole("button", { name: "Diff" });

    expect(terminal.getAttribute("title")).toContain("Ctrl+J");
    expect(diff.getAttribute("title")).toContain("Ctrl+D");
  });

  it("desktop buttons have id and aria-controls pointing to right-panel-surface", () => {
    setViewportWidth(1280);
    render(<PanelToolbar />);
    const group = screen.getByRole("group", { name: "Right panel" });
    const buttons = within(group).getAllByRole("button");

    expect(buttons[0]).toHaveAttribute("id", "panel-toolbar-tab-terminal");
    expect(buttons[0]).toHaveAttribute("aria-controls", "right-panel-surface");
    expect(buttons[1]).toHaveAttribute("id", "panel-toolbar-tab-files");
    expect(buttons[1]).toHaveAttribute("aria-controls", "right-panel-surface");
    expect(buttons[2]).toHaveAttribute("id", "panel-toolbar-tab-git");
    expect(buttons[2]).toHaveAttribute("aria-controls", "right-panel-surface");
    expect(buttons[3]).toHaveAttribute("id", "panel-toolbar-tab-diff");
    expect(buttons[3]).toHaveAttribute("aria-controls", "right-panel-surface");
  });

  it("desktop: clicking an inactive tab opens the panel to that tab", () => {
    setViewportWidth(1280);
    useRightPanelStore.setState({ isOpen: false, activeSurfaceId: "terminal" });
    render(<PanelToolbar />);
    const group = screen.getByRole("group", { name: "Right panel" });
    const files = within(group).getByRole("button", { name: "Files" });

    expect(files).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(files);
    expect(useRightPanelStore.getState().isOpen).toBe(true);
    expect(useRightPanelStore.getState().activeSurfaceId).toBe("files");
  });

  it("desktop: clicking the active tab while panel is open closes the panel", () => {
    setViewportWidth(1280);
    useRightPanelStore.setState({ isOpen: true, activeSurfaceId: "terminal" });
    render(<PanelToolbar />);
    const group = screen.getByRole("group", { name: "Right panel" });
    const terminal = within(group).getByRole("button", { name: "Terminal" });

    expect(terminal).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(terminal);
    expect(useRightPanelStore.getState().isOpen).toBe(false);
  });

  it("desktop: respects guardPanelLeave before switching or closing", () => {
    setViewportWidth(1280);
    useRightPanelStore.setState({ isOpen: true, activeSurfaceId: "terminal" });
    let blockedGo: (() => void) | null = null;
    setPanelLeaveGuard((go) => {
      blockedGo = go;
      return true; // prevent immediate navigation
    });

    render(<PanelToolbar />);
    const group = screen.getByRole("group", { name: "Right panel" });
    fireEvent.click(within(group).getByRole("button", { name: "Files" }));

    // Should not have switched yet
    expect(useRightPanelStore.getState().activeSurfaceId).toBe("terminal");
    expect(blockedGo).not.toBeNull();

    // Now resume
    act(() => blockedGo!());
    expect(useRightPanelStore.getState().activeSurfaceId).toBe("files");
  });

  it("phone: renders Thread tools group and opens/closes sheets", () => {
    setViewportWidth(390);
    render(<PanelToolbar />);
    const group = screen.getByRole("group", { name: "Thread tools" });
    const files = within(group).getByRole("button", { name: "Files" });

    expect(files).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(files);
    expect(useRightPanelStore.getState().sheet).toBe("files");

    // Clicking active sheet button closes it
    fireEvent.click(files);
    expect(useRightPanelStore.getState().sheet).toBeNull();
  });

  it("phone with cli=true omits Terminal button", () => {
    setViewportWidth(390);
    render(<PanelToolbar cli={true} />);
    const group = screen.getByRole("group", { name: "Thread tools" });
    expect(within(group).queryByRole("button", { name: "Terminal" })).toBeNull();
    expect(within(group).getByRole("button", { name: "Files" })).toBeInTheDocument();
  });
});

describe("SidebarToggle unit", () => {
  it("renders in-flow button and opens sidebar on click", () => {
    useUiState.setState({ sidebarOpen: false });
    render(<SidebarToggle />);
    const button = screen.getByRole("button", { name: "Show the sidebar" });
    expect(button.classList.contains("absolute")).toBe(false);

    fireEvent.click(button);
    expect(useUiState.getState().sidebarOpen).toBe(true);
  });
});

async function bootThread(width: number) {
  setViewportWidth(width);
  const app = renderApp("/v2/thread/t1");
  await waitFor(() => expect(shellSource()).toBeDefined());
  frame(() =>
    shellSource()?.emit(
      "snapshot",
      shellSnapshot(5, [thread("t1", { title: "Test Overlap", capabilities: { ...NO_CAPABILITIES, hasJournal: true } })]),
    ),
  );
  await screen.findByRole("heading", { name: "Test Overlap" });
  return app;
}

describe("Responsive header and overlap checks", () => {
  const widths = [360, 768, 1024, 1440];

  for (const width of widths) {
    it(`thread header has no overlapping floating buttons at ${width}px`, async () => {
      await bootThread(width);
      const isDesktop = width >= 1024;

      // Assert ChatShell has no absolute floating buttons
      const mainChat = region("chat") as HTMLElement;
      expect(mainChat.querySelector(":scope > button.absolute")).toBeNull();

      // Find in thread is reachable and in flow on desktop
      if (isDesktop) {
        const findButton = screen.getByRole("button", { name: "Find in thread" });
        expect(findButton).toBeInTheDocument();
        expect(findButton.classList.contains("absolute")).toBe(false);

        // Click find button to open TimelineFind
        fireEvent.click(findButton);
        const findBar = await screen.findByRole("search", { name: "Find in thread" });
        expect(findBar).toBeInTheDocument();

        // Find bar is contained inside timeline region below header
        const timeline = region("timeline") as HTMLElement;
        expect(timeline).toContainElement(findBar);
        expect(timeline.className).toContain("overflow-hidden");

        // Close find
        fireEvent.click(screen.getByRole("button", { name: "Close find" }));
        await waitFor(() => expect(screen.queryByRole("search", { name: "Find in thread" })).toBeNull());
      }

      // Panel toolbar is in flow and clickable
      const toolbarGroup = isDesktop
        ? screen.getByRole("group", { name: "Right panel" })
        : screen.getByRole("group", { name: "Thread tools" });
      expect(toolbarGroup).toBeInTheDocument();
      expect(toolbarGroup.classList.contains("absolute")).toBe(false);

      const filesButton = within(toolbarGroup).getByRole("button", { name: "Files" });
      fireEvent.click(filesButton);
      if (isDesktop) {
        expect(useRightPanelStore.getState().activeSurfaceId).toBe("files");
        expect(useRightPanelStore.getState().isOpen).toBe(true);
      } else {
        expect(useRightPanelStore.getState().sheet).toBe("files");
      }
    });

    it(`new-thread header keeps Discard reachable without overlap at ${width}px`, async () => {
      setViewportWidth(width);
      renderApp("/v2/new");
      await waitFor(() => expect(shellSource()).toBeDefined());
      frame(() => shellSource()?.emit("snapshot", shellSnapshot(5, [])));
      await screen.findByRole("heading", { name: "New thread" });

      // Discard button is visible and in flow
      const discard = screen.getByRole("button", { name: "Discard" });
      expect(discard).toBeInTheDocument();
      expect(discard.classList.contains("absolute")).toBe(false);

      // Verify no floating button inside main chat
      const mainChat = region("chat") as HTMLElement;
      expect(mainChat.querySelector(":scope > button.absolute")).toBeNull();

      // On screens with no thread, panel toolbar is not rendered
      expect(screen.queryByRole("group", { name: "Right panel" })).toBeNull();
      expect(screen.queryByRole("group", { name: "Thread tools" })).toBeNull();

      // Set some draft text, click Discard, verify draft is reset
      act(() => {
        useDraftThread.setState({
          draft: { ...useDraftThread.getState().draft, text: "draft message" },
        });
      });
      expect(useDraftThread.getState().draft.text).toBe("draft message");
      fireEvent.click(discard);
      expect(useDraftThread.getState().draft.text).toBe("");
    });
  }
});

describe("Header toolbar and right panel layout", () => {
  it("panel open shows exactly one set of four panel-kind buttons in the page (header), and panel has close button", async () => {
    await bootThread(1280);
    useRightPanelStore.setState({ isOpen: true, activeSurfaceId: "terminal" });
    const panel = region("right-panel") as HTMLElement;
    expect(panel).toBeInTheDocument();

    // Exactly one set of four panel-kind buttons in the page
    for (const name of ["Terminal", "Files", "Git", "Diff"]) {
      const buttons = screen.getAllByRole("button", { name });
      expect(buttons).toHaveLength(1);
      expect(buttons[0]?.closest('[role="group"]')?.getAttribute("aria-label")).toBe("Right panel");
    }

    // Panel has no tabs
    expect(within(panel).queryAllByRole("tab")).toHaveLength(0);

    // Panel still has its close button
    const closeBtn = within(panel).getByRole("button", { name: "Close the right panel" });
    expect(closeBtn).toBeInTheDocument();

    // Check panel semantics: role="tabpanel" and aria-labelledby points to the active header button
    const surface = panel.querySelector("#right-panel-surface");
    expect(surface).toHaveAttribute("role", "tabpanel");
    expect(surface).toHaveAttribute("aria-labelledby", "panel-toolbar-tab-terminal");

    // Close button works
    fireEvent.click(closeBtn);
    expect(useRightPanelStore.getState().isOpen).toBe(false);
  });

  it("new-thread header and home header contain no toolbar; thread header still has it", async () => {
    setViewportWidth(1280);
    const { router } = await bootThread(1280);

    // 1. Thread header has toolbar
    expect(screen.getByRole("group", { name: "Right panel" })).toBeInTheDocument();

    // 2. New-thread header has no toolbar, Discard stands alone
    await act(() => router.navigate({ to: "/new" }));
    await screen.findByRole("heading", { name: "New thread" });
    expect(screen.queryByRole("group", { name: "Right panel" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Thread tools" })).toBeNull();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();

    // 3. Home header has no toolbar
    await act(() => router.navigate({ to: "/" }));
    await screen.findByText("Pick a thread");
    expect(screen.queryByRole("group", { name: "Right panel" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Thread tools" })).toBeNull();

    // 4. Returning to thread restores toolbar
    await act(() => router.navigate({ to: "/thread/$threadId", params: { threadId: "t1" } }));
    await screen.findByRole("heading", { name: "Test Overlap" });
    expect(screen.getByRole("group", { name: "Right panel" })).toBeInTheDocument();
  });

  it("missing thread: toolbar stays hidden when the open thread is missing", async () => {
    await bootThread(1280);
    expect(screen.getByRole("group", { name: "Right panel" })).toBeInTheDocument();

    // When thread is marked missing, toolbar is hidden
    act(() => {
      useThreadStore.setState({ missing: "t1" });
    });
    expect(screen.queryByRole("group", { name: "Right panel" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Thread tools" })).toBeNull();

    // When no longer missing, toolbar returns
    act(() => {
      useThreadStore.setState({ missing: null });
    });
    expect(screen.getByRole("group", { name: "Right panel" })).toBeInTheDocument();
  });
});
