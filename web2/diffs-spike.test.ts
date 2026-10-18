import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DIFF_ADAPTERS, diffsAdapter, diffsAlias, diffsInputs } from "./diffs-spike.ts";

const root = import.meta.dirname;
const adapterFile = (name: string) => resolve(root, "src/components/diffs/adapters", `${name}.tsx`).split("\\").join("/");

describe("SIGHTR_DIFFS (the T25 spike switch)", () => {
  it("is the hand adapter with no page when unset (T27 flipped the default), so a normal build has no measurement page", () => {
    expect(diffsAdapter({})).toBe("hand");
    expect(diffsAdapter({ SIGHTR_DIFFS: "  " })).toBe("hand");
    expect(diffsAlias(root, {}).replacement).toBe(adapterFile("hand"));
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
    expect(tsconfig).toContain(`"diffs-adapter": ["./src/components/diffs/adapters/hand.tsx"]`);
    expect(tsconfig).toContain("src/components/diffs/adapters/pierre.tsx"); // the one candidate whose package is not installed
    for (const f of ["hand.tsx", "hand.highlight.ts"]) expect(tsconfig).not.toMatch(new RegExp(`"exclude".*${f}`));
  });
});
