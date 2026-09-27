import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { piBuildBlocks } from "./index";
import { detectPiAsk, detectPiPromptRegion, detectPiReviewRegion, detectPiWizardRegion } from "./ask";
import { promptsEqual } from "../prompt-model";
import { submitPromptOption } from "../../actions";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function load(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

function textLine(text: string): StyledLine {
  return {
    segments: [{ text, style: {}, muted: false }],
  };
}

describe("pi ask detector", () => {
  it("1. pi--ask-radio.txt lifts as prompt-select with arrow+enter keys", () => {
    const lines = load("pi--ask-radio.txt");
    const blocks = piBuildBlocks(lines);

    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    const prompt = blocks.find((b) => b.kind === "prompt-select");
    if (prompt?.kind !== "prompt-select") throw new Error("expected prompt-select block");

    const m = prompt.prompt;
    expect(m.question).toBe("which fruit should the test pick?");
    expect(m.options.map((o) => o.label)).toEqual(["Apple", "Banana", "Cherry"]);
    expect(m.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
    ]);
    expect(m.options.map((o) => o.keyLabel)).toEqual(["1", "2", "3"]);
    expect(m.feedback).toEqual({
      key: "4",
      focused: false,
      text: "",
      purpose: "free-text",
    });
    expect(m.family).toBe("select");
  });

  it("2. pi--ask-radio-moved.txt calculates relative arrow steps and different signature", () => {
    const radioLines = load("pi--ask-radio.txt");
    const movedLines = load("pi--ask-radio-moved.txt");

    const radioPrompt = detectPiPromptRegion(radioLines);
    const movedPrompt = detectPiPromptRegion(movedLines);

    expect(radioPrompt).not.toBeNull();
    expect(movedPrompt).not.toBeNull();

    expect(movedPrompt!.model.options.map((o) => o.keys)).toEqual([
      ["Up", "Enter"],
      ["Enter"],
      ["Down", "Enter"],
    ]);

    expect(movedPrompt!.model.signature).not.toEqual(radioPrompt!.model.signature);
    expect(promptsEqual(radioPrompt!.model, movedPrompt!.model)).toBe(false);
  });

  it("3. pi--ask-radio-other-focused.txt has feedback.focused === true and refuses submitPromptOption", async () => {
    const lines = load("pi--ask-radio-other-focused.txt");
    const prompt = detectPiPromptRegion(lines);
    expect(prompt).not.toBeNull();
    expect(prompt!.model.feedback?.focused).toBe(true);

    const outcome = await submitPromptOption({
      paneId: "w1:p1",
      prompt: prompt!.model,
      option: prompt!.model.options[0]!,
      detectedRevision: 1,
      requestedLines: 50,
    });
    expect(outcome).toEqual({ status: "changed" });
  });

  it("4. pi--ask-wizard-q1.txt lifts as wizard in question phase", () => {
    const lines = load("pi--ask-wizard-q1.txt");
    const blocks = piBuildBlocks(lines);

    const wizardBlock = blocks.find((b) => b.kind === "wizard");
    expect(wizardBlock).toBeDefined();
    if (wizardBlock?.kind !== "wizard") throw new Error("expected wizard block");

    const w = wizardBlock.wizard;
    expect(w.phase).toBe("question");
    if (w.phase !== "question") throw new Error("expected question phase");
    expect(w.steps).toEqual([
      { label: "Color", answered: false, current: true },
      { label: "Size", answered: false, current: false },
    ]);
    expect(w.question).toBe("Pi wizard Q1: which color should the test use?");
    expect(w.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue"]);
    expect(w.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
    ]);
    expect(w.options.every((o) => o.chosen === false && o.escape === false)).toBe(true);

    expect(blocks.some((b) => b.kind === "prompt-select")).toBe(false);
  });

  it("5. pi--ask-wizard-q2.txt shows Color answered and Size current", () => {
    const lines = load("pi--ask-wizard-q2.txt");
    const wizardRegion = detectPiWizardRegion(lines);
    expect(wizardRegion).not.toBeNull();

    const w = wizardRegion!.model;
    expect(w.phase).toBe("question");
    if (w.phase !== "question") throw new Error("expected question phase");
    expect(w.steps).toEqual([
      { label: "Color", answered: true, current: false },
      { label: "Size", answered: false, current: true },
    ]);
    expect(w.question).toBe("Pi wizard Q2: which size should the test use?");
    expect(w.options.map((o) => o.label)).toEqual(["Small", "Medium", "Large"]);
  });

  it("6. pi--ask-wizard-other-focused.txt falls back to prompt-select with focused feedback and no wizard block", () => {
    const lines = load("pi--ask-wizard-other-focused.txt");
    const blocks = piBuildBlocks(lines);

    expect(blocks.some((b) => b.kind === "wizard")).toBe(false);
    const prompt = blocks.find((b) => b.kind === "prompt-select");
    expect(prompt).toBeDefined();
    if (prompt?.kind !== "prompt-select") throw new Error("expected prompt-select");
    expect(prompt.prompt.feedback?.focused).toBe(true);
  });

  // The Submit tab used to stay raw, which left a phone no way to finish a multi-question ask
  // (live 2026-09-27, pane wGK:p2). Enter submits, Escape cancels — never the Claude 1/2 digits.
  it("7. the Submit tab lifts as a wizard review with Enter/Escape", () => {
    for (const [file, answers] of [
      ["pi--ask-wizard-submit.txt", [["Color", "Red"], ["Size", "Small"]]],
      ["pi--ask-multi-review.txt", [["Q1", "Large"], ["Q2", "Coffee"]]],
    ] as const) {
      const block = piBuildBlocks(load(file)).find((b) => b.kind === "wizard");
      if (block?.kind !== "wizard" || block.wizard.phase !== "review") throw new Error(file);
      const w = block.wizard;
      expect(w.answers.map((a) => [a.question, a.answer])).toEqual(answers);
      expect(w.incomplete).toBe(false);
      expect(w.submitKeys).toEqual(["Enter"]);
      expect(w.cancelKeys).toEqual(["Escape"]);
      expect(w.steps.every((s) => s.answered && !s.current)).toBe(true);
    }
  });

  it("7b. an unanswered Submit tab disables submit (Pi ignores Enter there)", () => {
    const raw = readFileSync(join(PANES_DIR, "pi--ask-multi-review.txt"), "utf8");
    const lines = splitLines(parseAnsi(raw)).map((l) => {
      const t = l.segments.map((s) => s.text).join("");
      if (/Press Enter to submit/.test(t)) return textLine(" Unanswered: Q2");
      if (/^\s*Q2: /.test(t)) return textLine("");
      return l;
    });
    // drop the blanked answer row so the answer list stays contiguous
    const idx = lines.findIndex((l, i) => i > 0 && l.segments.map((s) => s.text).join("") === "" &&
      /Q1: /.test(lines[i - 1]!.segments.map((s) => s.text).join("")));
    if (idx > 0) lines.splice(idx, 1);
    const region = detectPiReviewRegion(lines);
    expect(region?.model.phase).toBe("review");
    if (region?.model.phase !== "review") return;
    expect(region.model.incomplete).toBe(true);
    expect(region.model.submitKeys).toBeNull();
    expect(region.model.cancelKeys).toEqual(["Escape"]);
  });

  it("8. across every lifted fixture, no key matches /^\\d+$/", () => {
    const fixtures = [
      "pi--ask-radio.txt",
      "pi--ask-radio-moved.txt",
      "pi--ask-radio-other-focused.txt",
      "pi--ask-wizard-q1.txt",
      "pi--ask-wizard-q2.txt",
      "pi--ask-wizard-other-focused.txt",
    ];
    for (const file of fixtures) {
      const parsed = detectPiAsk(load(file));
      expect(parsed).not.toBeNull();
      for (const opt of parsed!.options) {
        for (const k of opt.keys) {
          expect(k).not.toMatch(/^\d+$/);
        }
      }
    }
  });

  describe("9. synthetic line arrays (raw only or positive)", () => {
    const baseRule = "─".repeat(40);
    const footerStats = "↑1.5k ↓3.4k 4.1%/200k (auto)  muse-spark-1.3 • medium";
    const footerPwd = "~/Projects/tools/sighter (fix/366-pi-ask-lift)";

    it("input-mode frame stays raw", () => {
      const synthetic = [
        baseRule,
        " Which option?",
        "",
        "> 1. Alpha",
        "  2. Beta",
        "  3. Type something.",
        "",
        "Your answer: test",
        "Enter to submit • Esc to cancel",
        baseRule,
        footerPwd,
        footerStats,
      ].map(textLine);
      expect(piBuildBlocks(synthetic).every((b) => b.kind === "raw")).toBe(true);
    });

    it("help row missing stays raw", () => {
      const synthetic = [
        baseRule,
        " Which option?",
        "",
        "> 1. Alpha",
        "  2. Beta",
        "  3. Type something.",
        "",
        baseRule,
        footerPwd,
        footerStats,
      ].map(textLine);
      expect(piBuildBlocks(synthetic).every((b) => b.kind === "raw")).toBe(true);
    });

    it("two pointers stays raw", () => {
      const synthetic = [
        baseRule,
        " Which option?",
        "",
        "> 1. Alpha",
        "> 2. Beta",
        "  3. Type something.",
        "",
        " ↑↓ navigate • Enter select • Esc cancel",
        baseRule,
        footerPwd,
        footerStats,
      ].map(textLine);
      expect(piBuildBlocks(synthetic).every((b) => b.kind === "raw")).toBe(true);
    });

    it("numbering 1,3 (gap) stays raw", () => {
      const synthetic = [
        baseRule,
        " Which option?",
        "",
        "> 1. Alpha",
        "  3. Type something.",
        "",
        " ↑↓ navigate • Enter select • Esc cancel",
        baseRule,
        footerPwd,
        footerStats,
      ].map(textLine);
      expect(piBuildBlocks(synthetic).every((b) => b.kind === "raw")).toBe(true);
    });

    it("no Type something. row stays raw", () => {
      const synthetic = [
        baseRule,
        " Which option?",
        "",
        "> 1. Alpha",
        "  2. Beta",
        "  3. Gamma",
        "",
        " ↑↓ navigate • Enter select • Esc cancel",
        baseRule,
        footerPwd,
        footerStats,
      ].map(textLine);
      expect(piBuildBlocks(synthetic).every((b) => b.kind === "raw")).toBe(true);
    });

    it("HELP_SINGLE with a tab bar stays raw", () => {
      const synthetic = [
        baseRule,
        " ←  □ Tab1   □ Tab2   ✓ Submit  →",
        "",
        " Question text?",
        "",
        "> 1. Alpha",
        "  2. Beta",
        "  3. Type something.",
        "",
        " ↑↓ navigate • Enter select • Esc cancel",
        baseRule,
        footerPwd,
        footerStats,
      ].map(textLine);
      expect(piBuildBlocks(synthetic).every((b) => b.kind === "raw")).toBe(true);
    });

    it("HELP_MULTI without a tab bar stays raw", () => {
      const synthetic = [
        baseRule,
        " Question text?",
        "",
        "> 1. Alpha",
        "  2. Beta",
        "  3. Type something.",
        "",
        " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel",
        baseRule,
        footerPwd,
        footerStats,
      ].map(textLine);
      expect(piBuildBlocks(synthetic).every((b) => b.kind === "raw")).toBe(true);
    });

    it("a frame followed by 4 footer rows stays raw", () => {
      const synthetic = [
        baseRule,
        " Which option?",
        "",
        "> 1. Alpha",
        "  2. Beta",
        "  3. Type something.",
        "",
        " ↑↓ navigate • Enter select • Esc cancel",
        baseRule,
        footerPwd,
        footerStats,
        "extra row 1",
        "extra row 2",
      ].map(textLine);
      expect(piBuildBlocks(synthetic).every((b) => b.kind === "raw")).toBe(true);
    });

    it("a frame followed by 2 rows where row 2 has no %/...k stays raw", () => {
      const synthetic = [
        baseRule,
        " Which option?",
        "",
        "> 1. Alpha",
        "  2. Beta",
        "  3. Type something.",
        "",
        " ↑↓ navigate • Enter select • Esc cancel",
        baseRule,
        footerPwd,
        "row 2 without stats",
      ].map(textLine);
      expect(piBuildBlocks(synthetic).every((b) => b.kind === "raw")).toBe(true);
    });

    it("positive synthetic case: frame with NO footer rows still lifts", () => {
      const synthetic = [
        baseRule,
        " Which option?",
        "",
        "> 1. Alpha",
        "  2. Beta",
        "  3. Type something.",
        "",
        " ↑↓ navigate • Enter select • Esc cancel",
        baseRule,
      ].map(textLine);
      const blocks = piBuildBlocks(synthetic);
      expect(blocks.some((b) => b.kind === "prompt-select")).toBe(true);
    });
  });

  it("10. wrapped description attaches to the option above it (synthetic)", () => {
    const baseRule = "─".repeat(40);
    const synthetic = [
      baseRule,
      " Which option?",
      "",
      "> 1. Alpha",
      "     first line of description",
      "     second line of description",
      "  2. Beta",
      "  3. Type something.",
      "",
      " ↑↓ navigate • Enter select • Esc cancel",
      baseRule,
    ].map(textLine);

    const parsed = detectPiAsk(synthetic);
    expect(parsed).not.toBeNull();
    expect(parsed!.options[0]!.description).toBe(
      "first line of description second line of description",
    );
    expect(parsed!.options[1]!.description).toBeUndefined();
  });
});
