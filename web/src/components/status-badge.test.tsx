import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { StatusBadge, StatusDot } from "./status-badge";

describe("StatusDot", () => {
  it("renders a still amber dot when working — no motion unless the caller asks for it", () => {
    const { container } = render(<StatusDot status="working" />);
    const innerDot = container.querySelector(".relative.inline-flex");
    expect(innerDot).toHaveClass("bg-status-working");
    expect(innerDot).not.toHaveClass("status-breathe");
  });

  // Only the dot the operator watches a pane through breathes; several un-phased dots on one screen
  // read as blinking rather than as "alive".
  it("breathes when working and `live` is asked for", () => {
    const { container } = render(<StatusDot status="working" live />);
    expect(container.querySelector(".relative.inline-flex")).toHaveClass("status-breathe");
  });

  it("does not breathe on a frozen reading, a running command, or a resting state", () => {
    const dot = (el: HTMLElement) => el.querySelector(".relative.inline-flex");
    expect(dot(render(<StatusDot status="working" live stale />).container)).not.toHaveClass("status-breathe");
    expect(dot(render(<StatusDot status="working" live runningCommand />).container)).not.toHaveClass("status-breathe");
    expect(dot(render(<StatusDot status="idle" live />).container)).not.toHaveClass("status-breathe");
  });

  it("renders solid blue when working and runningCommand is true", () => {
    const { container } = render(<StatusDot status="working" runningCommand />);
    const innerDot = container.querySelector(".relative.inline-flex");
    expect(innerDot).toHaveClass("bg-status-running");
    expect(innerDot).not.toHaveClass("bg-status-working");
  });

  it("ignores runningCommand when status is not working", () => {
    const { container } = render(<StatusDot status="idle" runningCommand />);
    const innerDot = container.querySelector(".relative.inline-flex");
    expect(innerDot).toHaveClass("border-[1.5px]");
    expect(innerDot).not.toHaveClass("bg-status-running");
  });
});

describe("StatusBadge", () => {
  it("renders working badge with amber dot by default", () => {
    const { container } = render(<StatusBadge status="working" />);
    expect(screen.getByText("working")).toBeInTheDocument();
    const dot = container.querySelector(".size-1\\.5");
    expect(dot).toHaveClass("bg-status-working");
  });

  it("renders working badge with blue dot when runningCommand is true", () => {
    const { container } = render(<StatusBadge status="working" runningCommand />);
    expect(screen.getByText("working")).toBeInTheDocument();
    const dot = container.querySelector(".size-1\\.5");
    expect(dot).toHaveClass("bg-status-running");
    expect(dot).not.toHaveClass("bg-status-working");
  });
});
