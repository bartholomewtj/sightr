// Tests for the ported MarkdownCodeBlock.logic.ts (T3 Code apps/web/src/components/chat/
// MarkdownCodeBlock.logic.ts @ 688ee52f0e8f, MIT, see THIRD_PARTY.md). T3 ships no test for this
// module, so these cases cover the pure helpers directly.

import { createElement, Fragment } from "react";
import { describe, expect, it } from "vitest";

import {
  createHighlightCacheKey,
  extractFenceLanguage,
  extractFenceTitle,
  isClosedCodeFence,
  nodeToPlainText,
} from "./MarkdownCodeBlock.logic.ts";

describe("extractFenceLanguage", () => {
  it("reads the language class react-markdown emits", () => {
    expect(extractFenceLanguage("language-ts")).toBe("ts");
    expect(extractFenceLanguage("hljs language-python")).toBe("python");
  });

  it("maps gitignore to ini, which Shiki does bundle", () => {
    expect(extractFenceLanguage("language-gitignore")).toBe("ini");
  });

  it("falls back to text when no language class is present", () => {
    expect(extractFenceLanguage(undefined)).toBe("text");
    expect(extractFenceLanguage("")).toBe("text");
  });
});

describe("extractFenceTitle", () => {
  it("reads a quoted title attribute", () => {
    expect(extractFenceTitle('title="x.ts"')).toBe("x.ts");
  });

  it("accepts a bare filename token in the meta", () => {
    expect(extractFenceTitle("path/to/file.ts")).toBe("path/to/file.ts");
    expect(extractFenceTitle("ts twoslash path/to/file.ts")).toBe("path/to/file.ts");
  });

  it("returns null when the meta carries no filename", () => {
    expect(extractFenceTitle(undefined)).toBeNull();
    expect(extractFenceTitle("")).toBeNull();
    expect(extractFenceTitle("ts twoslash")).toBeNull();
  });
});

describe("isClosedCodeFence", () => {
  const fence = "```ts\nconst value = 1;\n```\n";

  it("is true when the source carries a matching closing fence", () => {
    expect(
      isClosedCodeFence(
        { position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 3, column: 4, offset: fence.trimEnd().length } } } as never,
        fence,
        "const value = 1;\n",
      ),
    ).toBe(true);
  });

  it("is false when the fence is never closed", () => {
    const unclosed = fence.slice(0, -4);
    expect(
      isClosedCodeFence(
        { position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 2, column: 18, offset: unclosed.length } } } as never,
        unclosed,
        "const value = 1;\n",
      ),
    ).toBe(false);
  });

  it("is false without source positions", () => {
    expect(isClosedCodeFence(undefined, fence, "const value = 1;\n")).toBe(false);
    expect(isClosedCodeFence({} as never, fence, "const value = 1;\n")).toBe(false);
  });
});

describe("nodeToPlainText", () => {
  it("flattens strings, numbers, arrays and elements", () => {
    expect(nodeToPlainText("plain")).toBe("plain");
    expect(nodeToPlainText(42)).toBe("42");
    expect(nodeToPlainText(null)).toBe("");
    expect(nodeToPlainText(["a", 1, null, undefined])).toBe("a1");
  });

  it("recurses into element children", () => {
    expect(nodeToPlainText(createElement("span", null, "a", createElement("em", null, "b")))).toBe(
      "ab",
    );
    expect(
      nodeToPlainText(createElement(Fragment, null, "x", createElement("i", null, 7))),
    ).toBe("x7");
  });
});

describe("createHighlightCacheKey", () => {
  it("keys on the code hash, length, language and theme", () => {
    const key = createHighlightCacheKey("const value = 1;\n", "ts", "dark");
    // fnv1a32("const value = 1;\n") in base36, plus the code length, language and theme.
    expect(key).toBe("qrtnsk:17:ts:dark");
  });

  it("is stable across calls and varies with the inputs", () => {
    expect(createHighlightCacheKey("a", "ts", "light")).toBe(
      createHighlightCacheKey("a", "ts", "light"),
    );
    expect(createHighlightCacheKey("a", "ts", "light")).not.toBe(
      createHighlightCacheKey("b", "ts", "light"),
    );
  });
});
