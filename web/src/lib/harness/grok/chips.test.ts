import { describe, expect, it } from "vitest";

import { chipCarriesSend, isImageChipOnly } from "./chips";

const PATH = String.raw`C:\Users\me\AppData\Local\sightr\uploads\w1_p1-abc-12345678.png`;
const UNIX = "/tmp/sightr/uploads/shot.jpg";

describe("chipCarriesSend — the collapsed shapes", () => {
  it("accepts a path-only send that Grok chipped", () => {
    expect(chipCarriesSend(PATH, "[Image #1]")).toBe(true);
    expect(chipCarriesSend(UNIX, "[Image #7]")).toBe(true);
  });

  it("accepts caption + path, chip first or last", () => {
    expect(chipCarriesSend(`look at this ${PATH}`, "[Image #1] look at this")).toBe(true);
    expect(chipCarriesSend(`look at this ${PATH}`, "look at this [Image #1]")).toBe(true);
  });

  it("accepts a wrap that space-joined mid-token", () => {
    expect(chipCarriesSend(PATH, "[Image #1 ]")).toBe(true);
    expect(chipCarriesSend(PATH, "[Ima ge #1]")).toBe(true);
  });

  it("accepts two chips when the send had two image paths", () => {
    expect(chipCarriesSend(`see ${PATH} and ${UNIX}`, "see [Image #1] and [Image #2]")).toBe(true);
  });
});

describe("chipCarriesSend — rejections (the guard stays shut)", () => {
  it("rejects a chip when the send had no image path", () => {
    expect(chipCarriesSend("hello", "[Image #1]")).toBe(false);
    expect(chipCarriesSend("https://example.com/photo", "[Image #1]")).toBe(false);
  });

  it("rejects a chip count the send could not have produced", () => {
    expect(chipCarriesSend(PATH, "[Image #1] [Image #2]")).toBe(false);
  });

  it("rejects literal text beside the chip that we never typed", () => {
    expect(chipCarriesSend(PATH, "[Image #1] rm -rf the wrong thing")).toBe(false);
  });

  it("rejects a relative filename with no path separator", () => {
    expect(chipCarriesSend("shot.png", "[Image #1]")).toBe(false);
  });

  it("rejects a draft with no chip at all", () => {
    expect(chipCarriesSend(PATH, PATH)).toBe(false);
    expect(chipCarriesSend(PATH, "")).toBe(false);
  });
});

describe("isImageChipOnly", () => {
  it("is true for one or more chips and nothing else", () => {
    expect(isImageChipOnly("[Image #1]")).toBe(true);
    expect(isImageChipOnly("[Image #1] [Image #2]")).toBe(true);
    expect(isImageChipOnly("[Ima ge #1]")).toBe(true);
  });

  it("is false when any literal text sits beside the chip", () => {
    expect(isImageChipOnly("[Image #1] look at this")).toBe(false);
    expect(isImageChipOnly("hello")).toBe(false);
    expect(isImageChipOnly("")).toBe(false);
  });
});
