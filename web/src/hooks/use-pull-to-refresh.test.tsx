import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { isPullRefresh, PULL_THRESHOLD, usePullToRefresh } from "./use-pull-to-refresh";

function finger(y: number, x = 0) {
  return { identifier: 1, target: document.body, clientX: x, clientY: y };
}

function pull(el: HTMLElement, fromY: number, toY: number, x = 10) {
  fireEvent.touchStart(el, { touches: [finger(fromY, x)] });
  fireEvent.touchMove(el, { touches: [finger(toY, x)] });
  fireEvent.touchEnd(el, { changedTouches: [finger(toY, x)] });
}

function Harness({
  onRefresh,
  busy = false,
  scrollTop = 0,
}: {
  onRefresh: () => void;
  busy?: boolean;
  scrollTop?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pull = usePullToRefresh(ref, onRefresh, !busy);
  return (
    <div
      ref={(node) => {
        ref.current = node;
        if (node) Object.defineProperty(node, "scrollTop", { value: scrollTop, configurable: true });
      }}
      data-testid="scroller"
      data-distance={pull.distance}
      data-ready={pull.ready}
      data-refreshing={pull.refreshing}
    />
  );
}

describe("isPullRefresh", () => {
  it("refreshes a downward pull that starts at the top and passes the threshold", () => {
    expect(isPullRefresh(0, 0, PULL_THRESHOLD)).toBe(true);
  });

  it("ignores a pull that starts below the top", () => {
    expect(isPullRefresh(40, 0, 200)).toBe(false);
  });

  it("ignores a pull shorter than the threshold", () => {
    expect(isPullRefresh(0, 0, PULL_THRESHOLD - 1)).toBe(false);
  });

  it("ignores a sideways-dominant drag", () => {
    expect(isPullRefresh(0, 100, 80)).toBe(false);
  });
});

describe("usePullToRefresh", () => {
  it("calls onRefresh once for a pull at the top", () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    pull(screen.getByTestId("scroller"), 0, PULL_THRESHOLD + 8);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("scroller")).toHaveAttribute("data-refreshing", "true");
  });

  it("does nothing when the gesture starts below the top", () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} scrollTop={120} />);
    pull(screen.getByTestId("scroller"), 0, 200);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does nothing for a pull shorter than the threshold", () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    pull(screen.getByTestId("scroller"), 0, 20);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.getByTestId("scroller")).toHaveAttribute("data-refreshing", "false");
  });

  it("does not refresh while a refresh is already in flight", () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} busy />);
    pull(screen.getByTestId("scroller"), 0, 200);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("drops the indicator only after the refresh has been busy and returns to idle", () => {
    const onRefresh = vi.fn();
    function Gate() {
      const [busy, setBusy] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setBusy((b) => !b)}>toggle</button>
          <Harness onRefresh={onRefresh} busy={busy} />
        </>
      );
    }
    render(<Gate />);
    const scroller = screen.getByTestId("scroller");
    pull(scroller, 0, 200);
    expect(scroller).toHaveAttribute("data-refreshing", "true");
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(scroller).toHaveAttribute("data-refreshing", "true");
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(scroller).toHaveAttribute("data-refreshing", "false");
  });
});
