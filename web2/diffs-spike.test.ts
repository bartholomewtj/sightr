import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DIFF_ADAPTERS, diffsAdapter, diffsAlias, diffsInputs } from "./diffs-spike.ts";

const root = import.meta.dirname;
const adapterFile = (name: string) => resolve(root, "src/components/diffs/adapters", `${name}.tsx`).split("\\").join("/");

describe("SIGHTR_DIFFS (the T25 spike switch)", () => {
  it("is the status adapter with no page when unset, so a normal build is untouched", () => {
    expect(diffsAdapter({})).toBe("status");
    expect(diffsAdapter({ SIGHTR_DIFFS: "  " })).toBe("status");
    expect(diffsAlias(root, {}).replacement).toBe(adapterFile("status"));
    expect(diffsInputs(root, {})).toBeUndefined();
  });

  it("points `diffs-adapter` at a candidate and adds the measurement page", () => {
    for (const name of DIFF_ADAPTERS) {
      expect(diffsAlias(root, { SIGHTR_DIFFS: name }).replacement).toBe(adapterFile(name));
      expect(Object.keys(diffsInputs(root, { SIGHTR_DIFFS: name }) ?? {})).toEqual(["main", "spike-diffs"]);
    }
    expect(existsSync(resolve(root, "spike-diffs.html"))).toBe(true);
  });

  it("leaves the page out for a size measurement", () => {
    expect(diffsInputs(root, { SIGHTR_DIFFS: "hand", SIGHTR_DIFFS_PAGE: "0" })).toBeUndefined();
    expect(diffsAlias(root, { SIGHTR_DIFFS: "hand", SIGHTR_DIFFS_PAGE: "0" }).replacement).toBe(adapterFile("hand"));
  });

  it("refuses an unknown adapter", () => {
    expect(() => diffsAdapter({ SIGHTR_DIFFS: "shiki" })).toThrow(/status, hand or pierre/);
    expect(() => diffsInputs(root, { SIGHTR_DIFFS: "nope" })).toThrow();
  });

  it("matches the tsconfig path the typecheck resolves `diffs-adapter` through", () => {
    const tsconfig = readFileSync(resolve(root, "tsconfig.json"), "utf8");
    expect(tsconfig).toContain(`"diffs-adapter": ["./src/components/diffs/adapters/status.tsx"]`);
    for (const f of ["pierre.tsx", "hand.tsx", "hand.highlight.ts"]) expect(tsconfig).toContain(`src/components/diffs/adapters/${f}`);
  });
});
