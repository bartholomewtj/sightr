// Ported from T3 Code apps/web/src/markdownListIndentation.test.tsx @ 688ee52f0e8f (MIT, see THIRD_PARTY.md).
// Changes: the five cases assert on the transformed mdast (unified + remark-parse + remark-gfm)
// instead of rendered React markup — `code` nodes stand in for `<pre>` — so no react-dom /
// react-markdown is needed; vitest stands in for vite-plus/test.

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import { remarkNormalizeListItemIndentation } from "./markdownListIndentation.ts";

interface AstNode {
  type: string;
  value?: unknown;
  lang?: unknown;
  url?: unknown;
  children?: AstNode[];
}

function parse(markdown: string): AstNode {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkNormalizeListItemIndentation);
  const tree = processor.parse(markdown) as unknown as AstNode;
  // The normalizer reads `file.value` (the original markdown), so pass the source through.
  return processor.runSync(tree as never, markdown) as unknown as AstNode;
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    walk(child, visit);
  }
}

function findNodes(node: AstNode, type: string): AstNode[] {
  const found: AstNode[] = [];
  walk(node, (candidate) => {
    if (candidate.type === type) found.push(candidate);
  });
  return found;
}

function collectText(node: AstNode): string {
  // react-markdown renders a raw `html` node as literal text (no rehype-raw), so fold it in here
  // too — that is what the upstream HTML assertions saw for `<redacted>`.
  const parts: string[] = [];
  walk(node, (candidate) => {
    if (
      (candidate.type === "text" || candidate.type === "html") &&
      typeof candidate.value === "string"
    ) {
      parts.push(candidate.value);
    }
  });
  return parts.join("");
}

function listItemTexts(tree: AstNode): string[] {
  return findNodes(tree, "listItem").map((item) => collectText(item));
}

describe("remarkNormalizeListItemIndentation", () => {
  it("renders same-line over-indented list content as list text", () => {
    const tree = parse(`why did you do this?

-       for (const step of rest.steps) {
-           if (step.request.body) {
-               step.request.body = "<redacted>";
-           }
-       }`);

    expect(findNodes(tree, "code")).toEqual([]);
    const items = listItemTexts(tree);
    expect(items).toContain("for (const step of rest.steps) {");
    expect(items).toContain("if (step.request.body) {");
    expect(items).toContain('step.request.body = "<redacted>";');
  });

  it("preserves every recovered block separated by blank lines", () => {
    const tree = parse(`-       **first block**

        [second block](https://example.com)`);

    const strong = findNodes(tree, "strong");
    expect(strong).toHaveLength(1);
    expect(collectText(strong[0]!)).toBe("first block");

    const links = findNodes(tree, "link");
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe("https://example.com");
    expect(collectText(links[0]!)).toBe("second block");
  });

  it("recursively normalizes lists in recovered tail blocks", () => {
    const tree = parse(`-       first block

        -       nested block`);

    expect(findNodes(tree, "code")).toEqual([]);
    expect(listItemTexts(tree)).toContain("nested block");
  });

  it("preserves fenced code blocks within list items", () => {
    const tree = parse("- ```ts\n  const value = 1;\n  ```");

    const code = findNodes(tree, "code");
    expect(code).toHaveLength(1);
    expect(code[0]!.lang).toBe("ts");
    expect(String(code[0]!.value)).toBe("const value = 1;");
  });

  it("preserves indented code blocks that start below a list marker", () => {
    const tree = parse("-\n      const value = 1;");

    const code = findNodes(tree, "code");
    expect(code).toHaveLength(1);
    expect(String(code[0]!.value)).toContain("const value = 1;");
  });
});
