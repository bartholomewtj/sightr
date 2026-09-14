import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { SpaceRedirect, SpacesRedirect } from "./redirects";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";

const connected: HomeData = {
  bridge: "connected",
  agents: [],
  shellPanes: [],
  workspaces: [],
  tabs: [],
  device: undefined,
  error: false,
  authError: false,
};

function makeRouter(initialPath: string) {
  return createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => connected,
        element: <Outlet />,
        children: [
          { index: true, element: <div data-testid="home">HOME</div> },
          { path: "spaces", element: <SpacesRedirect /> },
          { path: "space/:spaceId", element: <SpaceRedirect /> },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  );
}

describe("Redirects", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("/spaces redirects to /", async () => {
    const router = makeRouter("/spaces");
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("home")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("/space/:spaceId expands the space and redirects to /", async () => {
    const router = makeRouter("/space/w123");
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("home")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");

    const stored = JSON.parse(localStorage.getItem("sightr:dash-prefs:v2") ?? "{}");
    expect(stored.spaceOpen?.w123).toBe(true);
  });
});
