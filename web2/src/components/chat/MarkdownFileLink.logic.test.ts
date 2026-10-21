// Sightr's own test for the ported `resolveMarkdownFileLinkMeta`
// (T3 Code apps/web/src/markdown-links.ts @ 688ee52f0e8f, MIT, see THIRD_PARTY.md).
import { describe, expect, it } from "vitest";

import { resolveMarkdownFileLinkMeta } from "./MarkdownFileLink.logic";

describe("resolveMarkdownFileLinkMeta", () => {
  it("resolves a relative path against the thread's cwd", () => {
    const meta = resolveMarkdownFileLinkMeta("src/main.ts", "C:\\repo\\project");
    expect(meta).not.toBeNull();
    expect(meta?.filePath).toBe("C:\\repo\\project\\src\\main.ts");
    expect(meta?.basename).toBe("main.ts");
    expect(meta?.displayPath).toBe("project/src/main.ts");
    expect(meta?.workspaceRelativePath).toBe("src/main.ts");
  });

  it("resolves an absolute Windows path without a cwd", () => {
    const meta = resolveMarkdownFileLinkMeta("C:/Users/jane/project/notes.md");
    expect(meta?.filePath).toBe("C:/Users/jane/project/notes.md");
    expect(meta?.basename).toBe("notes.md");
    expect(meta?.workspaceRelativePath).toBeNull();
  });

  it("parses a :line in the href", () => {
    const meta = resolveMarkdownFileLinkMeta("src/main.ts:12", "C:\\repo\\project");
    expect(meta?.line).toBe(12);
    expect(meta?.targetPath).toBe("C:\\repo\\project\\src\\main.ts:12");
    expect(meta?.displayPath).toBe("project/src/main.ts:12");
  });

  it("returns null for a plain https url", () => {
    expect(resolveMarkdownFileLinkMeta("https://example.com/docs")).toBeNull();
  });
});
