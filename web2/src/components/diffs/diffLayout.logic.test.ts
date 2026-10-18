import { describe, expect, it } from "vitest";

import { effectiveDiffLayout, splitAvailable } from "./diffLayout.logic";

describe("splitAvailable", () => {
  it("needs the desktop layout and a column of 640 px", () => {
    expect(splitAvailable({ layout: "desktop", columnPx: 640, showingSplit: false })).toBe(true);
    expect(splitAvailable({ layout: "desktop", columnPx: 639, showingSplit: false })).toBe(false);
    expect(splitAvailable({ layout: "desktop", columnPx: 1200, showingSplit: false })).toBe(true);
  });

  it("a phone never gets split, however wide the column measures (1023 px is a phone, 1024 a desktop)", () => {
    expect(splitAvailable({ layout: "phone", columnPx: 1023, showingSplit: false })).toBe(false);
    expect(splitAvailable({ layout: "phone", columnPx: 2000, showingSplit: true })).toBe(false);
    expect(splitAvailable({ layout: "desktop", columnPx: 1024, showingSplit: false })).toBe(true);
  });

  it("a stacked view needs the full 640 px: at 630 there is no toggle", () => {
    expect(splitAvailable({ layout: "desktop", columnPx: 630, showingSplit: false })).toBe(false);
    expect(splitAvailable({ layout: "desktop", columnPx: 624, showingSplit: false })).toBe(false);
  });

  it("keeps a showing split until the column drops below 624 px", () => {
    expect(splitAvailable({ layout: "desktop", columnPx: 639, showingSplit: true })).toBe(true);
    expect(splitAvailable({ layout: "desktop", columnPx: 624, showingSplit: true })).toBe(true);
    expect(splitAvailable({ layout: "desktop", columnPx: 623, showingSplit: true })).toBe(false);
  });
});

describe("effectiveDiffLayout", () => {
  it("shows the stored choice only where split is available", () => {
    expect(effectiveDiffLayout("split", true)).toBe("split");
    expect(effectiveDiffLayout("split", false)).toBe("stacked");
    expect(effectiveDiffLayout("stacked", true)).toBe("stacked");
  });
});
