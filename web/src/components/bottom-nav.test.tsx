import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { BottomNav } from "./bottom-nav";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

describe("BottomNav files", () => {
  it("hides Files when disabled", () => {
    render(<MemoryRouter><BottomNav files={false} /></MemoryRouter>);
    expect(screen.queryByText("Files")).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Spaces", "Settings"]);
  });
  it("shows Files between Spaces and Settings and navigates", async () => {
    render(<MemoryRouter><BottomNav files /><LocationProbe /></MemoryRouter>);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Spaces", "Files", "Settings"]);
    await userEvent.click(screen.getByText("Files"));
    expect(screen.getByTestId("loc").textContent).toBe("/files");
  });
});
