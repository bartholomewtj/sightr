import { act, render, screen } from "@testing-library/react";

import { ThinkingPulse } from "./thinking-pulse";

describe("ThinkingPulse", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders elapsed and the snip, then ticks the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
    render(<ThinkingPulse startedAt={Date.now() - 100_000} snip="last sentence." />);
    expect(screen.getByTestId("thinking-pulse")).toHaveTextContent(/Thinking 1:40/);
    expect(screen.getByTestId("thinking-pulse")).toHaveTextContent("last sentence.");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("thinking-pulse")).toHaveTextContent(/Thinking 1:41/);
    expect(screen.getByTestId("thinking-pulse")).toHaveTextContent("last sentence.");
  });

  it("omits the snip when the dump tail is empty", () => {
    render(<ThinkingPulse startedAt={Date.now()} snip="" />);
    expect(screen.getByTestId("thinking-pulse")).toHaveTextContent(/^Thinking 0:00$/);
  });
});
