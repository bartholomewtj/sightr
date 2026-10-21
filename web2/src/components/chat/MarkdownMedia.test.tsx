// Sightr's own test for its `<img>`/`<video>` frame
// (T36; T3 Code apps/web/src/components/chat/ChatMarkdownMedia.tsx @ 688ee52f0e8f, MIT, THIRD_PARTY.md).
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownMedia } from "./MarkdownMedia";

describe("MarkdownMedia", () => {
  it("renders an https image at max width, loaded lazily", () => {
    const { container } = render(
      <MarkdownMedia src="https://example.com/shot.png" alt="shot" />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://example.com/shot.png");
    expect(img).toHaveAttribute("alt", "shot");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
    expect(img).toHaveClass("max-w-full");
  });

  it("renders nothing for a file:// image, so the browser never fetches it", () => {
    const { container } = render(<MarkdownMedia src="file:///x.png" alt="x" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("renders an https video", () => {
    const { container } = render(<MarkdownMedia src="https://example.com/clip.mp4" />);
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("src", "https://example.com/clip.mp4");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(container.querySelector("img")).toBeNull();
  });
});
