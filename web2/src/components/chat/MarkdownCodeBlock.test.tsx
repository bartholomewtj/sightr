// Sightr's own test for the `pre` renderer (T35; T3 Code
// apps/web/src/components/chat/MarkdownCodeBlock.tsx @ 688ee52f0e8f, MIT, THIRD_PARTY.md).
// The markdown goes through the real react-markdown, so the fences carry real hast nodes with
// positions; `source` is what the host passes so a half-streamed fence stays plain.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it, vi } from "vitest";

import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

// Pele never runs in jsdom (it measures text); a stub renderer keeps the mermaid branch testable.
vi.mock("pele/lazy", () => ({
  detectType: () => "flowchart",
  load: async () => true,
  render: () => ({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>',
    width: 40,
    height: 20,
    links: [],
    type: "flowchart",
    mermaidType: "flowchart",
  }),
}));

function renderMarkdown(text: string) {
  const components: Components = {
    pre: (props) => <MarkdownCodeBlock {...props} source={text} />,
  };
  return render(
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>,
  );
}

const TS = "```ts\nconst answer: number = 42;\n```";
const MERMAID = "```mermaid\nflowchart TD\n  A --> B\n```";
const UNCLOSED = "```ts\nconst answer: number = 42;";

describe("MarkdownCodeBlock", () => {
  it("highlights a ts fence into spans and keeps the code as its text", async () => {
    const { container } = renderMarkdown(TS);
    const frame = container.querySelector("[data-language='ts']") as HTMLElement;
    expect(frame).not.toBeNull();
    // The fence has no title, so the language names the header.
    expect(frame.querySelector(".chat-markdown-codeblock-header")).toHaveTextContent("ts");
    expect(container.querySelector("pre > code")).toHaveTextContent("const answer: number = 42;");

    await waitFor(() =>
      expect(container.querySelector("pre > code [class*='hljs-']")).not.toBeNull(),
    );
    const code = container.querySelector("pre > code") as HTMLElement;
    expect(code.textContent).toBe("const answer: number = 42;");
    // Copy hands over the plain source, not the highlighted markup.
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });

  it("shows the fence title when the author gave one", () => {
    const { container } = renderMarkdown('```ts title="src/app.ts"\nconst a = 1;\n```');
    expect(container.querySelector(".chat-markdown-codeblock-header")).toHaveTextContent(
      "src/app.ts",
    );
  });

  it("leaves an unclosed fence plain while it streams", async () => {
    const { container } = renderMarkdown(UNCLOSED);
    // Let the highlighter chunk load, so this is not vacuous.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const code = container.querySelector("pre > code") as HTMLElement;
    expect(code).not.toBeNull();
    expect(code.querySelector("[class*='hljs-']")).toBeNull();
    expect(code.textContent).toBe("const answer: number = 42;");
  });

  it("draws a mermaid fence as a diagram, with Show code to get the source back", async () => {
    const { container } = renderMarkdown(MERMAID);
    expect(screen.getByRole("button", { name: "Show code" })).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelector("[data-markdown-mermaid] svg")).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show code" }));
    expect(screen.getByRole("button", { name: "Show diagram" })).toBeInTheDocument();
    expect(container.querySelector("[data-language='mermaid'] pre > code")).toHaveTextContent(
      "flowchart TD",
    );
  });
});
