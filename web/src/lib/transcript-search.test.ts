import { splitHighlight } from "./transcript-search";

// Find-in-history exists because a PWA has no browser find; the highlight splitter is what marks
// each hit inside a turn.

describe("splitHighlight", () => {
  it("splits around a single hit", () => {
    expect(splitHighlight("the guard rails", "guard")).toEqual([
      { text: "the ", hit: false },
      { text: "guard", hit: true },
      { text: " rails", hit: false },
    ]);
  });

  it("marks every occurrence", () => {
    expect(splitHighlight("aXbXc", "x").filter((p) => p.hit)).toHaveLength(2);
  });

  it("preserves the original casing of a hit", () => {
    expect(splitHighlight("GUARD", "guard")).toEqual([{ text: "GUARD", hit: true }]);
  });

  it("handles a hit at the very start and end", () => {
    expect(splitHighlight("abc", "abc")).toEqual([{ text: "abc", hit: true }]);
  });

  it.each([
    ["an empty query", "some text", ""],
    ["no match", "some text", "zzz"],
    ["empty text", "", "q"],
  ])("returns one unmarked piece for %s", (_l, text, query) => {
    expect(splitHighlight(text, query)).toEqual([{ text, hit: false }]);
  });

  it("reassembles to the original string exactly", () => {
    const src = "Deploy the GUARD, then guard again";
    expect(splitHighlight(src, "guard").map((p) => p.text).join("")).toBe(src);
  });
});
