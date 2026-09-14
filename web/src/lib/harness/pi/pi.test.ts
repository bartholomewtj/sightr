import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { describeAdapterConformance } from "../conformance";
import { piAdapter } from "./index";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

const allFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.endsWith(".txt"))
  .sort();

const allPiFixtures = allFixtures.filter((f) => f.startsWith("pi--"));
const foreignFixtures = allFixtures.filter(
  (f) =>
    f.startsWith("claude--") ||
    f.startsWith("grok--") ||
    f.startsWith("agy--") ||
    f.startsWith("cursor--"),
);

const neutralFixtures = ["pi--ask-wizard-submit.txt"];
const ownFixtures = allPiFixtures.filter((f) => !neutralFixtures.includes(f));

describeAdapterConformance(piAdapter, {
  ownFixtures,
  foreignFixtures,
  neutralFixtures,
});

describe("piAdapter metadata and capabilities", () => {
  it("claims agent 'pi' and replyOneShot is true", () => {
    expect(piAdapter.agent).toBe("pi");
    expect(piAdapter.replyOneShot).toBe(true);
  });

  it("extractInputDraft returns null and extractStatusLines returns [] on pi--ask-radio.txt", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "pi--ask-radio.txt"), "utf8")));
    expect(piAdapter.extractInputDraft(lines)).toBeNull();
    expect(piAdapter.extractStatusLines(lines)).toEqual([]);
  });
});
