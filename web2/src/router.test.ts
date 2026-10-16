import { describe, expect, it } from "vitest";

import { basepathFor } from "./router";

describe("router basepath (T15)", () => {
  it("follows vite's base: / in production, /v2/ for the preview", () => {
    expect(basepathFor("/")).toBe("/");
    expect(basepathFor("/v2/")).toBe("/v2");
    expect(basepathFor("")).toBe("/");
  });
});
