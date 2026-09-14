import { FILES_FIND_ID } from "@/components/desktop-sidebar-slot";
import { onFindOpenRequest } from "@/lib/find-request";
import { __resetDirectArm, setDirectArmed, onArmToggleRequest } from "@/lib/direct-arm";
import { __resetDesktop, setDesktop, desktopPrefs, setTyping } from "@/lib/desktop";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useDesktopHotkeys } from "./use-desktop-hotkeys";
import type { AgentView } from "@/lib/types";
import { panePath } from "@/lib/nav";

const agent = (paneId: string, status: AgentView["status"]): AgentView => ({
  paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t",
  agent: "claude", status, cwd: "/tmp", focused: false,
});
const agents = [agent("blocked", "blocked"), agent("working", "working"), agent("idle", "idle")];
function Probe({ currentPaneId, list = agents }: { currentPaneId?: string; list?: AgentView[] }) {
  useDesktopHotkeys({ agents: list, currentPaneId });
  return <output data-testid="pathname">{useLocation().pathname}</output>;
}
function mount(currentPaneId: string | undefined, list = agents) {
  const router = createMemoryRouter(
    [{ path: "*", element: <Probe currentPaneId={currentPaneId} list={list} /> }],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}
function dispatch(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, ctrlKey: true, altKey: true, cancelable: true, ...options });
  act(() => { window.dispatchEvent(event); });
  return event;
}
afterEach(() => cleanup());

describe("useDesktopHotkeys", () => {
  it("navigates down and up in triage order, wrapping at both ends", () => {
    mount("blocked");
    expect(dispatch("ArrowDown").defaultPrevented).toBe(true);
    expect(screen.getByTestId("pathname")).toHaveTextContent(panePath("working"));
    cleanup();

    mount("working");
    dispatch("ArrowUp");
    expect(screen.getByTestId("pathname")).toHaveTextContent(panePath("blocked"));
    cleanup();

    mount("idle");
    dispatch("ArrowDown");
    expect(screen.getByTestId("pathname")).toHaveTextContent(panePath("blocked"));
    cleanup();

    mount("blocked");
    dispatch("ArrowUp");
    expect(screen.getByTestId("pathname")).toHaveTextContent(panePath("idle"));
  });

  it("does not claim unrelated chords, and empty lists are a no-op", () => {
    mount("blocked");
    expect(dispatch("ArrowDown", { ctrlKey: false, altKey: false }).defaultPrevented).toBe(false);
    expect(dispatch("ArrowLeft").defaultPrevented).toBe(false);
    expect(dispatch("ArrowDown", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(screen.getByTestId("pathname")).toHaveTextContent(/^\/$/);
    cleanup();

    mount(undefined, []);
    expect(dispatch("ArrowDown").defaultPrevented).toBe(false);
    expect(screen.getByTestId("pathname")).toHaveTextContent(/^\/$/);
  });

  it("removes its listener when unmounted", () => {
    const { unmount } = mount("blocked");
    unmount();
    expect(dispatch("ArrowDown").defaultPrevented).toBe(false);
  });
});

// Folded from use-desktop-hotkeys-arm.test.tsx.
describe('desktop arm hotkey', () => {
  const agent = (paneId: string, status: AgentView["status"]): AgentView => ({ paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status, cwd: "/tmp", focused: false });
  const agents = [agent("blocked", "blocked"), agent("working", "working")];
  function Probe() { useDesktopHotkeys({ agents, currentPaneId: "blocked" }); return <output data-testid="path">{useLocation().pathname}</output>; }
  function mount() { const router = createMemoryRouter([{ path: "*", element: <Probe /> }]); return render(<RouterProvider router={router} />); }
  function dispatch(key: string, options: KeyboardEventInit = {}) { const e = new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true, ...options }); act(() => window.dispatchEvent(e)); return e; }
  beforeEach(() => { localStorage.clear(); __resetDesktop(); setDesktop(true); });
  afterEach(() => { cleanup(); __resetDesktop(); });

  describe("desktop arm hotkey", () => {
    it("switches composer to direct and requests arm", () => { const fn = vi.fn(); const off = onArmToggleRequest(fn); mount(); expect(dispatch("`").defaultPrevented).toBe(true); expect(desktopPrefs().typing).toBe("direct"); expect(fn).toHaveBeenCalledOnce(); off(); });
    it("requests again without changing direct", () => { setTyping("direct"); const fn = vi.fn(); const off = onArmToggleRequest(fn); mount(); dispatch("`"); expect(fn).toHaveBeenCalledOnce(); expect(desktopPrefs().typing).toBe("direct"); off(); });
    it("does not claim other chords", () => { const fn = vi.fn(); const off = onArmToggleRequest(fn); mount(); expect(dispatch("`", { shiftKey: true }).defaultPrevented).toBe(false); expect(dispatch("`", { altKey: true }).defaultPrevented).toBe(false); expect(dispatch("`", { ctrlKey: false }).defaultPrevented).toBe(false); expect(fn).not.toHaveBeenCalled(); off(); });
    it("unsubscribes with the hook", () => { const fn = vi.fn(); const off = onArmToggleRequest(fn); const { unmount } = mount(); off(); unmount(); expect(dispatch("`").defaultPrevented).toBe(false); });
    it("keeps pane navigation", () => { mount(); dispatch("ArrowDown", { altKey: true }); expect(screen.getByTestId("path")).toHaveTextContent(/working/); });
  });
});

// Folded from use-desktop-hotkeys-find.test.tsx.
describe('desktop Ctrl+F', () => {
  describe("desktop Ctrl+F", () => {
    beforeEach(() => { __resetDesktop(); setDesktop(true); __resetDirectArm(); });
    afterEach(() => { cleanup(); __resetDesktop(); __resetDirectArm(); });
    function mount(path: string, pane?: string, includeFind = true) {
      function Probe() { useDesktopHotkeys({ agents: [], currentPaneId: pane }); return <>{path.startsWith("/files") && includeFind && <input id={FILES_FIND_ID} />}</>; }
      return render(<RouterProvider router={createMemoryRouter([{ path: "*", element: <Probe /> }], { initialEntries: [path] })} />);
    }
    function dispatch(options: KeyboardEventInit = {}) { const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true, ...options }); act(() => window.dispatchEvent(event)); return event; }
    it("focuses the Files input without opening pane find", () => { const fn = vi.fn(); const off = onFindOpenRequest(fn); mount("/files", "p"); const input = screen.getByRole("textbox"); expect(dispatch().defaultPrevented).toBe(true); expect(document.activeElement).toBe(input); expect(fn).not.toHaveBeenCalled(); off(); });
    it("opens find only on an unarmed pane", () => { const fn = vi.fn(); const off = onFindOpenRequest(fn); mount("/pane/p", "p"); expect(dispatch().defaultPrevented).toBe(true); expect(fn).toHaveBeenCalledOnce(); off(); });
    it("declines while armed on Files, with a missing input, on Traces, and outside panes", () => {
      const fn = vi.fn(); const off = onFindOpenRequest(fn);
      mount("/files", "p"); const input = screen.getByRole("textbox"); setDirectArmed(true);
      expect(dispatch().defaultPrevented).toBe(false); expect(document.activeElement).not.toBe(input); expect(fn).not.toHaveBeenCalled();
      cleanup(); __resetDirectArm(); mount("/files", "p", false); expect(dispatch().defaultPrevented).toBe(false);
      cleanup(); mount("/traces", "p"); expect(dispatch().defaultPrevented).toBe(false);
      cleanup(); mount("/pane/p"); expect(dispatch().defaultPrevented).toBe(false); expect(fn).not.toHaveBeenCalled(); off();
    });
    it("does not prevent or arm Ctrl+` on Files", () => { const fn = vi.fn(); const off = onArmToggleRequest(fn); mount("/files", "p"); const event = new KeyboardEvent("keydown", { key: "`", ctrlKey: true, cancelable: true }); act(() => window.dispatchEvent(event)); expect(event.defaultPrevented).toBe(false); expect(fn).not.toHaveBeenCalled(); off(); });
    it("does not claim other chords", () => { const fn = vi.fn(); const off = onFindOpenRequest(fn); mount("/pane/p", "p"); expect(dispatch({ shiftKey: true }).defaultPrevented).toBe(false); expect(dispatch({ altKey: true }).defaultPrevented).toBe(false); expect(dispatch({ ctrlKey: false }).defaultPrevented).toBe(false); expect(fn).not.toHaveBeenCalled(); off(); });
    it("unsubscribes after unmount", () => { const fn = vi.fn(); const off = onFindOpenRequest(fn); const view = mount("/pane/p", "p"); view.unmount(); dispatch(); expect(fn).not.toHaveBeenCalled(); off(); });
  });
});