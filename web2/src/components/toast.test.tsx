import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { __resetThreadUndoNotice, showThreadUndoNotice } from "@/hooks/showThreadUndoNotice";

import { __resetToasts, composerClearance, showToast, ToastStack } from "./toast";

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
