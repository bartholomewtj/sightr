import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { TreeRoute } from "./tree";
import { __resetDesktop } from "@/lib/desktop";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";

vi.mock("@/components/push-onboarding", () => ({ PushOnboarding: () => null }));

const home: HomeData = {
  bridge: "connected",
  device: undefined,
  agents: [],
  shellPanes: [],
  workspaces: [{ workspaceId: "w1", number: 1, label: "home", focused: false, activeTabId: "t1", tabCount: 1, paneCount: 1 }],
  tabs: [{ tabId: "t1", workspaceId: "w1", number: 1, label: "main", focused: false, paneCount: 1 }],
  error: false,
  authError: false,
};

function renderTree() {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => home,
        element: <Outlet />,
        children: [{ index: true, element: <TreeRoute /> }],
      },
    ],
    { initialEntries: ["/"] },
  );
  const view = render(<RouterProvider router={router} />);
  return { ...view, router };
}

describe("TreeRoute phone scroll", () => {
  beforeEach(() => __resetDesktop());
  afterEach(() => __resetDesktop());

  it("scrolls the spaces tree inside the screen so the bottom bar stays put", async () => {
    const { container } = renderTree();
    await waitFor(() => expect(screen.getByRole("button", { name: "Sightr home" })).toBeInTheDocument());
    const scroller = container.querySelector(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    expect(scroller).toHaveClass("min-h-0", "flex-1", "overscroll-contain");
    expect(scroller?.querySelector("main")).toBeNull();
  });
});
