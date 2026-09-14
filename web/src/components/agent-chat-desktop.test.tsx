import { fireEvent, render, screen, cleanup, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentChat } from "./agent-chat";
import { setDesktop, __resetDesktop } from "@/lib/desktop";
import { fixtureAgents } from "@/test/handlers";
import { openMore } from "@/test/composer-menu";
import { openPaneDetails } from "@/test/pane-details";

beforeEach(() => { localStorage.clear(); Element.prototype.scrollTo = () => {}; __resetDesktop(); });
afterEach(() => { cleanup(); __resetDesktop(); });
function show() {
  const a = fixtureAgents[0]!;
  const sibling = { ...a, paneId: "w1:p2" };
  const router = createMemoryRouter([{ path: "/", element: <AgentChat paneId={a.paneId} agent={a} agents={[a, sibling]} shellPanes={[]} text="output" onBack={() => {}} onSelect={() => {}} /> }]);
  render(<RouterProvider router={router} />);
}
describe("AgentChat desktop controls", () => {
  it("shows phone controls and opens the pane switcher from the details sheet", () => {
    show();
    // No swipe handle and no pane strip on the pane screen itself any more.
    expect(screen.queryByRole("button", { name: "Switch pane" })).toBeNull();
    expect(screen.queryByText("Panes")).toBeNull();
    // The phone rows of the + menu: Keys and Type sit alongside Attach.
    openMore();
    expect(screen.getByRole("button", { name: "Keys" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Type into terminal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // The tab's pane list and the cross-space switcher live behind the title.
    const sheet = openPaneDetails();
    expect(within(sheet).getByText("Panes")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Switch pane…" }));
    expect(screen.getByRole("dialog", { name: "Switch pane" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Pane details" })).toBeNull();
  });

  it("hides phone controls while keeping the composer on desktop", () => {
    setDesktop(true);
    show();
    expect(screen.queryByRole("button", { name: "Switch pane" })).toBeNull();
    expect(screen.queryByText("Panes")).toBeNull();
    // The details popover still lists the tab's panes, but has no cross-space switcher row: the
    // desktop sidebar already lists every pane.
    const popover = openPaneDetails();
    expect(popover).toHaveAttribute("data-testid", "action-popover");
    expect(within(popover).getByText("Panes")).toBeInTheDocument();
    expect(within(popover).queryByRole("button", { name: "Switch pane…" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Pane details" })).toBeNull();
    // The + menu drops the phone-only rows but keeps Attach, Terminal and Display.
    openMore();
    expect(screen.queryByRole("button", { name: "Keys" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Type into terminal" })).toBeNull();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Display" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByPlaceholderText(/type a reply/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});
