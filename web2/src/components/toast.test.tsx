import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetThreadUndoNotice, showThreadUndoNotice } from "@/hooks/showThreadUndoNotice";

import { __resetToasts, ACTION_TOAST_MS, composerClearance, MESSAGE_TOAST_MS, showToast, SWIPE_DISMISS_PX, swipeDismisses, ToastStack } from "./toast";

afterEach(() => {
  __resetToasts();
  __resetThreadUndoNotice();
  document.body.innerHTML = "";
});

describe("toast stack on a phone", () => {
  it("a tap dismisses a message toast", () => {
    render(<ToastStack />);
    act(() => void showToast("Pick a snooze time from the menu"));
    fireEvent.click(screen.getByRole("status"));
    expect(screen.queryByText("Pick a snooze time from the menu")).toBeNull();
  });

  it("clears the thread composer so a toast never covers Send", () => {
    const composer = document.createElement("div");
    composer.setAttribute("data-region", "composer");
    composer.getBoundingClientRect = () => ({ top: window.innerHeight - 120, bottom: window.innerHeight, height: 120 }) as DOMRect;
    document.body.append(composer);
    expect(composerClearance()).toBe(120);

    const { container } = render(<ToastStack />);
    act(() => void showToast("Archived"));
    expect((container.firstElementChild as HTMLElement).style.bottom).toBe("120px");
  });

  it("sits on the bottom safe area when there is no composer", () => {
    expect(composerClearance()).toBe(0);
    const { container } = render(<ToastStack />);
    act(() => {
      showThreadUndoNotice({ action: "Settled", threadId: "t1", undo: async () => {} });
    });
    expect((container.firstElementChild as HTMLElement).style.bottom).toBe("");
    expect(screen.getByRole("button", { name: "Undo" })).toHaveClass("pointer-coarse:min-h-11");
  });
});

describe("toast actions", () => {
  it("runs the action once, dismisses the toast and leaves the body tap alone", () => {
    const open = vi.fn();
    render(<ToastStack />);
    act(() => void showToast("Fix the build needs you", "info", { action: { label: "Open", onClick: open } }));
    const button = screen.getByRole("button", { name: "Open" });
    expect(button).toHaveClass("pointer-coarse:min-h-11");
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Fix the build needs you")).toBeNull();
  });

  it("a keyed toast replaces the live toast of that key", () => {
    render(<ToastStack />);
    act(() => void showToast("A needs you", "info", { key: "alert:a" }));
    act(() => void showToast("B needs you", "info", { key: "alert:b" }));
    act(() => void showToast("A finished", "info", { key: "alert:a" }));
    expect(screen.queryByText("A needs you")).toBeNull();
    expect(screen.getByText("A finished")).toBeInTheDocument();
    expect(screen.getByText("B needs you")).toBeInTheDocument();
  });

  it("keeps an action toast up longer than a plain one", () => {
    vi.useFakeTimers();
    try {
      render(<ToastStack />);
      act(() => {
        showToast("plain");
        showToast("with action", "info", { action: { label: "Open", onClick: () => {} } });
      });
      act(() => void vi.advanceTimersByTime(MESSAGE_TOAST_MS + 1));
      expect(screen.queryByText("plain")).toBeNull();
      expect(screen.getByText("with action")).toBeInTheDocument();
      act(() => void vi.advanceTimersByTime(ACTION_TOAST_MS));
      expect(screen.queryByText("with action")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("swipe to dismiss", () => {
  it("decides on distance, either way", () => {
    expect(swipeDismisses(SWIPE_DISMISS_PX - 1)).toBe(false);
    expect(swipeDismisses(SWIPE_DISMISS_PX)).toBe(true);
    expect(swipeDismisses(-SWIPE_DISMISS_PX)).toBe(true);
  });

  const drag = (el: HTMLElement, from: [number, number], to: [number, number]) => {
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: "touch", clientX: from[0], clientY: from[1] });
    fireEvent.pointerMove(el, { pointerId: 1, pointerType: "touch", clientX: to[0], clientY: to[1] });
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: "touch", clientX: to[0], clientY: to[1] });
  };

  it("a long horizontal touch drag dismisses", () => {
    render(<ToastStack />);
    act(() => void showToast("Swipe me"));
    drag(screen.getByRole("status"), [20, 100], [20 + SWIPE_DISMISS_PX + 20, 102]);
    expect(screen.queryByText("Swipe me")).toBeNull();
  });

  it("a short drag springs back, and a vertical one is left to the page", () => {
    render(<ToastStack />);
    act(() => void showToast("Stay"));
    const toast = screen.getByRole("status");
    drag(toast, [20, 100], [40, 100]);
    expect(screen.getByText("Stay")).toBeInTheDocument();
    expect(toast.style.transform).toBe("");
    drag(toast, [20, 100], [30, 260]);
    expect(screen.getByText("Stay")).toBeInTheDocument();
  });

  it("a mouse drag does not dismiss", () => {
    render(<ToastStack />);
    act(() => void showToast("Mouse"));
    const toast = screen.getByRole("status");
    fireEvent.pointerDown(toast, { pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 0 });
    fireEvent.pointerMove(toast, { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 0 });
    fireEvent.pointerUp(toast, { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 0 });
    expect(screen.getByText("Mouse")).toBeInTheDocument();
  });
});
