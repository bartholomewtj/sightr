import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { draftCarriesSend, submitPromptOption } from "../actions";
import { promptsEqual } from "./prompt-model";
import { cursorAdapter } from "./cursor";
import { askCardPresent, detectAskRegion } from "./cursor/ask";
import { locateComposer, stripChrome } from "./cursor/chrome";
import { lineText } from "./cursor/markers";
import { detectPermissionRegion } from "./cursor/permission";
import { detectTrustRegion } from "./cursor/trust";
import { describeAdapterConformance } from "./conformance";

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

const allCursorFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("cursor--") && f.endsWith(".txt"))
  .sort();
const allClaudeFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("claude--") && f.endsWith(".txt"))
  .sort();
const allGrokFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("grok--") && f.endsWith(".txt"))
  .sort();
const allAgyFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("agy--") && f.endsWith(".txt"))
  .sort();
const allPiFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("pi--") && f.endsWith(".txt"))
  .sort();

const PINNED = [
  "cursor--ask-fruit-other-focused.txt",
  "cursor--ask-fruit.txt",
  "cursor--autocomplete-slash-clear.txt",
  "cursor--autocomplete-slash.txt",
  "cursor--debug-idle.txt",
  "cursor--done.txt",
  "cursor--draft-single.txt",
  "cursor--draft-wrapped.txt",
  "cursor--fresh-idle.txt",
  "cursor--permission-command-moved.txt",
  "cursor--permission-command-review-hint.txt",
  "cursor--permission-command.txt",
  "cursor--permission-skip-feedback.txt",
  "cursor--plan-idle.txt",
  "cursor--trust-workspace.txt",
  "cursor--working-tasks.txt",
  "cursor--working.txt",
];

const DIALOG = [
  "cursor--ask-fruit-other-focused.txt",
  "cursor--ask-fruit.txt",
  "cursor--permission-command-moved.txt",
  "cursor--permission-command-review-hint.txt",
  "cursor--permission-command.txt",
  "cursor--trust-workspace.txt",
];

// Slash-autocomplete captures: composerReady must stay true (that's the send-stall bug), but a tall
// popup sits more than PROMPT_TAIL_LINES below the prompt so composerPrompt correctly returns null
// (unbound write). Kept out of the conformance neutral cohort — that suite requires the two to agree.
const AUTOCOMPLETE = [
  "cursor--autocomplete-slash-clear.txt",
  "cursor--autocomplete-slash.txt",
];

const ownFixtures = DIALOG;
const neutralFixtures = allCursorFixtures.filter(
  (f) => !DIALOG.includes(f) && !AUTOCOMPLETE.includes(f),
);

describeAdapterConformance(cursorAdapter, {
  ownFixtures,
  foreignFixtures: [...allClaudeFixtures, ...allGrokFixtures, ...allAgyFixtures, ...allPiFixtures],
  neutralFixtures,
});

describe("the cursor corpus", () => {
  it("is exactly the captures this adapter was developed against", () => {
    expect(allCursorFixtures).toEqual(PINNED);
  });
});

describe("composerReady", () => {
  it.each(neutralFixtures.filter((f) => f !== "cursor--permission-skip-feedback.txt"))(
    "%s: composer on screen ⇒ true",
    (name) => {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      expect(cursorAdapter.composerReady!(lines)).toBe(true);
    },
  );

  it("skip-feedback is still a composer (type a reason or Esc)", () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "cursor--permission-skip-feedback.txt"), "utf8")),
    );
    expect(cursorAdapter.composerReady!(lines)).toBe(true);
    expect(cursorAdapter.extractInputDraft(lines)).toBeNull();
  });

  it.each(DIALOG)("%s: modal ⇒ false", (name) => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
    expect(cursorAdapter.composerReady!(lines)).toBe(false);
  });
});

describe("cursorBuildBlocks", () => {
  it("stays raw on every neutral capture", () => {
    for (const name of neutralFixtures) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      expect(
        cursorAdapter.buildBlocks(lines).every((b) => b.kind === "raw"),
        name,
      ).toBe(true);
    }
  });

  it("lifts command approval to Yes/Skip only — never allowlist or Run Everything", () => {
    for (const name of [
      "cursor--permission-command.txt",
      "cursor--permission-command-moved.txt",
      "cursor--permission-command-review-hint.txt",
    ]) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const prompt = cursorAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
      expect(prompt?.kind, name).toBe("prompt-select");
      if (prompt?.kind !== "prompt-select") return;
      expect(prompt.prompt.family).toBe("permission");
      expect(prompt.prompt.question).toMatch(/Run this command\?/i);
      expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Run (once)", "Skip"]);
      expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["y"], ["n"]]);
      expect(cursorAdapter.composerReady!(lines)).toBe(false);
    }
  });

  it("lifts workspace trust to a / q", () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "cursor--trust-workspace.txt"), "utf8")),
    );
    const prompt = cursorAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.family).toBe("trust");
    expect(prompt.prompt.options.map((o) => o.label)).toEqual([
      "Trust this workspace",
      "Quit",
    ]);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["a"], ["q"]]);
  });

  it("reads a stranded draft and ignores placeholders", () => {
    const idle = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "cursor--fresh-idle.txt"), "utf8")));
    const draft = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "cursor--draft-single.txt"), "utf8")),
    );
    expect(cursorAdapter.extractInputDraft(idle)).toBeNull();
    expect(cursorAdapter.extractInputDraft(draft)).toBe("hello from phone");
    expect(cursorAdapter.composerReady!(idle)).toBe(true);
    expect(cursorAdapter.composerReady!(draft)).toBe(true);
  });

  // Live 2026-09-13: a long follow-up soft-wraps above status; unpeeled, locateComposer stopped on
  // the continuation row and phone sends stalled ("Message didn't reach the input box").
  it("folds a wrapped draft and verifies a real send via draftCarriesSend", () => {
    const sent =
      "like intercom, but within herdr sessions, so they can be used in plugin pipelines between any model. id also want to permission this communication. is something like this possible?";
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "cursor--draft-wrapped.txt"), "utf8")),
    );
    expect(cursorAdapter.composerReady!(lines)).toBe(true);
    const draft = cursorAdapter.extractInputDraft(lines);
    expect(draft).toBe(sent);
    expect(draftCarriesSend(sent, draft)).toBe(true);
    expect(locateComposer(lines)).not.toBeNull();
  });

  it("strips the prompt + status from the raw mirror", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "cursor--fresh-idle.txt"), "utf8")));
    const [block] = cursorAdapter.buildBlocks(lines);
    expect(block?.kind).toBe("raw");
    if (block?.kind !== "raw") return;
    const text = block.lines.map(lineText).join("\n");
    expect(text).not.toMatch(/^\s*→/m);
    expect(text).not.toContain("Plan, search, build anything");
    expect(locateComposer(lines)).not.toBeNull();
    expect(stripChrome(lines).length).toBeLessThan(lines.length);
  });

  it("surfaces Auto / mode status lines", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "cursor--plan-idle.txt"), "utf8")));
    const status = cursorAdapter.extractStatusLines(lines).map(lineText).join("\n");
    expect(status).toMatch(/Plan \(shift\+tab to cycle\)/i);
    expect(status).toMatch(/Auto/);
    expect(status).toMatch(/plugin/);
  });

  it("permission refuses a card with no Skip row", () => {
    const spoof = [
      " Run this command?",
      " Not in allowlist: echo",
      "  → Run (once) (y)",
      "    Add Shell(echo) to allowlist? (tab)",
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses an unknown option key", () => {
    const spoof = [
      " Run this command?",
      "  → Run (once) (y)",
      "    Maybe later (x)",
      "    Skip & tell the agent what to do instead (esc or n)",
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("trust refuses [a]/[q] without the Workspace Trust title", () => {
    const spoof = [
      " Pick one",
      "  ▶ [a] Trust this workspace",
      "    [q] Quit",
      " Use arrow keys to navigate, Enter to select, or press the key shown",
    ].join("\n");
    expect(detectTrustRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("does not lift numbered clarifying questions painted as transcript", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "cursor--plan-idle.txt"), "utf8")));
    expect(detectPermissionRegion(lines)).toBeNull();
    expect(detectTrustRegion(lines)).toBeNull();
    expect(detectAskRegion(lines)).toBeNull();
    expect(cursorAdapter.buildBlocks(lines).every((b) => b.kind === "raw")).toBe(true);
  });

  it("lifts the Cursor ask card to arrow+Enter options", () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "cursor--ask-fruit.txt"), "utf8")),
    );
    const blocks = cursorAdapter.buildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    const promptBlock = blocks.find((b) => b.kind === "prompt-select");
    expect(promptBlock?.kind).toBe("prompt-select");
    if (promptBlock?.kind !== "prompt-select") return;

    const prompt = promptBlock.prompt;
    expect(prompt.family).toBe("select");
    expect(prompt.question).toBe("Which fruit should the test pick?");
    expect(prompt.options.map((o) => o.label)).toEqual(["Apple", "Banana", "Cherry"]);
    expect(prompt.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
    ]);
    expect(prompt.options.map((o) => o.keyLabel)).toEqual(["1", "2", "3"]);
    expect(prompt.feedback).toEqual({
      key: "4",
      focused: false,
      text: "",
      purpose: "free-text",
    });

    expect(detectPermissionRegion(lines)).toBeNull();
    expect(detectTrustRegion(lines)).toBeNull();
    expect(cursorAdapter.composerReady!(lines)).toBe(false);
    expect(cursorAdapter.extractInputDraft(lines)).toBeNull();
    expect(cursorAdapter.extractStatusLines(lines)).toEqual([]);

    for (const opt of prompt.options) {
      for (const k of opt.keys) {
        expect(k).not.toMatch(/^\d+$/);
        expect(k).not.toBe("Space");
        expect(k).not.toBe("s");
        expect(k).not.toBe("k");
        expect(k).not.toBe("Escape");
      }
    }
  });

  it("Other focused locks the options", async () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "cursor--ask-fruit-other-focused.txt"), "utf8")),
    );
    const blocks = cursorAdapter.buildBlocks(lines);
    const promptBlock = blocks.find((b) => b.kind === "prompt-select");
    expect(promptBlock?.kind).toBe("prompt-select");
    if (promptBlock?.kind !== "prompt-select") return;

    const prompt = promptBlock.prompt;
    expect(prompt.feedback?.focused).toBe(true);
    expect(prompt.options.map((o) => o.keys)).toEqual([
      ["Up", "Up", "Up", "Enter"],
      ["Up", "Up", "Enter"],
      ["Up", "Enter"],
    ]);

    const res = await submitPromptOption({
      paneId: "p",
      requestedLines: 80,
      detectedRevision: 0,
      prompt,
      option: prompt.options[0]!,
      agent: "cursor",
    });
    expect(res).toEqual({ status: "changed" });
  });

  it("ask variants (synthetic)", () => {
    function replaceOne(source: string, needle: string, replacement: string): string {
      expect(source.split(needle).length).toBe(2);
      return source.replace(needle, replacement);
    }

    const rawFruit = readFileSync(join(PANES_DIR, "cursor--ask-fruit.txt"), "utf8");

    // Pointer on Banana: arrow walk from Banana
    const bananaMoved = replaceOne(
      replaceOne(rawFruit, "  › [ ] Apple", "    [ ] Apple"),
      "    [ ] Banana",
      "  › [ ] Banana",
    );
    const bananaLines = splitLines(parseAnsi(bananaMoved));
    const bananaAsk = detectAskRegion(bananaLines);
    expect(bananaAsk).not.toBeNull();
    expect(bananaAsk!.model.options.map((o) => o.keys)).toEqual([
      ["Up", "Enter"],
      ["Enter"],
      ["Down", "Enter"],
    ]);
    const fruitLines = splitLines(parseAnsi(rawFruit));
    const fruitAsk = detectAskRegion(fruitLines);
    expect(bananaAsk!.model.signature).not.toBe(fruitAsk!.model.signature);
    expect(promptsEqual(bananaAsk!.model, fruitAsk!.model)).toBe(false);

    // pick? -> pick? (multi-select): stays raw
    const multiRaw = replaceOne(rawFruit, "pick?", "pick? (multi-select)");
    const multiLines = splitLines(parseAnsi(multiRaw));
    expect(detectAskRegion(multiLines)).toBeNull();
    expect(cursorAdapter.buildBlocks(multiLines).every((b) => b.kind === "raw")).toBe(true);
    expect(askCardPresent(multiLines)).toBe(true);
    expect(cursorAdapter.composerReady!(multiLines)).toBe(false);

    // Question 1 of 2 lifts with same keys; Question 3 of 2 fails closed
    const q1of2Raw = replaceOne(rawFruit, "Question 1 of 1", "Question 1 of 2");
    const q1of2Lines = splitLines(parseAnsi(q1of2Raw));
    const q1of2Ask = detectAskRegion(q1of2Lines);
    expect(q1of2Ask).not.toBeNull();
    expect(q1of2Ask!.model.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
    ]);

    const q3of2Raw = replaceOne(rawFruit, "Question 1 of 1", "Question 3 of 2");
    const q3of2Lines = splitLines(parseAnsi(q3of2Raw));
    expect(detectAskRegion(q3of2Lines)).toBeNull();
    expect(cursorAdapter.composerReady!(q3of2Lines)).toBe(false);

    // Footer Space select -> Space toggle: null
    const footerToggleRaw = replaceOne(rawFruit, "Space select", "Space toggle");
    const footerToggleLines = splitLines(parseAnsi(footerToggleRaw));
    expect(detectAskRegion(footerToggleLines)).toBeNull();

    // Second pointer (two pointers at once): null
    const twoPointersRaw = replaceOne(rawFruit, "    [ ] Banana", "  › [ ] Banana");
    const twoPointersLines = splitLines(parseAnsi(twoPointersRaw));
    expect(detectAskRegion(twoPointersLines)).toBeNull();

    // [ ] Banana -> [x] Banana lifts; two marks in single-select is null
    const oneMarkRaw = replaceOne(rawFruit, "[ ] Banana", "[x] Banana");
    const oneMarkLines = splitLines(parseAnsi(oneMarkRaw));
    expect(detectAskRegion(oneMarkLines)).not.toBeNull();

    const twoMarksRaw = replaceOne(oneMarkRaw, "[ ] Apple", "[x] Apple");
    const twoMarksLines = splitLines(parseAnsi(twoMarksRaw));
    expect(detectAskRegion(twoMarksLines)).toBeNull();

    // Other: (type to answer) -> Other: plum with pointer on Other: text is "plum"
    const rawOtherFocused = readFileSync(
      join(PANES_DIR, "cursor--ask-fruit-other-focused.txt"),
      "utf8",
    );
    const plumRaw = replaceOne(
      rawOtherFocused,
      "Other: (type to answer)",
      "Other: plum",
    );
    const plumLines = splitLines(parseAnsi(plumRaw));
    const plumAsk = detectAskRegion(plumLines);
    expect(plumAsk).not.toBeNull();
    expect(plumAsk!.model.feedback).toEqual({
      key: "4",
      focused: true,
      text: "plum",
      purpose: "free-text",
    });

    // Composer tail removed (cut after box bottom): still lifts
    const bottomIndex = rawFruit.indexOf(" └");
    expect(bottomIndex).toBeGreaterThan(0);
    const afterBottom = rawFruit.indexOf("\n", bottomIndex);
    const noTailRaw = rawFruit.slice(0, afterBottom + 1);
    const noTailLines = splitLines(parseAnsi(noTailRaw));
    expect(detectAskRegion(noTailLines)).not.toBeNull();
  });
});
