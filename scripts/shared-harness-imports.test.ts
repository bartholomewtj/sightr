import { describe, expect, test } from "bun:test";

import { forbiddenImports, HARNESS_DIR, isAllowedSpecifier } from "./shared-harness-imports.ts";

describe("shared/harness is React-free and alias-free", () => {
  test("the rule allows relative paths and builtins, and refuses packages and aliases", () => {
    for (const ok of ["./blocks", "../scan", "../../wire", "node:fs", "bun:test"]) {
      expect(isAllowedSpecifier(ok)).toBe(true);
    }
    for (const bad of ["react", "react-dom", "@shared/wire", "@/lib/blocks", "@v1/components/x", "katex", "zod"]) {
      expect(isAllowedSpecifier(bad)).toBe(false);
    }
  });

  test("every import under shared/harness/ is relative, node: or bun:", () => {
    expect(forbiddenImports(HARNESS_DIR)).toEqual([]);
  });
});
