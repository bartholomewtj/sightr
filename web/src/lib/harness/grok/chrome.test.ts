import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import {
  composerPrompt,
  composerReady,
  extractInputDraft,
  extractStatusLines,
  hasComposer,
  locateComposer,
  stripCanvasBackground,
  stripChrome,
} from "./chrome";
import { lineText } from "./markers";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function fixtureLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

const COMPOSER_FIXTURES = [
  "grok--done.txt",
  "grok--draft-single.txt",
  "grok--draft-wrapped.txt",
  "grok--fresh-idle.txt",
  "grok--prompt-ascii-draft.txt",
  "grok--prompt-ascii.txt",
  "grok--working.txt",
];

describe("locateComposer — the real corpus", () => {
  const PINNED: { fixture: string; top: number; bottom: number }[] = [
    { fixture: "grok--fresh-idle.txt", top: 19, bottom: 21 },
    { fixture: "grok--draft-single.txt", top: 19, bottom: 21 },
    { fixture: "grok--draft-wrapped.txt", top: 2, bottom: 5 },
    { fixture: "grok--working.txt", top: 3, bottom: 5 },
    { fixture: "grok--done.txt", top: 8, bottom: 10 },
    { fixture: "grok--prompt-ascii.txt", top: 3, bottom: 5 },
    { fixture: "grok--prompt-ascii-draft.txt", top: 3, bottom: 5 },
  ];

  it.each(PINNED)("$fixture locates the box", ({ fixture, top, bottom }) => {
    const box = locateComposer(fixtureLines(fixture));
    expect(box).not.toBeNull();
    expect(box!.top).toBe(top);
    expect(box!.bottom).toBe(bottom);
    expect(box!.firstDraftRow).toBe(top + 1);
    expect(box!.hintEnd).toBeGreaterThan(bottom);
  });

  it("covers every composer capture in the corpus", () => {
    expect(PINNED.map((p) => p.fixture).sort()).toEqual([...COMPOSER_FIXTURES].sort());
  });

  it("declines a square user-message bubble with no composer", () => {
    expect(locateComposer(fixtureLines("grok--user-bubble.txt"))).toBeNull();
    expect(hasComposer(fixtureLines("grok--user-bubble.txt"))).toBe(false);
  });
});

describe("stripChrome", () => {
  it("peels the composer and hint row, keeps the transcript", () => {
    const stripped = stripChrome(fixtureLines("grok--fresh-idle.txt"));
    const text = stripped.map(lineText).join("\n");
    expect(text).toContain("hello");
    expect(text).not.toContain("╭");
    expect(text).not.toContain("Ctrl+.:shortcuts");
    expect(text).not.toMatch(/Grok 4\.6/);
  });

  it("keeps a user bubble that sits ABOVE the composer", () => {
    const stripped = stripChrome(fixtureLines("grok--done.txt"));
    const text = stripped.map(lineText).join("\n");
    expect(text).toContain("hi");
    expect(text).toContain("┌");
    expect(text).not.toContain("╭");
  });

  it("does not eat a square user bubble when there is no composer", () => {
    const lines = fixtureLines("grok--user-bubble.txt");
    const stripped = stripChrome(lines);
    const text = stripped.map(lineText).join("\n");
    expect(text).toContain("hello from a user bubble");
    expect(text).toContain("┌");
    expect(locateComposer(lines)).toBeNull();
  });

  it("peels the live ASCII > composer and Ctrl+x hint row", () => {
    const stripped = stripChrome(fixtureLines("grok--prompt-ascii.txt"));
    const text = stripped.map(lineText).join("\n");
    expect(text).toContain("ASCII prompt");
    expect(text).not.toContain("╭");
    expect(text).not.toContain("Ctrl+x:shortcuts");
    expect(text).not.toMatch(/Grok 4\.6/);
  });
});

describe("extractStatusLines / extractInputDraft", () => {
  it("hoists the status out of the bottom border", () => {
    const rows = extractStatusLines(fixtureLines("grok--fresh-idle.txt"));
    expect(rows.map((r) => r.segments.map((s) => s.text).join("")).join("")).toBe(
      "Grok 4.6 (high) · always-approve",
    );
  });

  it("reads always-approve off the working frame", () => {
    const rows = extractStatusLines(fixtureLines("grok--working.txt"));
    expect(rows.map((r) => r.segments.map((s) => s.text).join("")).join("")).toMatch(/always-approve/);
  });

  it("an empty box has no draft", () => {
    expect(extractInputDraft(fixtureLines("grok--fresh-idle.txt"))).toBeNull();
    expect(extractInputDraft(fixtureLines("grok--working.txt"))).toBeNull();
  });

  it("recovers a one-line stranded draft", () => {
    expect(extractInputDraft(fixtureLines("grok--draft-single.txt"))).toBe("testing stuff");
  });

  it("recovers a draft from the live ASCII > prompt", () => {
    expect(extractInputDraft(fixtureLines("grok--prompt-ascii-draft.txt"))).toBe("hello from the phone");
    expect(extractInputDraft(fixtureLines("grok--prompt-ascii.txt"))).toBeNull();
  });

  it("folds a wrapped draft back into one line", () => {
    expect(extractInputDraft(fixtureLines("grok--draft-wrapped.txt"))).toBe(
      "This draft is long enough that Grok wraps it onto a continuation row inside the box rather than one line.",
    );
  });

  // Live 2026-09-07, pane w9C:p2: Grok paints a history/URL ghost as italic gray after the cursor
  // (`ESC[3m` + `38;2;128;128;128`) and prefixes the hint bar with `Tab/→:accept suggestion`. The
  // hint-bar token was already chrome; the italic tail was still joining into the draft, so a send
  // whose box showed our URL plus a completion never verified and never got Enter.
  it("drops an italic ghost tail so a URL send can still verify", () => {
    const screen = [
      "  ╭────────────────────────────────────────╮",
      "  │ > https://example.com\x1b[3m/extra/path\x1b[0m      │",
      "  ╰──────────────────── Grok 4.6 (high) ─╯",
      "",
      "  Tab/→:accept suggestion  │  Shift+Tab:mode  │  Ctrl+x:shortcuts",
    ].join("\n");
    expect(extractInputDraft(splitLines(parseAnsi(screen)))).toBe("https://example.com");
  });

  it("an empty box holding only an italic ghost is not a stranded draft", () => {
    const screen = [
      "  ╭────────────────────────────────────────╮",
      "  │ > \x1b[3mcontinue\x1b[0m                            │",
      "  ╰──────────────────── Grok 4.6 (high) ─╯",
      "",
      "  Tab/→:accept suggestion  │  Shift+Tab:mode  │  Ctrl+x:shortcuts",
    ].join("\n");
    expect(extractInputDraft(splitLines(parseAnsi(screen)))).toBeNull();
  });

  it("a torn user-bubble frame has neither status nor draft", () => {
    const lines = fixtureLines("grok--user-bubble.txt");
    expect(extractStatusLines(lines)).toEqual([]);
    expect(extractInputDraft(lines)).toBeNull();
  });

  it("plan-approval's Build anything placeholder is not a stranded draft", () => {
    expect(extractInputDraft(fixtureLines("grok--plan-approval.txt"))).toBeNull();
  });
});

describe("composerPrompt / hasComposer / composerReady", () => {
  it.each(COMPOSER_FIXTURES)("%s is ready for a phone reply", (fixture) => {
    const lines = fixtureLines(fixture);
    expect(hasComposer(lines)).toBe(true);
    expect(composerReady(lines)).toBe(true);
    expect(composerPrompt(lines)).toMatch(/[❯>]/);
  });

  it("refuses a frame with no composer", () => {
    expect(hasComposer(fixtureLines("grok--user-bubble.txt"))).toBe(false);
    expect(composerReady(fixtureLines("grok--user-bubble.txt"))).toBe(false);
    expect(composerPrompt(fixtureLines("grok--user-bubble.txt"))).toBeNull();
  });

  it("a bare > transcript row is not a composer", () => {
    const lines = splitLines(parseAnsi("some output\n> hello from a shell\n"));
    expect(locateComposer(lines)).toBeNull();
    expect(composerReady(lines)).toBe(false);
  });

  // Originally this refused, reading the chip as a torn frame; the live startup capture
  // (grok--startup.txt, 2026-08-22) proved the bare chip IS the under-box row of every fresh
  // session, and refusing it blocked the first phone message. Pure chip runs are chrome now.
  // Grok Build 1.0.13 paints `Grok Build  <semver> [stable]` on that same row (live 2026-08-31);
  // uncaptured mixing (`[waiting]`, a prefix, a trailing word) still refuses.
  // Live 2026-08-30 (w56:p7 screenshot): Grok paints a completion in the box and prefixes the
  // shortcut bar with `Tab/→:accept suggestion`. That token was missing from isComposerHint, so
  // locateComposer returned null on an ordinary writable screen and every phone send was refused.
  it("a Tab/→:accept suggestion footer is still a writable composer", () => {
    const screen = [
      "  ╭────────────────────────────────────────╮",
      "  │ > merge pr and update docs             │",
      "  ╰──────────────────── Grok 4.6 (high) ─╯",
      "",
      "  Tab/→:accept suggestion  │  Shift+Tab:mode  │  Ctrl+x:shortcuts",
    ].join("\n");
    const lines = splitLines(parseAnsi(screen));
    expect(locateComposer(lines)).not.toBeNull();
    expect(hasComposer(lines)).toBe(true);
    expect(composerReady(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBe("merge pr and update docs");
  });

  // Live 2026-09-18, Grok pane (phone screenshot): empty-box footer classified, send_text
  // landed, then Grok painted `Shift+Enter/Alt+Enter:newline` next to `Enter:send`. That
  // token was missing from isComposerHint, so locateComposer returned null on the
  // verification read, Enter was withheld, and the stall read "didn't reach the input box"
  // while the draft sat in a live composer.
  it("a Shift+Enter/Alt+Enter:newline footer is still a writable composer", () => {
    const screen = [
      "  ╭────────────────────────────────────────╮",
      "  │ > deploy and restart, then do a live click through once deployed │",
      "  ╰──────────────────── Grok 4.6 (high) ─╯",
      "",
      "  Enter:send  │  Shift+Enter/Alt+Enter:newline  │  Shift+Tab:mode  │  Ctrl+x:shortcuts",
    ].join("\n");
    const lines = splitLines(parseAnsi(screen));
    expect(locateComposer(lines)).not.toBeNull();
    expect(hasComposer(lines)).toBe(true);
    expect(composerReady(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBe(
      "deploy and restart, then do a live click through once deployed",
    );
  });

  it("a bare [stable] chip under the box is startup chrome — the composer is writable", () => {
    const screen = [
      "  ╭────────────────────────────────────────╮",
      "  │ ❯                                      │",
      "  ╰──────────────────── Grok 4.6 (high) ─╯",
      "",
      "  [stable]",
    ].join("\n");
    const lines = splitLines(parseAnsi(screen));
    expect(locateComposer(lines)).not.toBeNull();
    expect(composerReady(lines)).toBe(true);
  });

  it("a Grok Build <semver> [stable] chip under the box is still a writable composer", () => {
    const screen = [
      "  ╭────────────────────────────────────────╮",
      "  │ >                                      │",
      "  ╰──────────────────── Grok 4.6 (high) ─╯",
      "",
      "                                             Grok Build  1.0.13 [stable]",
    ].join("\n");
    const lines = splitLines(parseAnsi(screen));
    expect(locateComposer(lines)).not.toBeNull();
    expect(hasComposer(lines)).toBe(true);
    expect(composerReady(lines)).toBe(true);
  });

  it("an uncaptured bracket tag under the box is torn transcript — still refused", () => {
    const screen = [
      "  ╭────────────────────────────────────────╮",
      "  │ ❯                                      │",
      "  ╰──────────────────── Grok 4.6 (high) ─╯",
      "",
      "  [waiting]",
    ].join("\n");
    const lines = splitLines(parseAnsi(screen));
    expect(locateComposer(lines)).toBeNull();
    expect(composerReady(lines)).toBe(false);
  });

  it("blank rows lose their paint; glyph-bearing rows keep every background", () => {
    const screen = [
      "\x1b[48;2;20;20;20m          \x1b[0m",
      "\x1b[48;2;17;17;17m          \x1b[0m",
      "\x1b[48;2;36;36;36m card row \x1b[0m",
    ].join("\n");
    const lines = stripCanvasBackground(splitLines(parseAnsi(screen)));
    expect(lines[0]!.segments.every((s) => s.style.backgroundColor === undefined)).toBe(true);
    expect(lines[1]!.segments.every((s) => s.style.backgroundColor === undefined)).toBe(true);
    // The content row is untouchable — a dominant-colour vote stripped surfaces like this one.
    expect(lines[2]!.segments.some((s) => s.style.backgroundColor === "rgb(36,36,36)")).toBe(true);
  });

  it("a chip mixed with other text under the box is transcript — still refused", () => {
    const screen = [
      "  ╭────────────────────────────────────────╮",
      "  │ ❯                                      │",
      "  ╰──────────────────── Grok 4.6 (high) ─╯",
      "",
      "  later output then [stable]",
    ].join("\n");
    const lines = splitLines(parseAnsi(screen));
    expect(locateComposer(lines)).toBeNull();
    expect(composerReady(lines)).toBe(false);
  });

  // Residual fail-closed for a rounded widget above the composer that no detector claimed.
  it("refuses when a rounded widget sits immediately above the composer", () => {
    const screen = [
      "  ╭─ Allow this command? ─╮",
      "  │ bash git push         │",
      "  ╰───────────────────────╯",
      "",
      "  ╭────────────────────────────────────────╮",
      "  │ ❯                                      │",
      "  ╰──────────────────── Grok 4.6 (high) ─╯",
      "",
      "  Shift+Tab:mode  │  Ctrl+.:shortcuts",
    ].join("\n");
    const lines = splitLines(parseAnsi(screen));
    expect(hasComposer(lines)).toBe(true);
    expect(composerReady(lines)).toBe(false);
  });
});
