import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionPopover } from "./popover";

describe("ActionPopover", () => {
  it("marks the page sibling inert while open and clears it on close", () => {
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    const page = document.createElement("main"); page.textContent = "page"; root.append(page);
    const host = document.createElement("div"); root.append(host);
    const { rerender } = render(<ActionPopover open onClose={vi.fn()} anchor={{ x: 20, y: 20 }}>body</ActionPopover>, { container: host });
    expect(page).toHaveAttribute("inert");
    expect(host.querySelector("[data-testid=action-popover]")).not.toHaveAttribute("inert");
    rerender(<ActionPopover open={false} onClose={vi.fn()} anchor={null}>body</ActionPopover>);
    expect(page).not.toHaveAttribute("inert");
    root.remove();
  });
  it("renders nothing while closed", () => {
    render(<ActionPopover open={false} onClose={vi.fn()} anchor={null}>body</ActionPopover>);
    expect(screen.queryByTestId("action-popover")).toBeNull();
  });

  it("renders at its anchor and focuses the panel", () => {
    render(<ActionPopover open onClose={vi.fn()} anchor={{ x: 120, y: 200 }} title="Actions">body</ActionPopover>);
    const panel = screen.getByTestId("action-popover");
    expect(panel).toHaveStyle({ left: "120px", top: "200px" });
    expect(panel).toHaveFocus();
    expect(panel).toHaveAttribute("aria-labelledby");
  });

  it.each([null, { x: 0, y: 0 }])("uses the 8px inset for %s", (anchor) => {
    render(<ActionPopover open onClose={vi.fn()} anchor={anchor}>body</ActionPopover>);
    expect(screen.getByTestId("action-popover")).toHaveStyle({ left: "8px", top: "8px" });
  });

  it("closes on Escape and outside pointerdown, but not inside", () => {
    const onClose = vi.fn();
    render(<ActionPopover open onClose={onClose} anchor={{ x: 20, y: 20 }}>body</ActionPopover>);
    const panel = screen.getByTestId("action-popover");
    fireEvent.pointerDown(panel);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
