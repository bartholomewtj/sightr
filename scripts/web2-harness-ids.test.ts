import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { harnessIdHits, ID_COMPARE, ID_LITERAL, WEB2_SRC } from "./web2-harness-ids.ts";

describe("web2 reads capabilities, not harness ids", () => {
  test("the patterns catch what they are for", () => {
    expect(ID_LITERAL.test(`if (thread.harness === "claude") {`)).toBe(true);
    expect(ID_LITERAL.test(`case 'pi':`)).toBe(true);
    expect(ID_COMPARE.test(`thread.harness === h`)).toBe(true);
    expect(ID_COMPARE.test(`switch (thread.agent) {`)).toBe(true);
    expect(ID_LITERAL.test(`"pilot"`)).toBe(false);
    expect(ID_COMPARE.test(`thread.capabilities.canSwitchModel`)).toBe(false);
  });

  test.skipIf(!existsSync(WEB2_SRC))("no harness id literals or comparisons in web2/src", () => {
    expect(harnessIdHits(WEB2_SRC)).toEqual([]);
  });
});
