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
  it("hides Files when disabled", () => { render(<MemoryRouter><BottomNav traces files={false} /></MemoryRouter>); expect(screen.queryByText("Files")).toBeNull(); });
  it("shows Files between Traces and Settings and navigates", async () => {
    render(<MemoryRouter><BottomNav traces files /><LocationProbe /></MemoryRouter>);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Spaces", "Traces", "Files", "Settings"]);
    expect(screen.getByText("Traces")).toBeTruthy();
    await userEvent.click(screen.getByText("Files"));
    expect(screen.getByTestId("loc").textContent).toBe("/files");
  });

  it("dots Traces and names every live repo", () => {
    render(<MemoryRouter><BottomNav traces liveRepos={["bench", "sightr"]} files={false} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "Traces, bench, sightr running" })).toBeTruthy();
    expect(screen.getByText("bench, sightr")).toBeTruthy();
    expect(screen.getByText("Traces")).toBeTruthy();
  });
});
