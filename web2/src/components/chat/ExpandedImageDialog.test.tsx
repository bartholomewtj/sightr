import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ExpandedImageDialog, SWIPE_PX, swipeDirection, wrapExpandedImageIndex } from "./ExpandedImageDialog";

describe("ExpandedImageDialog helpers", () => {
  it("wraps the index both ways (T3's rule)", () => {
    expect(wrapExpandedImageIndex(-1, 3)).toBe(2);
    expect(wrapExpandedImageIndex(3, 3)).toBe(0);
    expect(wrapExpandedImageIndex(4, 3)).toBe(1);
    expect(wrapExpandedImageIndex(5, 0)).toBe(0);
  });

  it("a long, mostly sideways swipe changes the image; anything else does not", () => {
    expect(swipeDirection(-SWIPE_PX, 0)).toBe(1);
    expect(swipeDirection(SWIPE_PX + 10, 5)).toBe(-1);
    expect(swipeDirection(SWIPE_PX - 1, 0)).toBeNull();
    expect(swipeDirection(80, 60)).toBeNull();
  });
});

describe("ExpandedImageDialog", () => {
  const preview = { images: [{ src: "blob:a", name: "a.png" }, { src: "blob:b", name: "b.png" }, { src: null, name: "c.png" }], index: 0 };

  it("pages with the buttons and the arrow keys, says when an image is gone, and closes", () => {
    const onClose = vi.fn();
    render(<ExpandedImageDialog preview={preview} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("a.png (1/3)")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Next image" }));
    expect(within(dialog).getByText("b.png (2/3)")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(within(dialog).getByText("c.png (3/3)")).toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Image unavailable");
    fireEvent.click(within(dialog).getByRole("button", { name: "Previous image" }));
    expect(within(dialog).getByText("b.png (2/3)")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("one image: no paging buttons", () => {
    render(<ExpandedImageDialog preview={{ images: [{ src: "blob:a", name: "a.png" }], index: 0 }} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
    expect(screen.getByText("a.png")).toBeInTheDocument();
  });
});
