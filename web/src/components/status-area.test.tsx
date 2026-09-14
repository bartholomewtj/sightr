import { describe, expect, it, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { StatusArea } from "./status-area";
import { clearStatus, setStatus } from "@/lib/status";

function renderStatus() {
  const router = createMemoryRouter([
    { path: "/", element: <StatusArea /> },
    { path: "/pane/a", element: <div data-testid="pane" /> },
  ], { initialEntries: ["/"] });
  return { router, ...render(<RouterProvider router={router} />) };
}

describe("StatusArea", () => {
  beforeEach(() => clearStatus());
  it("navigates and clears a linked status", async () => {
    const { router } = renderStatus();
    act(() => setStatus("Agent needs you", "warn", 6000, "/pane/a"));
    expect(screen.getByRole("status")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Agent needs you" }));
    expect(router.state.location.pathname).toBe("/pane/a");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps ordinary statuses non-clickable and errors dismissable", async () => {
    renderStatus();
    act(() => setStatus("Info", "info"));
    expect(screen.queryByRole("button")).toBeNull();
    act(() => setStatus("Error", "error", null));
    expect(screen.getByRole("status")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("status"));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
