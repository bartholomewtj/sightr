import { describe, expect, it } from "vitest";

import { optionSurface } from "./option-button";

// Spec 01: a dialog option is the one intended tap on a blocked pane, so every tone keeps the 44px
// minimum that Yes/No and the header controls already use.
describe("optionSurface", () => {
  it.each(["default", "selected", "busy"] as const)("gives a %s row a 44px minimum height", (tone) => {
    expect(optionSurface(tone).split(" ")).toContain("min-h-11");
  });
});
