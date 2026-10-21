import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setViewportWidth } from "@/test/media";

import ChatMarkdown from "./ChatMarkdown";
import { OpenFileThreadContext } from "./right-panel/OpenFileLink";

afterEach(() => {
  vi.restoreAllMocks();
  setViewportWidth(800);
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

  it("copies through execCommand where the Clipboard API is missing", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    let copied = "";
    const execCommand = vi.fn((command: string) => {
      copied = command === "copy" ? (document.querySelector<HTMLTextAreaElement>("textarea[readonly]")?.value ?? "") : "";
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    render(<ChatMarkdown text={"```\nnpm test\n```"} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    });
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(copied).toBe("npm test");
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
    Reflect.deleteProperty(document, "execCommand");
  });

  it("wraps code on a phone-width viewport and toggles it with Wrap lines", () => {
    setViewportWidth(390);
    const { container } = render(<ChatMarkdown text={"```sh\necho a-very-long-line\n```"} />);
    const frame = container.querySelector(".chat-markdown-codeblock")!;
    expect(frame.getAttribute("data-wrap")).toBe("true");
    expect(container.querySelector("pre")?.className).toContain("whitespace-pre-wrap");
    // The header (language, actions) is not searched by find.
    expect(container.querySelector(".chat-markdown-codeblock-header")?.hasAttribute("data-thread-find-ignore")).toBe(true);
    const toggle = screen.getByRole("button", { name: "Disable line wrap" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(frame.getAttribute("data-wrap")).toBe("false");
    expect(container.querySelector("pre")?.className ?? "").not.toContain("whitespace-pre-wrap");
    expect(screen.getByRole("button", { name: "Wrap lines" })).toHaveAttribute("aria-pressed", "false");
  });

  it("starts code unwrapped on a wide viewport", () => {
    setViewportWidth(1280);
    const { container } = render(<ChatMarkdown text={"```\nx\n```"} />);
    expect(container.querySelector(".chat-markdown-codeblock")?.getAttribute("data-wrap")).toBe("false");
  });

  it("renders GFM tables in a scroll container", () => {
    const { container } = render(<ChatMarkdown text={"| a | b |\n|---|---|\n| 1 | 2 |"} />);
    expect(container.querySelector(".chat-markdown-table-container table")).not.toBeNull();
  });
});

describe("ChatMarkdown (T35/T36)", () => {
  it("typesets inline and display math with KaTeX", () => {
    const { container } = render(<ChatMarkdown text={"Inline $x^2$ and:\n\n$$\ny = mx + b\n$$"} />);
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the raw TeX when KaTeX cannot parse the formula", () => {
    const { container } = render(<ChatMarkdown text={"$\\frac{1}{$"} />);
    expect(container.textContent).toContain("\\frac");
  });

  it("tags a GitHub alert blockquote", () => {
    const { container } = render(<ChatMarkdown text={"> [!WARNING]\n> careful"} />);
    expect(container.querySelector("blockquote[data-alert='warning']")).not.toBeNull();
  });

  it("renders a mermaid fence as a diagram block with a Show code toggle", () => {
    const { container } = render(<ChatMarkdown text={"```mermaid\ngraph TD;A-->B;\n```"} />);
    expect(container.querySelector("[data-language='mermaid']")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Show code" })).toBeInTheDocument();
  });

  it("renders an embedded https image as lazy media", () => {
    const { container } = render(<ChatMarkdown text={"![shot](https://example.com/shot.png)"} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("opens a workspace-path link as a file chip inside a thread", () => {
    render(
      <OpenFileThreadContext.Provider value="thread-1">
        <ChatMarkdown text={"[main.go](web2/src/main.go)"} />
      </OpenFileThreadContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "main.go" })).toBeInTheDocument();
  });

  it("keeps a workspace-path link as text outside a thread", () => {
    const { container } = render(<ChatMarkdown text={"[main.go](web2/src/main.go)"} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("main.go");
  });
});
