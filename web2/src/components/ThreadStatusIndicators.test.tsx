import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadStatus } from "@shared/v2/contracts";
import { setReducedMotion } from "@/test/media";

import { STATUS_DOT_CLASS, ThreadStatusDot } from "./ThreadStatusIndicators";

const dot = (name: string | RegExp) => screen.getByRole("img", { name }).querySelector("[data-slot=status-dot]")!;

describe("ThreadStatusDot", () => {
  afterEach(() => vi.useRealTimers());

  it.each<[ThreadStatus, string, string]>([
    ["approval", "Needs approval", "bg-you"],
    ["input", "Needs input", "bg-you"],
    ["failed", "Failed", "bg-warn"],
    ["working", "Working", "bg-navy"],
    ["done", "Done", "bg-ok"],
    ["idle", "Idle", "border-house-muted"],
    ["starting", "Starting", "border-navy"],
  ])("%s: token class and accessible name", (status, name, token) => {
    render(<ThreadStatusDot status={status} />);
    expect(dot(name)).toHaveClass(token);
    expect(STATUS_DOT_CLASS[status]).toContain(token);
  });

  it("is solid with the needs-you weight only for approval, input and done; idle is a hollow ring", () => {
    for (const s of ["approval", "input", "done"] as const) expect(STATUS_DOT_CLASS[s]).toContain("size-2.5");
    for (const s of ["failed", "working", "idle", "starting"] as const) expect(STATUS_DOT_CLASS[s]).not.toContain("size-2.5");
    expect(STATUS_DOT_CLASS.idle).toContain("bg-transparent");
  });

  it("pulses while working or starting, and shows the elapsed time ticking each second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 16, 12, 0, 0));
    const since = Date.now() - 134_000;
    render(<ThreadStatusDot status="working" workingSince={since} />);
    expect(dot("Working, 2:14")).toHaveClass("animate-status-pulse");
    expect(screen.getByText("2:14")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByRole("img", { name: "Working, 2:15" })).toBeInTheDocument();
    expect(screen.getByText("2:15")).toBeInTheDocument();
  });

  it("does not pulse anything else", () => {
    render(<ThreadStatusDot status="approval" />);
    expect(dot("Needs approval")).not.toHaveClass("animate-status-pulse");
  });

  it("stops the pulse under prefers-reduced-motion", () => {
    setReducedMotion(true);
    render(<ThreadStatusDot status="starting" />);
    expect(dot("Starting")).not.toHaveClass("animate-status-pulse");
    act(() => setReducedMotion(false));
    expect(dot("Starting")).toHaveClass("animate-status-pulse");
  });
});
