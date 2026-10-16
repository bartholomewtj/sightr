import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ChatMarkdown from "./ChatMarkdown";

afterEach(() => {
  vi.restoreAllMocks();
});

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

describe("ChatMarkdown (T11)", () => {
  it("shows raw HTML as text and never makes an element of it", () => {
    const { container } = render(<ChatMarkdown text={'Before <script>alert("x")</script> after <b>bold?</b>'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain('<script>alert("x")</script>');
    expect(container.textContent).toContain("<b>bold?</b>");
  });

  it("opens http(s) links in a new tab with rel noopener noreferrer", () => {
    render(<ChatMarkdown text="See [the docs](https://herdr.dev/docs) and https://example.com/x." />);
    const docs = screen.getByRole("link", { name: "the docs" });
    expect(docs).toHaveAttribute("href", "https://herdr.dev/docs");
    expect(docs).toHaveAttribute("target", "_blank");
    expect(docs).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "https://example.com/x" })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("does not link other schemes", () => {
    const { container } = render(<ChatMarkdown text="[click](javascript:alert(1)) and [file](C:/x.ts)" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("click");
  });

  it("renders a fenced code block in Consolas with a working Copy button", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard(writeText);
    const { container } = render(<ChatMarkdown text={"```ts\nconst a = 1;\n```"} />);
    expect(container.querySelector("[data-language='ts'] pre code")).toHaveTextContent("const a = 1;");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    });
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
  });

  it("says so when the clipboard refuses", async () => {
    setClipboard(async () => {
      throw new Error("denied");
    });
    render(<ChatMarkdown text={"```\nx\n```"} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't copy");
  });

  it("renders GFM tables in a scroll container", () => {
    const { container } = render(<ChatMarkdown text={"| a | b |\n|---|---|\n| 1 | 2 |"} />);
    expect(container.querySelector(".chat-markdown-table-container table")).not.toBeNull();
  });
});
