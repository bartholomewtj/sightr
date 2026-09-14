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

    expect(screen.getByText("0 of 6 chosen. The wheel follows this order, left to right.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use the default wheel" })).toBeNull();
  });

  it("turning 'Ctrl C' on writes its id to localStorage and shows '1 of 6 chosen'", () => {
    render(<WheelPrefsControl />);
    const ctrlCSwitch = screen.getByRole("switch", { name: "Ctrl C" });
    expect(ctrlCSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(ctrlCSwitch);
    expect(ctrlCSwitch).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("1 of 6 chosen. The wheel follows this order, left to right.")).toBeInTheDocument();

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored).toEqual({ picks: ["keys:ctrl+c"] });

    expect(screen.getByRole("button", { name: "Use the default wheel" })).toBeInTheDocument();
  });

  it("with six on, an unpicked switch is disabled and the maximum line shows", () => {
    render(<WheelPrefsControl />);
    const namesToPick = ["Esc", "Tab", "Enter", "Type", "Ctrl C", "Ctrl D"];
    for (const name of namesToPick) {
      fireEvent.click(screen.getByRole("switch", { name }));
    }

    expect(screen.getByText("Six slices is the maximum — turn one off to add another.")).toBeInTheDocument();

    // Picked switches remain enabled so they can be turned off
    for (const name of namesToPick) {
      expect(screen.getByRole("switch", { name })).not.toBeDisabled();
    }

    // Unpicked switch is disabled
    expect(screen.getByRole("switch", { name: "Ctrl U" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Ctrl R" })).toBeDisabled();
  });

  it("'Use the default wheel' clears the picks and hides itself", () => {
    render(<WheelPrefsControl />);
    fireEvent.click(screen.getByRole("switch", { name: "Esc" }));
    expect(screen.getByText("1 of 6 chosen. The wheel follows this order, left to right.")).toBeInTheDocument();

    const clearButton = screen.getByRole("button", { name: "Use the default wheel" });
    fireEvent.click(clearButton);

    expect(screen.getByText("0 of 6 chosen. The wheel follows this order, left to right.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use the default wheel" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Esc" })).toHaveAttribute("aria-checked", "false");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ picks: [] });
  });
});
