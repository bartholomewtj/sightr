import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { cursorAdapter } from "./index";
import { isPastePlaceholderOnly, pasteCarriesSend } from "./paste";

// Spec 19: Cursor collapses a long paste like Claude, but `+M lines` counts lines, not newlines
// (live-probed 2026-09-27: a 15-line paste showed `+15 lines`, one long line `+1 lines`).

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${String(i + 1).padStart(2, "0")}: the quick brown fox`).join("\n");
const longLine = "A long single line send for the tail probe ".repeat(20);

describe("cursor pasteCarriesSend", () => {
  it("accepts a fully collapsed multi-line send whose token counts its lines", () => {
    expect(pasteCarriesSend(lines(15), "[Pasted text #3 +15 lines]")).toBe(true);
  });

  it("accepts a long single line as `+1 lines`", () => {
    expect(pasteCarriesSend(longLine, "[Pasted text #4 +1 lines]")).toBe(true);
  });

  it("rejects a token whose line count is not this send's", () => {
    expect(pasteCarriesSend(lines(15), "[Pasted text #3 +14 lines]")).toBe(false);
    expect(pasteCarriesSend(lines(15), "[Pasted text #3 +16 lines]")).toBe(false);
  });

  it("rejects a stale token for a short send that Cursor would have typed literally", () => {
    expect(pasteCarriesSend("short reply", "[Pasted text #1 +1 lines]")).toBe(false);
  });

  it("accepts a chunk-split send: two tokens whose lines sum to newlines + chunks", () => {
    // "L1\nL2\nL3" split mid-line into two pastes: +2 and +2 → 2 newlines.
    expect(pasteCarriesSend(lines(3), "[Pasted text #1 +2 lines][Pasted text #2 +2 lines]")).toBe(true);
  });

  it("knows a token-only draft is opaque", () => {
    expect(isPastePlaceholderOnly("[Pasted text #3 +15 lines]")).toBe(true);
    expect(isPastePlaceholderOnly("[Pasted text #3 +15 lines] and more")).toBe(false);
  });
});

describe("cursor adapter on a live paste capture", () => {
  const screen = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "cursor--draft-paste-placeholder.txt"), "utf8")));

  it("reads the token as the draft and accepts it as evidence for the 15-line send", () => {
    const draft = cursorAdapter.extractInputDraft(screen);
    expect(draft).toContain("[Pasted text #3 +15 lines]");
    expect(cursorAdapter.draftCarriesSend!(lines(15), draft!)).toBe(true);
    expect(cursorAdapter.draftIsOpaque!(draft!)).toBe(true);
  });
});
