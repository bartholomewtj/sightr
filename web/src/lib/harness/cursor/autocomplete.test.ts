import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { findAutocompleteRun } from "./autocomplete";
import { composerReady, extractInputDraft, extractStatusLines, locateComposer } from "./chrome";
import { lastNonBlankIndex, rstrip } from "../scan";
import { lineText } from "./markers";

// Live captures from 2026-09-13 (`herdr pane read` on a Cursor Agent pane). Synthetic screens
// remain only for the negative cases the live dumps cannot cover.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function load(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

function lines(text: string): StyledLine[] {
  return splitLines(parseAnsi(text));
}

function textsOf(styled: StyledLine[]): string[] {
  return styled.map((l) => rstrip(lineText(l)));
}

function popupScreen(draft: string, entryRows: string[]): StyledLine[] {
  // Mirrors the live shape: blank composer-chrome rows between the prompt and the popup.
  return lines(["Some transcript output", "", `  → ${draft}`, "", "", ...entryRows].join("\n"));
}

const LONG = "cursor--autocomplete-slash.txt";
const CLEAR = "cursor--autocomplete-slash-clear.txt";
const MODEL_COMPOSER = "cursor--autocomplete-model-composer.txt";
const MODEL_C = "cursor--autocomplete-model-c.txt";

describe("findAutocompleteRun — live captures", () => {
  it("reads the overflowing list (↓ more below footer)", () => {
    const styled = load(LONG);
    const texts = textsOf(styled);
    const run = findAutocompleteRun(texts, lastNonBlankIndex(texts) + 1);
    expect(run).not.toBeNull();
    expect(texts[run!.promptLine]).toBe("  → /c");
    expect(run!.entries.map((e) => e.name)).toEqual([
      "/ca",
      "/clear",
      "/config",
      "/commit",
      "/context",
      "/council",
      "/command",
      "/copy",
      "/codex-5-3",
    ]);
    expect(run!.entries[0]!.description).toMatch(/^Drive headed Chrome/);
    expect(run!.entries[1]!.description).toBe("Start a new chat session");
  });

  it("reads the filtered /clear list (no footer, bracketed name with spaces)", () => {
    const styled = load(CLEAR);
    const texts = textsOf(styled);
    const run = findAutocompleteRun(texts, lastNonBlankIndex(texts) + 1);
    expect(run).not.toBeNull();
    expect(texts[run!.promptLine]).toBe("  → /clear");
    expect(run!.entries.map((e) => e.name)).toEqual([
      "/clear",
      "/bedrock [subcommand] […",
      "/autopilot",
      "/claudesssf",
      "/create-rule",
    ]);
    expect(run!.entries[0]!.description).toBe("Start a new chat session");
    expect(run!.entries[1]!.description).toMatch(/^Configure Bedrock/);
  });

  it("reads the /model composer picker (single match)", () => {
    const styled = load(MODEL_COMPOSER);
    const texts = textsOf(styled);
    const run = findAutocompleteRun(texts, lastNonBlankIndex(texts) + 1);
    expect(run).not.toBeNull();
    expect(texts[run!.promptLine]).toBe("  → /model composer");
    expect(run!.entries.map((e) => e.name)).toEqual(["Composer 2.5"]);
    expect(run!.entries[0]!.description).toBe("(Tab to modify)");
  });

  it("reads the /model c picker (pagination footer)", () => {
    const styled = load(MODEL_C);
    const texts = textsOf(styled);
    const run = findAutocompleteRun(texts, lastNonBlankIndex(texts) + 1);
    expect(run).not.toBeNull();
    expect(texts[run!.promptLine]).toBe("  → /model c");
    expect(run!.entries.map((e) => e.name)).toEqual([
      "Cursor Grok 4.6",
      "Composer 2.5",
      "Claude Opus 5",
      "Claude Opus 4.8",
      "Claude Fable 5.1",
      "Claude Fable 5",
      "Cursor Grok 4.5",
      "Claude Sonnet 5",
      "Claude Sonnet 4.6",
      "Codex 5.3",
    ]);
    expect(run!.entries[1]!.description).toBe("(Tab to modify)");
    expect(run!.entries[2]!.description).toBe("300K High");
  });
});

describe("findAutocompleteRun — negative cases", () => {
  const ENTRIES = [
    "   → /clear                    Start a new chat session",
    "     /autopilot                Keep a PR merge-ready",
    "     /create-rule              Create Cursor rules",
  ];

  it("declines when the prompt above the run isn't a slash draft", () => {
    const styled = popupScreen("hello", ENTRIES);
    const texts = textsOf(styled);
    expect(findAutocompleteRun(texts, lastNonBlankIndex(texts) + 1)).toBeNull();
  });

  it("declines when a status row follows the run", () => {
    const styled = lines(["  → /c", "", "", ...ENTRIES, "  Auto · 1%"].join("\n"));
    const texts = textsOf(styled);
    expect(findAutocompleteRun(texts, lastNonBlankIndex(texts) + 1)).toBeNull();
  });

  it("declines a run with no prompt line above it at all", () => {
    const texts = ENTRIES;
    expect(findAutocompleteRun(texts, texts.length)).toBeNull();
  });
});

describe("composer detection survives the popup", () => {
  it("composerReady + draft on the overflowing live capture", () => {
    const styled = load(LONG);
    expect(composerReady(styled)).toBe(true);
    expect(extractInputDraft(styled)).toBe("/c");
    expect(extractStatusLines(styled)).toEqual([]);
    expect(locateComposer(styled)?.prompt).toBeDefined();
  });

  it("composerReady + draft on the /clear live capture (user's failure case)", () => {
    const styled = load(CLEAR);
    expect(composerReady(styled)).toBe(true);
    expect(extractInputDraft(styled)).toBe("/clear");
    expect(extractStatusLines(styled)).toEqual([]);
  });

  it("composerReady + draft on the /model composer picker", () => {
    const styled = load(MODEL_COMPOSER);
    expect(composerReady(styled)).toBe(true);
    expect(extractInputDraft(styled)).toBe("/model composer");
    expect(extractStatusLines(styled)).toEqual([]);
  });

  it("composerReady + draft on the /model c picker", () => {
    const styled = load(MODEL_C);
    expect(composerReady(styled)).toBe(true);
    expect(extractInputDraft(styled)).toBe("/model c");
    expect(extractStatusLines(styled)).toEqual([]);
  });

  it("still detects a normal idle / draft screen", () => {
    expect(composerReady(load("cursor--fresh-idle.txt"))).toBe(true);
    expect(extractInputDraft(load("cursor--draft-single.txt"))).toBe("hello from phone");
  });

  // Live 2026-09-13: Cursor paints `1 task` under the follow-up prompt while working. Unrecognised,
  // locateComposer stopped on that row and phone sends stalled ("didn't reach the input box").
  it("composerReady on working chrome that includes a task-count status row", () => {
    const styled = load("cursor--working-tasks.txt");
    expect(composerReady(styled)).toBe(true);
    const box = locateComposer(styled);
    expect(box).not.toBeNull();
    expect(lineText(styled[box!.prompt]!)).toMatch(/→ Add a follow-up/);
    const status = extractStatusLines(styled).map((l) => lineText(l).trim());
    expect(status.some((t) => /^1 task$/i.test(t))).toBe(true);
    expect(status.some((t) => /^Auto\b/.test(t))).toBe(true);
  });
});
