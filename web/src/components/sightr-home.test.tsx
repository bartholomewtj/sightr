import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";

import { SightrHome } from "./sightr-home";
import { MARK_SRC } from "./dog-gallop";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderHome(ui: ReactElement, entries: string[] = ["/"]) {
  return render(ui, {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={entries}>
        {children}
        <LocationProbe />
      </MemoryRouter>
    ),
  });
}

describe("SightrHome", () => {
  it("goes to Spaces with replace, like the bottom-bar tab", async () => {
    renderHome(<SightrHome trouble={false} />, ["/settings"]);
    await userEvent.click(screen.getByRole("button", { name: "Sightr home" }));
    expect(screen.getByTestId("loc").textContent).toBe("/");
  });

  it("is a no-op on Spaces, matching the tab", async () => {
    renderHome(<SightrHome trouble={false} />, ["/"]);
    await userEvent.click(screen.getByRole("button", { name: "Sightr home" }));
    expect(screen.getByTestId("loc").textContent).toBe("/");
  });

  it("shows the static app icon at rest and the running loader once troubled", () => {
    const { container, rerender } = renderHome(<SightrHome trouble={false} />);
    // Rest = the static badge, no loader mounted.
    expect(container.querySelector(".dog-gallop")).toBeNull();
    expect(container.querySelector(`img[src="${MARK_SRC}"]`)).not.toBeNull();
    rerender(<SightrHome trouble />);
    // Sustained trouble = the running loader replaces the static badge.
    expect(container.querySelector(`img[src="${MARK_SRC}"]`)).toBeNull();
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");
  });

  it("rests on the muted static icon (never a frozen loader) once the outage escalates to lost", () => {
    const { container } = renderHome(<SightrHome trouble lost />);
    expect(container.querySelector(".dog-gallop")).toBeNull();
    const icon = container.querySelector(`img[src="${MARK_SRC}"]`);
    expect(icon).not.toBeNull();
    expect(icon?.closest("span")?.className ?? "").toMatch(/grayscale/);
    expect(screen.getByRole("button", { name: "Sightr home — not connected" })).toBeInTheDocument();
  });

  it("gallops while troubled but NOT yet lost", () => {
    const { container } = renderHome(<SightrHome trouble lost={false} />);
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");
    expect(screen.getByRole("button", { name: "Sightr home — reconnecting" })).toBeInTheDocument();
  });

  it("shows the wordmark only when asked", () => {
    const { rerender } = renderHome(<SightrHome trouble={false} />);
    expect(screen.queryByText("Sightr")).toBeNull();
    rerender(<SightrHome trouble={false} wordmark />);
    expect(screen.getByText("Sightr")).toBeInTheDocument();
  });
});
