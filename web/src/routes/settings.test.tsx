import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";

import { SettingsRoute } from "./settings";
import { server } from "@/test/setup";
import { __resetDesktop, setDesktop } from "@/lib/desktop";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { closeShortcuts, isShortcutsOpen } from "@/hooks/use-desktop-hotkeys";

const home: HomeData = {
  bridge: "connected",
  device: undefined,
  agents: [],
  shellPanes: [],
  workspaces: [],
  tabs: [],
  error: false,
  authError: false,
};

function renderSettings(desktop = false) {
  if (desktop) setDesktop(true);
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => home,
        element: <Outlet />,
        children: [{ path: "settings", element: <SettingsRoute /> }],
      },
    ],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("SettingsRoute", () => {
  beforeEach(() => {
    __resetDesktop();
    server.use(http.get("/api/lock", () => HttpResponse.json({ enabled: false, unlocked: true, webauthn: false, credentials: [] })));
  });
  afterEach(() => { __resetDesktop(); closeShortcuts(); });

  it("keeps the phone column, heading, and stacked cards", async () => {
    renderSettings();
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sightr home" })).toBeNull();
    const appearance = screen.getByText("Appearance");
    expect(appearance.closest(".max-w-screen-sm")).not.toBeNull();
    expect(appearance.closest(".grid-cols-2")).toBeNull();
    expect(screen.getByText("Desktop mode")).toBeInTheDocument();
    expect(screen.getByText("Gesture wheel")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Show terminal" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Tap to type" })).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Push notifications" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio", { name: "System" })[1]!).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: /keyboard shortcuts/i })).toBeNull();
  });

  it("uses the pane header and two stacked columns on desktop", async () => {
    renderSettings(true);
    expect(await screen.findByRole("button", { name: "Sightr home" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    const shortcuts = screen.getByRole("button", { name: /keyboard shortcuts/i });
    expect(shortcuts).toHaveTextContent("See every desktop shortcut. Press ? anywhere.");
    expect(isShortcutsOpen()).toBe(false);
    shortcuts.click();
    expect(isShortcutsOpen()).toBe(true);
    const appearance = screen.getByText("Appearance");
    expect(appearance.closest(".max-w-screen-sm")).toBeNull();
    const grid = appearance.closest(".grid-cols-2");
    expect(grid).not.toBeNull();
    expect(grid!.children).toHaveLength(2);
    expect(grid!.children[0]).toContainElement(appearance);
    expect(grid!.children[0]).toContainElement(screen.getByText("Desktop mode"));
    expect(grid!.children[0]).toContainElement(screen.getByText("Gesture wheel"));
    expect(grid!.children[0]).toContainElement(screen.getByRole("switch", { name: "Raw terminal" }));
    expect(screen.queryByRole("switch", { name: "Tap to type" })).toBeNull();
    expect(grid!.children[1]).toContainElement(screen.getByText("Push notifications"));
    expect(grid!.children[1]).toContainElement(screen.getByText("Finished"));
    expect(screen.queryByText("App updates")).toBeNull();
    expect(await screen.findByRole("switch", { name: "Push notifications" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Reconnect lock")).toBeInTheDocument());
    expect(grid!.children[0]).toContainElement(screen.getByText("Reconnect lock"));
    expect(screen.getAllByRole("radio", { name: "On" })[0]!).toHaveAttribute("aria-checked", "true");
  });
});
