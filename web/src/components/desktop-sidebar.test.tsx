import type { HomeData } from "@/lib/loaders";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DesktopSidebar } from "./desktop-sidebar";
import { __resetDesktop } from "@/lib/desktop";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { homePath } from "@/lib/nav";

const data: HomeData = {
  bridge: "connected", device: undefined, agents: [], shellPanes: [], workspaces: [], tabs: [],
  error: false,
  authError: false, files: true,
};

beforeEach(() => __resetDesktop());
afterEach(() => __resetDesktop());

function renderSidebar(workspaces = data.workspaces, files = true) {
  const router = createMemoryRouter([{ id: "root", path: "/", loader: () => ({ ...data, workspaces, files }), element: <DesktopSidebar data={{ ...data, workspaces, files }} /> }], { initialEntries: ["/"] });
  return render(<RouterProvider router={router} />);
}

it("puts the sightr mark next to Sightr, and tapping it goes to Spaces", () => {
  const router = createMemoryRouter([{ path: "*", element: <DesktopSidebar data={data} /> }], { initialEntries: ["/files"] });
  render(<RouterProvider router={router} />);
  expect(screen.getByText("Sightr")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Sightr home" }));
  expect(router.state.location.pathname).toBe("/");
});

it("shows Files only when files are available and Traces only when a workspace has traces", async () => {
  const { rerender } = renderSidebar();
  await waitFor(() => expect(screen.getByText("Files")).toBeInTheDocument());
  expect(screen.queryByText("Traces")).not.toBeInTheDocument();
  const traced: HomeData["workspaces"][number] = { workspaceId: "w1", number: 1, label: "one", focused: false, activeTabId: "w1:t1", tabCount: 0, paneCount: 0, sssf: { state: "ready", token: "t", repos: [] } };
  rerender(<RouterProvider router={createMemoryRouter([{ id: "root", path: "/", element: <DesktopSidebar data={{ ...data, files: false, workspaces: [traced] }} />}], { initialEntries: ["/"] })} />);
  expect(screen.queryByText("Files")).not.toBeInTheDocument();
  expect(screen.getByText("Traces")).toBeInTheDocument();
});

it("names every live repo on the Traces item", async () => {
  const traced: HomeData["workspaces"][number] = {
    workspaceId: "w1", number: 1, label: "one", focused: false, activeTabId: "w1:t1", tabCount: 0, paneCount: 0,
    sssf: {
      state: "ready", token: "t",
      repos: [
        { name: "bench", state: "ready", running: true },
        { name: "sightr", state: "ready", running: true },
        { name: "soon", state: "pending", running: false },
      ],
    },
  };
  renderSidebar([traced], false);
  expect(await screen.findByRole("button", { name: "Traces, bench, sightr running" })).toBeInTheDocument();
  expect(screen.getByText("bench, sightr")).toBeInTheDocument();
});

it("opens the new-space dialog and creates a space with the real action", async () => {
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => data,
    element: <><DesktopSidebar data={data} /><Outlet /></>,
    children: [{ path: "pane/:paneId", element: <div>new pane</div> }],
  }], { initialEntries: [homePath()] });
  render(<RouterProvider router={router} />);
  fireEvent.click(await screen.findByLabelText("New space"));
  expect(await screen.findByText("Directory (optional)")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Create space/ }));
  await waitFor(() => expect(decodeURIComponent(router.state.location.pathname)).toBe("/pane/w9:p1"));
});

// Folded from desktop-sidebar-scroll.test.tsx.
describe('desktop sidebar scroll containment', () => {
  const data: HomeData = { bridge: "connected", device: undefined, agents: [], shellPanes: [], workspaces: [], tabs: [], error: false, authError: false, files: false };
  beforeEach(() => __resetDesktop()); afterEach(() => __resetDesktop());
  it("pins sidebar ends and leaves one tree scroll box", () => {
    const router = createMemoryRouter([{ path: "/", element: <DesktopSidebar data={data} /> }], { initialEntries: ["/"] });
    const { container } = render(<RouterProvider router={router} />);
    expect(container.querySelector("aside")).toHaveClass("absolute", "inset-0", "min-h-0", "overflow-hidden");
    const scroll = container.querySelectorAll(".overflow-y-auto");
    expect(scroll).toHaveLength(1);
    expect(scroll[0]).toContainElement(screen.getAllByText("Spaces")[0]!);
    expect(screen.getByRole("navigation", { name: "Desktop navigation" })).toHaveClass("mt-auto", "shrink-0");
  });
});