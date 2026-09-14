import { fireEvent, render, screen, cleanup, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChat } from "./agent-chat";
import { __resetDesktop, setDesktop, setTyping } from "@/lib/desktop";
import { requestArmToggle } from "@/lib/direct-arm";
import { __resetPasteHold, setPasteHold } from "@/lib/paste-hold";
import { fixtureAgents } from "@/test/handlers";
import type { DeviceAuth } from "@/lib/types";

function show(agent = fixtureAgents[0], device?: DeviceAuth) {
  const a = agent!;
  const router = createMemoryRouter([{ path: "/", element: <AgentChat paneId={a.paneId} agent={a} agents={[a]} shellPanes={[]} text="output" device={device} onBack={vi.fn()} onSelect={vi.fn()} /> }]);
  render(<RouterProvider router={router} />);
}
beforeEach(() => { localStorage.clear(); Element.prototype.scrollTo = () => {}; __resetDesktop(); setDesktop(true); setTyping("direct"); });
afterEach(() => { cleanup(); __resetDesktop(); __resetPasteHold(); });
describe("AgentChat direct arm", () => {
  it("arms from mirror, focuses the textarea, and shows ring", () => { show(); fireEvent.click(screen.getByText("output")); expect(screen.getByText("Typing into terminal")).toBeInTheDocument(); expect(screen.getByPlaceholderText(/type a reply|terminal/i)).toHaveFocus(); expect(screen.getByTestId("mirror-region")).toHaveClass("ring-2"); });
  it("refuses a selected mirror click", () => { const spy = vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: false } as Selection); show(); fireEvent.click(screen.getByText("output")); expect(screen.queryByText("Typing into terminal")).toBeNull(); spy.mockRestore(); });
  it("does not arm on composer surface but focuses", () => { setTyping("composer"); show(); fireEvent.click(screen.getByText("output")); expect(screen.queryByText("Typing into terminal")).toBeNull(); expect(screen.getByPlaceholderText(/type a reply/i)).toHaveFocus(); });
  it("toggles from the arm signal and releases outside", () => { show(); act(() => requestArmToggle()); expect(screen.getByText("Typing into terminal")).toBeInTheDocument(); act(() => requestArmToggle()); expect(screen.queryByText("Typing into terminal")).toBeNull(); });
  it("releases on outside pointer, mirror buttons, and window blur but not textarea", () => { show(); act(() => requestArmToggle()); const box = screen.getByPlaceholderText(/terminal/i); fireEvent.pointerDown(box); expect(screen.getByText("Typing into terminal")).toBeInTheDocument(); fireEvent.pointerDown(document.body); expect(screen.queryByText("Typing into terminal")).toBeNull(); act(() => requestArmToggle()); const button = document.createElement("button"); screen.getByTestId("mirror-region").append(button); fireEvent.pointerDown(button); expect(screen.queryByText("Typing into terminal")).toBeNull(); act(() => requestArmToggle()); fireEvent.blur(window); expect(screen.queryByText("Typing into terminal")).toBeNull(); });
  it("does not release on paste-hold Send before the click sends", () => {
    const send = vi.fn();
    show();
    act(() => requestArmToggle());
    act(() => setPasteHold({ kind: "text", lines: 3, reason: null, onSend: send, onDiscard: vi.fn() }));
    const sendBtn = screen.getByRole("button", { name: "Send" });
    fireEvent.pointerDown(sendBtn);
    expect(screen.getByText(/Paste 3 lines/)).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(sendBtn);
    expect(send).toHaveBeenCalledOnce();
  });
  it("shows locked strip for read-only device and cannot arm", () => { show(fixtureAgents[0], { enforced: true, device: "x", authorized: false }); expect(screen.getByText(/read-only device/)).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(); fireEvent.click(screen.getByText("output")); expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(); });
  it("shows locked strip for gone pane and cannot arm", () => {
    const a = fixtureAgents[0]!;
    const router = createMemoryRouter([{ path: "/", element: <AgentChat paneId={a.paneId} agent={undefined} agents={[]} shellPanes={[]} text="output" onBack={vi.fn()} onSelect={vi.fn()} /> }]);
    render(<RouterProvider router={router} />);
    // The gone-pane strip is present but disabled on purpose; arming is refused by !gone.
    expect(screen.getByText(/pane is gone/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.click(screen.getByText("output"));
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByTestId("mirror-region")).not.toHaveClass("ring-2");
  });
});
