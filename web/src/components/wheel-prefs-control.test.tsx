import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { WheelPrefsControl } from "./wheel-prefs-control";
import { STORAGE_KEY } from "@/hooks/use-wheel-prefs";

describe("WheelPrefsControl", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders a switch for each built-in and each shipped preset", () => {
    render(<WheelPrefsControl />);
    expect(screen.getByText("Gesture wheel")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Esc" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Tab" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enter" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Ctrl C" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Ctrl D" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Ctrl U" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Ctrl R" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Ctrl L" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Ctrl Z" })).toBeInTheDocument();

    expect(screen.getByText(/^This is the default wheel/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use the default wheel" })).toBeNull();
  });

  it("shows the default wheel's four slices as ON before anything is chosen", () => {
    render(<WheelPrefsControl />);
    for (const name of ["Esc", "Tab", "Enter", "Type"]) {
      expect(screen.getByRole("switch", { name })).toHaveAttribute("aria-checked", "true");
    }
    expect(screen.getByRole("switch", { name: "Ctrl C" })).toHaveAttribute("aria-checked", "false");
  });

  it("turning 'Ctrl C' on ADDS it to the default wheel rather than replacing it", () => {
    render(<WheelPrefsControl />);
    const ctrlCSwitch = screen.getByRole("switch", { name: "Ctrl C" });
    fireEvent.click(ctrlCSwitch);
    expect(ctrlCSwitch).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Esc" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("5 of 6 chosen. The wheel shows them in this list's order.")).toBeInTheDocument();

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.picks).toHaveLength(5);
    expect(stored.picks).toContain("keys:ctrl+c");

    expect(screen.getByRole("button", { name: "Use the default wheel" })).toBeInTheDocument();
  });

  it("with six on, an unpicked switch is disabled and the maximum line shows", () => {
    render(<WheelPrefsControl />);
    fireEvent.click(screen.getByRole("switch", { name: "Ctrl C" }));
    fireEvent.click(screen.getByRole("switch", { name: "Ctrl D" }));

    expect(screen.getByText("Six slices is the maximum — turn one off to add another.")).toBeInTheDocument();
    for (const name of ["Esc", "Tab", "Enter", "Type", "Ctrl C", "Ctrl D"]) {
      expect(screen.getByRole("switch", { name })).not.toBeDisabled();
    }
    expect(screen.getByRole("switch", { name: "Ctrl U" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Ctrl R" })).toBeDisabled();
  });

  it("'Use the default wheel' clears the picks and hides itself", () => {
    render(<WheelPrefsControl />);
    fireEvent.click(screen.getByRole("switch", { name: "Esc" }));
    expect(screen.getByRole("switch", { name: "Esc" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("3 of 6 chosen. The wheel shows them in this list's order.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use the default wheel" }));

    expect(screen.getByText(/^This is the default wheel/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use the default wheel" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Esc" })).toHaveAttribute("aria-checked", "true");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ picks: [] });
  });
});
