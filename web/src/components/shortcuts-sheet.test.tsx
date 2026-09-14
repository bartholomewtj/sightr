import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { closeShortcuts, DESKTOP_HOTKEYS, openShortcuts, useDesktopHotkeys } from "@/hooks/use-desktop-hotkeys";
import { __resetDirectArm, setDirectArmed } from "@/lib/direct-arm";
import { ShortcutsSheet } from "./shortcuts-sheet";

afterEach(() => { closeShortcuts(); __resetDirectArm(); });

function HookProbe() {
  useDesktopHotkeys({ agents: [] });
  return <ShortcutsSheet />;
}

function renderWithHook() {
  const router = createMemoryRouter([{ path: "*", element: <HookProbe /> }], { initialEntries: ["/"] });
  return render(<RouterProvider router={router} />);
}

describe("ShortcutsSheet", () => {
  it("lists every binding from the desktop hotkey table", () => {
    act(() => openShortcuts());
    render(<ShortcutsSheet />);
    for (const binding of DESKTOP_HOTKEYS) {
      expect(screen.getByText(binding.label)).toBeInTheDocument();
      for (const key of binding.keys) expect(screen.getAllByText(key).length).toBeGreaterThan(0);
    }
  });

  it("opens when ? is dispatched through the hook table", () => {
    renderWithHook();
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("does not open from a typing target or while direct typing is armed", () => {
    renderWithHook();
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "?" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    setDirectArmed(true);
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    input.remove();
  });

  it("closes from the sheet close button and Escape", () => {
    act(() => openShortcuts());
    render(<ShortcutsSheet />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
