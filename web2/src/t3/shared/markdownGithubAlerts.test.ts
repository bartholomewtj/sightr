// Ported from T3 Code apps/web/src/markdownGithubAlerts.test.tsx @ 688ee52f0e8f (MIT, see THIRD_PARTY.md).
// Changes: the three cases assert on the transformed mdast (unified + remark-parse + remark-gfm)
// instead of rendered React markup, so no react-dom/react-markdown is needed; vitest stands in for
// vite-plus/test.

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import { remarkGithubAlerts } from "./markdownGithubAlerts.ts";

interface AstNode {
  type: string;
  value?: unknown;
  lang?: unknown;
  url?: unknown;
  data?: { hProperties?: Record<string, unknown> };
  children?: AstNode[];
}

function parse(markdown: string): AstNode {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkGithubAlerts);
  const tree = processor.parse(markdown) as unknown as AstNode;
  return processor.runSync(tree as never) as unknown as AstNode;
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
  return findNodes(node, "text")
    .map((text) => text.value)
    .filter((value): value is string => typeof value === "string")
    .join("");
}

function findAlertValues(tree: AstNode): string[] {
  const alerts: string[] = [];
  walk(tree, (node) => {
    const alert = node.data?.hProperties?.dataAlert;
    if (typeof alert === "string") alerts.push(alert);
  });
  return alerts;
}

describe("remarkGithubAlerts", () => {
  it("keeps content that follows a marker-only paragraph", () => {
    const tree = parse("> [!WARNING]\n>\n> ### A heading\n>\n> And a paragraph.");

    expect(findAlertValues(tree)).toEqual(["warning"]);
    expect(collectText(tree)).not.toContain("[!WARNING]");
    expect(collectText(tree)).toContain("A heading");
    expect(collectText(tree)).toContain("And a paragraph.");
  });

  it("tags a quote whose next line opens with an inline node rather than text", () => {
    const tree = parse("> [!NOTE]\n> **Medium Risk** Changes live transcript routing.");

    expect(findAlertValues(tree)).toEqual(["note"]);
    expect(collectText(tree)).not.toContain("[!NOTE]");
    expect(findNodes(tree, "strong")).toHaveLength(1);
    expect(collectText(findNodes(tree, "strong")[0]!)).toBe("Medium Risk");
    expect(collectText(tree)).toContain("Changes live transcript routing.");
  });

  it("leaves a quote alone when the marker shares its line with anything else", () => {
    const tree = parse("> [!NOTE] an ordinary quote");

    expect(findAlertValues(tree)).toEqual([]);
    expect(collectText(tree)).toContain("[!NOTE] an ordinary quote");
  });
});
