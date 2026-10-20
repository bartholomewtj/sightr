import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseLines } from "../../blocks";
import { composerFor } from "../composer-kit";
import { composerReady, extractInputDraft, STARTUP_MARKER, submitHeld } from "./chrome";
import { piAdapter } from "./index";

// Every screen here is a live capture of Pi 1.3.0 in a scratch herdr pane (135 columns), 2026-10-17.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const load = (name: string) => parseLines(readFileSync(join(PANES_DIR, name), "utf8"));

const FIRST_MESSAGE =
  "List the files in the web2/src/components/chat folder that end in .logic.ts, then tell me which is largest. Keep it to two sentences.";

describe("pi editor: slash completion list open", () => {
  it("is still the composer, and the draft reads back as the typed command", () => {
    for (const [name, draft] of [
      ["pi--slash-menu.txt", "/s"],
      ["pi--slash-menu-new.txt", "/new"],
    ] as const) {
      const lines = load(name);
      expect(composerReady(lines)).toBe(true);
      expect(extractInputDraft(lines)).toBe(draft);
      expect(submitHeld(lines)).toBe(false);
    }
  });
});

describe("pi editor: draft extraction", () => {
  it("reads a wrapped draft back as the text that was typed", () => {
    const lines = load("pi--draft-wrapped.txt");
    expect(composerReady(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBe(
      "List the files in the web2/src/components/chat folder that end in .logic.ts, then tell me which is largest. Keep it to two sentences. " +
        "Also explain how each of the files is structured and what role it plays in the composer so that the line wraps.",
    );
    expect(submitHeld(lines)).toBe(false);
  });

  it("reads an empty editor (cursor cell only, no placeholder) as no draft, and still ready", () => {
    const lines = load("pi--idle-empty.txt");
    expect(composerReady(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBeNull();
    expect(submitHeld(lines)).toBe(false);
  });

  it("does not take the footer, the stats row or the extension status row for a draft", () => {
    const lines = load("pi--idle-empty.txt");
    // The rows under the editor are pwd, stats and `thickAPI claude via bridge`: none is text.
    expect(extractInputDraft(lines)).toBeNull();
  });

  it("is not ready and reads no draft while an ask dialog has the editor's place", () => {
    const asks = readdirSync(PANES_DIR).filter((f) => f.startsWith("pi--ask-") && f.endsWith(".txt"));
    expect(asks.length).toBeGreaterThan(0);
    for (const name of asks) {
      const lines = load(name);
      expect(composerReady(lines), name).toBe(false);
      expect(extractInputDraft(lines), name).toBeNull();
      expect(submitHeld(lines), name).toBe(false);
    }
  });

  it("is not ready once ordinary output sits below the footer (not the tail)", () => {
    const lines = load("pi--idle-empty.txt");
    const pushed = [...lines, ...parseLines("some later output\nmore output\nand more\nstill more\nlast line")];
    expect(composerReady(pushed)).toBe(false);
  });
});

describe("pi editor: startup in progress", () => {
  it("holds the submit while Pi's startup marker is the newest chat row, with the text kept in the editor", () => {
    const lines = load("pi--startup-in-progress.txt");
    expect(composerReady(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBe(FIRST_MESSAGE);
    expect(submitHeld(lines)).toBe(true);
  });

  it("stops holding once startup has printed past the marker; the text is still unsubmitted", () => {
    const lines = load("pi--startup-done-draft.txt");
    expect(lines.some((l) => l.segments.map((s) => s.text).join("").trim() === STARTUP_MARKER)).toBe(true);
    expect(composerReady(lines)).toBe(true);
    expect(extractInputDraft(lines)).toBe(FIRST_MESSAGE);
    expect(submitHeld(lines)).toBe(false);
  });
});

describe("pi composer kit", () => {
  it("is the adapter's own functions, and no longer one-shot", () => {
    const kit = composerFor("pi")!;
    expect(kit.extractInputDraft).toBe(piAdapter.extractInputDraft);
    expect(kit.composerReady).toBe(piAdapter.composerReady);
    expect(kit.submitHeld).toBe(piAdapter.submitHeld);
    expect(kit.replyOneShot).toBeUndefined();
  });
});
