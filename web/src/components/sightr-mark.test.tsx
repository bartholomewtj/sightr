import { render, screen } from "@testing-library/react";

import { MARK_SRC, SightrLoader } from "./sightr-mark";

describe("SightrLoader", () => {
  it("renders a decorative mascot by default (aria-hidden, no img role)", () => {
    const { container } = render(<SightrLoader />);
    const el = container.querySelector(".sightr-mark");
    expect(el).not.toBeNull();
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("adds the running modifier only while loading", () => {
    const { container, rerender } = render(<SightrLoader running={false} />);
    expect(container.querySelector(".sightr-mark")).not.toHaveClass("sightr-mark--running");
    expect(container.querySelector(`img[src="${MARK_SRC}"]`)).not.toBeNull();
    rerender(<SightrLoader running />);
    expect(container.querySelector(".sightr-mark")).toHaveClass("sightr-mark--running");
    expect(container.querySelector(`img[src="${MARK_SRC}"]`)).toBeNull();
    expect(container.querySelector('img[src="/sightr-loading-badge.svg"]')).not.toBeNull();
  });

  it("exposes an accessible image when given a label", () => {
    render(<SightrLoader label="Loading" />);
    const el = screen.getByRole("img", { name: "Loading" });
    expect(el).not.toHaveAttribute("aria-hidden");
  });

  it("drives box + sprite scale from a single --mark-size length", () => {
    const { container } = render(<SightrLoader size="4rem" />);
    expect(container.querySelector<HTMLElement>(".sightr-mark")?.style.getPropertyValue("--mark-size")).toBe(
      "4rem",
    );
  });

  it("forwards className for placement", () => {
    const { container } = render(<SightrLoader className="mr-2" />);
    expect(container.querySelector(".sightr-mark")).toHaveClass("mr-2");
  });
});
