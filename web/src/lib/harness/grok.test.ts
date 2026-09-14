import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { grokAdapter } from "./grok";
import { locateComposer, stripChrome } from "./grok/chrome";
import { lineText } from "./grok/markers";
import {
  checkboxAskPresent,
  detectAskRegion,
  detectAskWizardRegion,
  detectCheckboxAskRegion,
} from "./grok/ask";
import { WIZARD_BACK_KEYS, WIZARD_NEXT_KEYS, wizardsEqual } from "./wizard-model";
import { multiSelectEquals } from "./multi-select-model";
import { detectPermissionRegion } from "./grok/permission";
import { detectPlanMenuRegion } from "./grok/plan-menu";
import { describeAdapterConformance } from "./conformance";

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

const allGrokFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("grok--") && f.endsWith(".txt"))
  .sort();
const allClaudeFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("claude--") && f.endsWith(".txt"))
  .sort();
const allCursorFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("cursor--") && f.endsWith(".txt"))
  .sort();
const allAgyFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("agy--") && f.endsWith(".txt"))
  .sort();
const allPiFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("pi--") && f.endsWith(".txt"))
  .sort();
const PINNED = [
  "grok--ask-color-moved.txt",
  "grok--ask-color.txt",
  "grok--ask-esc-park-typed.txt",
  "grok--ask-esc-park.txt",
  "grok--ask-light-gutter.txt",
  "grok--ask-multi-checked.txt",
  "grok--ask-multi-wizard-q1.txt",
  "grok--ask-multi.txt",
  "grok--ask-r3-wrap.txt",
  "grok--ask-size.txt",
  "grok--ask-wizard-q1.txt",
  "grok--ask-wizard-q2.txt",
  "grok--ask-z-bullet.txt",
  "grok--ask-z-focused.txt",
  "grok--ask-z-parked.txt",
  "grok--ask-z-typed.txt",
  "grok--done.txt",
  "grok--draft-single.txt",
  "grok--draft-wrapped.txt",
  "grok--fresh-idle.txt",
  "grok--permission-edit.txt",
  "grok--permission-light-gutter.txt",
  "grok--permission-rm-feedback.txt",
  "grok--permission-rm-moved.txt",
  "grok--permission-rm.txt",
  "grok--plan-approval.txt",
  "grok--plan-request-changes.txt",
  "grok--plan-tab-prompt.txt",
  "grok--prompt-ascii-draft.txt",
  "grok--prompt-ascii.txt",
  "grok--startup-build-chip.txt",
  "grok--startup.txt",
  "grok--user-bubble.txt",
  "grok--working.txt",
];

const DIALOG = [
  "grok--ask-color-moved.txt",
  "grok--ask-color.txt",
  "grok--ask-esc-park-typed.txt",
  "grok--ask-esc-park.txt",
  "grok--ask-light-gutter.txt",
  "grok--ask-multi-checked.txt",
  "grok--ask-multi-wizard-q1.txt",
  "grok--ask-multi.txt",
  "grok--ask-r3-wrap.txt",
  "grok--ask-size.txt",
  "grok--ask-wizard-q1.txt",
  "grok--ask-wizard-q2.txt",
  "grok--ask-z-bullet.txt",
  "grok--ask-z-focused.txt",
  "grok--ask-z-parked.txt",
  "grok--ask-z-typed.txt",
  "grok--permission-edit.txt",
  "grok--permission-light-gutter.txt",
  "grok--permission-rm-feedback.txt",
  "grok--permission-rm-moved.txt",
  "grok--permission-rm.txt",
  "grok--plan-approval.txt",
  "grok--plan-request-changes.txt",
  "grok--plan-tab-prompt.txt",
];

const ownFixtures = DIALOG;
const neutralFixtures = allGrokFixtures.filter((f) => !DIALOG.includes(f));

describeAdapterConformance(grokAdapter, {
  ownFixtures,
  foreignFixtures: [...allClaudeFixtures, ...allAgyFixtures, ...allCursorFixtures, ...allPiFixtures],
  neutralFixtures,
});

describe("the grok corpus", () => {
  it("is exactly the captures this adapter was developed against", () => {
    expect(allGrokFixtures).toEqual(PINNED);
  });
});

describe("composerReady — the gate the reply path pre-flights on", () => {
  it.each(
    neutralFixtures.filter((f) => f !== "grok--user-bubble.txt"),
  )("%s: the composer is on screen ⇒ true", (name) => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
    expect(grokAdapter.composerReady!(lines)).toBe(true);
  });

  it.each(["grok--user-bubble.txt", ...DIALOG])(
    "%s: a modal or torn frame ⇒ false",
    (name) => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
    expect(grokAdapter.composerReady!(lines)).toBe(false);
  });
});

describe("grokBuildBlocks", () => {
  it("stays raw on every neutral capture", () => {
    for (const name of neutralFixtures) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const blocks = grokAdapter.buildBlocks(lines);
      expect(blocks.every((b) => b.kind === "raw"), name).toBe(true);
    }
  });

  it("lifts the 3-option rm permission card with only Yes, proceed", () => {
    for (const name of DIALOG.filter((f) => f.includes("permission-rm"))) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const blocks = grokAdapter.buildBlocks(lines);
      const prompt = blocks.find((b) => b.kind === "prompt-select");
      expect(prompt?.kind, name).toBe("prompt-select");
      if (prompt?.kind !== "prompt-select") return;
      expect(prompt.prompt.family).toBe("permission");
      expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Yes, proceed", "No, reject"]);
      expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["2"], ["3"]]);
    }
  });

  it("lifts the live light-gutter permission card with a persistent row after the reject", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--permission-light-gutter.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.family).toBe("permission");
    expect(prompt.prompt.question).toBe("Remove hello.txt file");
    expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Yes, proceed", "No, reject"]);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["3"], ["4"]]);
    expect(grokAdapter.composerReady!(lines)).toBe(false);
  });

  it("lifts the 4-option edit permission card from its bottom Yes/No pair", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--permission-edit.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.family).toBe("permission");
    expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Yes", "No, reject"]);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["3"], ["4"]]);
  });

  it("lifts ask_user_question cards to prompt-select with consecutive digit keys", () => {
    for (const name of DIALOG.filter((f) => f.includes("ask-color"))) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const blocks = grokAdapter.buildBlocks(lines);
      const prompt = blocks.find((b) => b.kind === "prompt-select");
      expect(prompt?.kind, name).toBe("prompt-select");
      if (prompt?.kind !== "prompt-select") return;
      expect(prompt.prompt.family).toBe("select");
      expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue"]);
      expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
      // Grok's scrollbar column must not ride along as the description's last word.
      expect(prompt.prompt.options[0]!.description).toBe("Warm red palette");
      expect(prompt.prompt.feedback).toEqual({
        key: "z",
        focused: false,
        text: "",
        purpose: "free-text",
      });
    }
  });

  it("lifts the live light-gutter ask card", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-light-gutter.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.family).toBe("select");
    expect(prompt.prompt.question).toBe("Which color theme should the dashboard use?");
    expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue"]);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(prompt.prompt.options[0]!.description).toBe(
      "Warm, high-contrast palette with red as the primary accent.",
    );
    expect(prompt.prompt.feedback).toEqual({
      key: "z",
      focused: false,
      text: "",
      purpose: "free-text",
    });
    expect(grokAdapter.composerReady!(lines)).toBe(false);
  });

  it("lifts plan approval to a menu of footer-named keys, no digits", () => {
    for (const name of ["grok--plan-approval.txt", "grok--plan-tab-prompt.txt", "grok--plan-request-changes.txt"]) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const blocks = grokAdapter.buildBlocks(lines);
      const menu = blocks.find((b) => b.kind === "menu");
      expect(menu?.kind, name).toBe("menu");
      if (menu?.kind !== "menu") return;
      expect(menu.menu.actions.some((a) => a.keys.includes("a")), name).toBe(true);
      expect(menu.menu.actions.every((a) => !/^\d+$/.test(a.keys.join(""))), name).toBe(true);
    }
  });

  it("binds plan-approval keystrokes to the composer+footer, not the plan.md body", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--plan-approval.txt"), "utf8")));
    const menu = grokAdapter.buildBlocks(lines).find((b) => b.kind === "menu");
    expect(menu?.kind).toBe("menu");
    if (menu?.kind !== "menu") return;
    // The full preview is the race-guard signature; the bind is a tail slice. A real plan fills
    // the viewport and the whole signature is past the bridge's 8192-char expected_prompt cap.
    expect(menu.menu.region.length).toBeGreaterThan(0);
    expect(menu.menu.region.length).toBeLessThan(menu.menu.signature.length);
    expect(menu.menu.region.length).toBeLessThanOrEqual(8192);
    expect(menu.menu.region).toMatch(/plan approval/i);
    expect(menu.menu.region).toMatch(/a:approve/i);
    expect(menu.menu.region).not.toMatch(/NOTICE/);
    expect(menu.menu.signature).toMatch(/NOTICE/);
  });

  it("the question rows stay in the raw mirror above the lifted options", () => {
    const cases: [string, string][] = [
      ["grok--permission-rm.txt", "Remove hello.txt as requested"],
      ["grok--permission-edit.txt", "Allow Edit to"],
      ["grok--permission-light-gutter.txt", "Remove hello.txt file"],
      ["grok--ask-color.txt", "Which color theme should the dashboard use?"],
      ["grok--ask-light-gutter.txt", "Which color theme should the dashboard use?"],
      ["grok--ask-r3-wrap.txt", "Which region should the rollout start in?"],
    ];
    for (const [name, question] of cases) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      const blocks = grokAdapter.buildBlocks(lines);
      const raw = blocks[0];
      const prompt = blocks.find((b) => b.kind === "prompt-select");
      expect(raw?.kind, name).toBe("raw");
      expect(prompt?.kind, name).toBe("prompt-select");
      if (raw?.kind !== "raw" || prompt?.kind !== "prompt-select") return;
      // The renderer never repeats the question (aria only) — the mirror above must carry it,
      // and the replaced region must begin at the first lifted row.
      expect(raw.lines.map(lineText).join("\n"), name).toContain(question);
      expect(lineText(prompt.lines[0]!), name).toMatch(/^\s*[┃│]\s+[1-9z]\s/);
    }
  });

  it("wrapped option descriptions still lift and keep the label intact", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-r3-wrap.txt"), "utf8")));
    const ask = detectAskRegion(lines);
    expect(ask).not.toBeNull();
    expect(ask!.model.options.map((o) => o.label)).toEqual(["APAC", "EMEA", "AMER", "ANZ-only", "Global"]);
    expect(ask!.model.options[0]!.description).toMatch(/Sydney/);
    expect(ask!.model.options[0]!.label).toBe("APAC");
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
  });

  it("checkbox asks lift as multi-select with Tab/Space/Enter, never digits", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-multi.txt"), "utf8")));
    expect(detectAskRegion(lines)).toBeNull();
    const region = detectCheckboxAskRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.model.phase).toBe("checkbox");
    if (region!.model.phase !== "checkbox") return;
    expect(region!.model.recipe).toBe("tab-space-enter");
    expect(region!.model.question).toBe("Which toppings?");
    expect(region!.model.options.map((o) => o.label)).toEqual(["Cheese", "Pepperoni", "Mushrooms", "Olives"]);
    expect(region!.model.options.map((o) => o.checked)).toEqual([false, false, false, false]);
    expect(region!.model.focusedN).toBe(1);
    expect(region!.model.escape).toBeNull();
    expect(region!.model.parked).toBeUndefined();
    expect(region!.model.steps).toBeNull();
    const blocks = grokAdapter.buildBlocks(lines);
    const multi = blocks.find((b) => b.kind === "multi-select");
    expect(multi?.kind).toBe("multi-select");
    expect(grokAdapter.composerReady!(lines)).toBe(false);
    expect(checkboxAskPresent(lines)).toBe(true);
    expect(grokAdapter.needsDump!(lines)).toBe(false);
  });

  it("esc-parked checkbox still lifts; parked so the walk Tabs to re-enter", () => {
    const ansi = readFileSync(join(PANES_DIR, "grok--ask-multi.txt"), "utf8");
    expect(ansi).toContain(":next answer");
    const lines = splitLines(parseAnsi(ansi.replace(":next answer", "/Space:question")));
    expect(detectAskRegion(lines)).toBeNull();
    const region = detectCheckboxAskRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.model.phase).toBe("checkbox");
    if (region!.model.phase !== "checkbox") return;
    expect(region!.model.parked).toBe(true);
    expect(region!.model.recipe).toBe("tab-space-enter");
    expect(region!.model.options.map((o) => o.label)).toEqual(["Cheese", "Pepperoni", "Mushrooms", "Olives"]);
    const multi = grokAdapter.buildBlocks(lines).find((b) => b.kind === "multi-select");
    expect(multi?.kind).toBe("multi-select");
    expect(grokAdapter.needsDump!(lines)).toBe(false);
  });

  it("checkbox lift reads [x] and the colour highlight", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-multi-checked.txt"), "utf8")));
    const region = detectCheckboxAskRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.model.phase).toBe("checkbox");
    if (region!.model.phase !== "checkbox") return;
    expect(region!.model.options.map((o) => o.checked)).toEqual([false, true, false]);
    expect(region!.model.focusedN).toBe(2);
    expect(region!.model.options.map((o) => o.label)).toEqual(["Cheese", "Pepperoni", "Mushrooms"]);
  });

  it("checkbox wizard [1/2] lifts as multi-select with stepper, Submit, never digits", () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-multi-wizard-q1.txt"), "utf8")),
    );
    expect(detectAskRegion(lines)).toBeNull();
    expect(detectAskWizardRegion(lines)).toBeNull();
    const region = detectCheckboxAskRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.model.phase).toBe("checkbox");
    if (region!.model.phase !== "checkbox") return;
    expect(region!.model.recipe).toBe("tab-space-enter");
    expect(region!.model.advanceLabel).toBe("Submit");
    expect(region!.model.escape).toBeNull();
    expect(region!.model.parked).toBeUndefined();
    expect(region!.model.steps).toEqual([
      { label: "1/2", answered: false, current: true },
      { label: "2/2", answered: false, current: false },
    ]);
    expect(region!.model.question).toBe("Which toppings?");
    expect(region!.model.options.map((o) => o.label)).toEqual(["Cheese", "Pepperoni", "Mushrooms", "Olives"]);
    expect(region!.model.options.every((o) => !o.checked)).toBe(true);
    expect(region!.model.focusedN).toBe(1);

    const blocks = grokAdapter.buildBlocks(lines);
    expect(blocks[0]?.kind).toBe("raw");
    expect(blocks.some((b) => b.kind === "wizard")).toBe(false);
    expect(blocks.some((b) => b.kind === "prompt-select")).toBe(false);
    const multis = blocks.filter((b) => b.kind === "multi-select");
    expect(multis.length).toBe(1);

    expect(grokAdapter.composerReady!(lines)).toBe(false);
    expect(checkboxAskPresent(lines)).toBe(true);
    expect(grokAdapter.needsDump!(lines)).toBe(false);
  });

  it("checkbox wizard fallbacks", () => {
    const ansi = readFileSync(join(PANES_DIR, "grok--ask-multi-wizard-q1.txt"), "utf8");

    // Parked (":next answer" -> "/Space:question")
    expect(ansi.split(":next answer").length).toBe(2);
    const parkedLines = splitLines(parseAnsi(ansi.replace(":next answer", "/Space:question")));
    const parkedRegion = detectCheckboxAskRegion(parkedLines);
    expect(parkedRegion).not.toBeNull();
    expect(parkedRegion!.model.phase).toBe("checkbox");
    if (parkedRegion!.model.phase === "checkbox") {
      expect(parkedRegion!.model.parked).toBe(true);
      expect(parkedRegion!.model.steps).toBeNull();
    }
    const parkedMulti = grokAdapter.buildBlocks(parkedLines).find((b) => b.kind === "multi-select");
    expect(parkedMulti?.kind).toBe("multi-select");
    expect(grokAdapter.needsDump!(parkedLines)).toBe(false);

    // "[1/2]" -> "[2/2]"
    expect(ansi.split("[1/2]").length).toBe(2);
    const q2Lines = splitLines(parseAnsi(ansi.replace("[1/2]", "[2/2]")));
    const q2Region = detectCheckboxAskRegion(q2Lines);
    expect(q2Region).not.toBeNull();
    expect(q2Region!.model.phase).toBe("checkbox");
    if (q2Region!.model.phase === "checkbox") {
      expect(q2Region!.model.steps).toEqual([
        { label: "1/2", answered: false, current: false },
        { label: "2/2", answered: false, current: true },
      ]);
      expect(q2Region!.model.advanceLabel).toBe("Submit");
    }

    // "[1/2]" -> "[1/1]"
    expect(ansi.split("[1/2]").length).toBe(2);
    const oneOfOneLines = splitLines(parseAnsi(ansi.replace("[1/2]", "[1/1]")));
    const oneOfOneRegion = detectCheckboxAskRegion(oneOfOneLines);
    expect(oneOfOneRegion).not.toBeNull();
    expect(oneOfOneRegion!.model.phase).toBe("checkbox");
    if (oneOfOneRegion!.model.phase === "checkbox") {
      expect(oneOfOneRegion!.model.steps).toBeNull();
    }

    // "[1/2]" -> "[3/2]"
    const threeOfTwoLines = splitLines(parseAnsi(ansi.replace("[1/2]", "[3/2]")));
    expect(detectCheckboxAskRegion(threeOfTwoLines)).toBeNull();
    expect(grokAdapter.buildBlocks(threeOfTwoLines).some((b) => b.kind === "multi-select")).toBe(false);
    expect(grokAdapter.needsDump!(threeOfTwoLines)).toBe(true);

    // Step identity: multiSelectEquals on the models from [1/2] and [2/2] is false
    const q1Region = detectCheckboxAskRegion(splitLines(parseAnsi(ansi)));
    expect(q1Region).not.toBeNull();
    expect(q2Region).not.toBeNull();
    expect(multiSelectEquals(q1Region!.model, q2Region!.model)).toBe(false);
  });

  it("needsDump is only the unlifted checkbox ask, not radio or idle", () => {
    const radio = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-color.txt"), "utf8")));
    const idle = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--fresh-idle.txt"), "utf8")));
    expect(detectAskRegion(radio)).not.toBeNull();
    expect(checkboxAskPresent(radio)).toBe(false);
    expect(grokAdapter.needsDump!(radio)).toBe(false);
    expect(grokAdapter.needsDump!(idle)).toBe(false);
  });

  it("esc-parked ask with leftover z draft still lifts and prefixes Tab", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-esc-park-typed.txt"), "utf8")));
    const ask = detectAskRegion(lines);
    expect(ask).not.toBeNull();
    expect(ask!.model.feedback).toEqual({ key: "z", focused: false, text: "hi", purpose: "free-text" });
    expect(ask!.model.options[0]!.keys).toEqual(["Tab", "1"]);
  });

  it("z-focused ask with a bullet mark and ASCII > still locks as free-text", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-z-bullet.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.feedback).toEqual({
      key: "z",
      focused: true,
      text: "",
      purpose: "free-text",
    });
  });

  it("z-focused ask carries feedback and refuses a digit answer", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-z-focused.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.feedback).toEqual({
      key: "z",
      focused: true,
      text: "",
      purpose: "free-text",
    });
  });

  it("z-typed ask carries the typed text as free-text, not a plan-change row", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-z-typed.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    expect(prompt.prompt.feedback).toEqual({
      key: "z",
      focused: true,
      text: "med",
      purpose: "free-text",
    });
  });

  it("esc-parked ask still lifts, with Tab prepended — a bare digit is swallowed in scrollback", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-esc-park.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    // Probed 2026-08-22: parked digit = no-op; Tab (the footer's own key) re-enters, then the
    // digit answers. The badge keeps showing the digit, not Tab.
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([
      ["Tab", "1"],
      ["Tab", "2"],
    ]);
    expect(prompt.prompt.options.map((o) => o.keyLabel)).toEqual(["1", "2"]);
    expect(grokAdapter.composerReady!(lines)).toBe(false);
  });

  it("z-parked ask locks the buttons — Enter:edit means digits would type into the field", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-z-parked.txt"), "utf8")));
    const prompt = grokAdapter.buildBlocks(lines).find((b) => b.kind === "prompt-select");
    expect(prompt?.kind).toBe("prompt-select");
    if (prompt?.kind !== "prompt-select") return;
    // The z row reads idle (`z (○)`) and the global footer says Tab:next answer — the inner
    // Enter:edit hint is the one tell that the keyboard is still on the free-text row.
    expect(prompt.prompt.feedback?.focused).toBe(true);
    expect(prompt.prompt.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
    expect(grokAdapter.composerReady!(lines)).toBe(false);
  });

  it("q1 lifts as a wizard with step chrome", () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-wizard-q1.txt"), "utf8")),
    );
    const blocks = grokAdapter.buildBlocks(lines);
    expect(blocks.some((b) => b.kind === "prompt-select")).toBe(false);
    const wizards = blocks.filter((b) => b.kind === "wizard");
    expect(wizards.length).toBe(1);
    expect(blocks[0]?.kind).toBe("raw");

    const wizardBlock = wizards[0]!;
    expect(wizardBlock.wizard.phase).toBe("question");
    if (wizardBlock.wizard.phase !== "question") return;

    expect(wizardBlock.wizard.steps).toEqual([
      { label: "1/2", answered: false, current: true },
      { label: "2/2", answered: false, current: false },
    ]);
    expect(wizardBlock.wizard.question).toBe("Which layout?");
    expect(wizardBlock.wizard.options.map((o) => o.label)).toEqual(["Grid", "List"]);
    expect(wizardBlock.wizard.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
    expect(wizardBlock.wizard.options[0]!.description).toBe("Card-style tiled layout");
    expect(wizardBlock.wizard.options.every((o) => !o.chosen && !o.escape)).toBe(true);

    expect(lineText(wizardBlock.lines[0]!)).toContain("Which layout?");
    expect(blocks[0]!.lines.map(lineText).join("\n")).not.toMatch(/[┃│]\s*Which layout\?/);
    expect(grokAdapter.composerReady!(lines)).toBe(false);
  });

  it("q2 derives Q2 radios on its own", () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-wizard-q2.txt"), "utf8")),
    );
    const blocks = grokAdapter.buildBlocks(lines);
    const wizardBlock = blocks.find((b) => b.kind === "wizard");
    expect(wizardBlock?.kind).toBe("wizard");
    if (wizardBlock?.kind !== "wizard") return;

    expect(wizardBlock.wizard.phase).toBe("question");
    if (wizardBlock.wizard.phase !== "question") return;

    expect(wizardBlock.wizard.steps[1]!.current).toBe(true);
    expect(wizardBlock.wizard.steps[0]!.current).toBe(false);
    expect(wizardBlock.wizard.question).toBe("Dark mode?");
    expect(wizardBlock.wizard.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(wizardBlock.wizard.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
  });

  it("a stale Q1 tap cannot land on Q2", () => {
    const q1Lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-wizard-q1.txt"), "utf8")),
    );
    const q2Lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "grok--ask-wizard-q2.txt"), "utf8")),
    );
    const q1Region = detectAskWizardRegion(q1Lines);
    const q2Region = detectAskWizardRegion(q2Lines);
    expect(q1Region).not.toBeNull();
    expect(q2Region).not.toBeNull();
    expect(q1Region!.model.signature).not.toBe(q2Region!.model.signature);
    expect(wizardsEqual(q1Region!.model, q2Region!.model)).toBe(false);
    expect(WIZARD_NEXT_KEYS).toEqual(["Right"]);
    expect(WIZARD_BACK_KEYS).toEqual(["Left"]);
  });

  it("1Q radio unchanged", () => {
    const fixtures1Q = [
      "grok--ask-color.txt",
      "grok--ask-color-moved.txt",
      "grok--ask-light-gutter.txt",
      "grok--ask-r3-wrap.txt",
      "grok--ask-size.txt",
      "grok--ask-esc-park.txt",
      "grok--ask-esc-park-typed.txt",
      "grok--ask-z-bullet.txt",
      "grok--ask-z-focused.txt",
      "grok--ask-z-parked.txt",
      "grok--ask-z-typed.txt",
    ];
    for (const name of fixtures1Q) {
      const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
      expect(detectAskWizardRegion(lines), name).toBeNull();
      const blocks = grokAdapter.buildBlocks(lines);
      expect(blocks.some((b) => b.kind === "prompt-select"), name).toBe(true);
      expect(blocks.some((b) => b.kind === "wizard"), name).toBe(false);
    }
  });

  it("fallbacks on the wizard fixture", () => {
    const ansi = readFileSync(join(PANES_DIR, "grok--ask-wizard-q1.txt"), "utf8");

    // Footer ":next answer" changed to "/Space:question" (parked)
    expect(ansi.split(":next answer").length).toBe(2);
    const parkedLines = splitLines(parseAnsi(ansi.replace(":next answer", "/Space:question")));
    expect(detectAskWizardRegion(parkedLines)).toBeNull();
    const parkedPrompt = grokAdapter.buildBlocks(parkedLines).find((b) => b.kind === "prompt-select");
    expect(parkedPrompt?.kind).toBe("prompt-select");
    if (parkedPrompt?.kind === "prompt-select") {
      expect(parkedPrompt.prompt.options[0]!.keys).toEqual(["Tab", "1"]);
    }

    // Hint select verb changed to edit (z-park)
    expect(ansi.split("select").length).toBe(2);
    const editLines = splitLines(parseAnsi(ansi.replace("select", "edit")));
    expect(detectAskWizardRegion(editLines)).toBeNull();
    const editPrompt = grokAdapter.buildBlocks(editLines).find((b) => b.kind === "prompt-select");
    expect(editPrompt?.kind).toBe("prompt-select");
    if (editPrompt?.kind === "prompt-select") {
      expect(editPrompt.prompt.feedback?.focused).toBe(true);
    }

    // "[1/2]" changed to "[1/1]"
    expect(ansi.split("[1/2]").length).toBe(2);
    const oneOfOneLines = splitLines(parseAnsi(ansi.replace("[1/2]", "[1/1]")));
    expect(detectAskWizardRegion(oneOfOneLines)).toBeNull();
    const oneOfOnePrompt = grokAdapter.buildBlocks(oneOfOneLines).find((b) => b.kind === "prompt-select");
    expect(oneOfOnePrompt?.kind).toBe("prompt-select");

    // "[1/2]" changed to "[3/2]"
    const threeOfTwoLines = splitLines(parseAnsi(ansi.replace("[1/2]", "[3/2]")));
    expect(detectAskWizardRegion(threeOfTwoLines)).toBeNull();
    const threeOfTwoPrompt = grokAdapter.buildBlocks(threeOfTwoLines).find((b) => b.kind === "prompt-select");
    expect(threeOfTwoPrompt?.kind).toBe("prompt-select");
  });

  it("a footer without the plan preview is not a live menu", () => {
    const lines = splitLines(parseAnsi("ordinary output\na:approve │ q:quit plan"));
    expect(detectPlanMenuRegion(lines)).toBeNull();
    expect(grokAdapter.buildBlocks(lines).every((b) => b.kind === "raw")).toBe(true);
  });

  it("output below a plan card does not keep the composer writable or eat the new lines", () => {
    const base = readFileSync(join(PANES_DIR, "grok--plan-approval.txt"), "utf8");
    const lines = splitLines(parseAnsi(`${base}\nlater output\nmore output`));
    expect(detectPlanMenuRegion(lines)).toBeNull();
    expect(locateComposer(lines)).toBeNull();
    expect(grokAdapter.composerReady!(lines)).toBe(false);
    expect(grokAdapter.composerPrompt!(lines)).toBeNull();
    const stripped = stripChrome(lines);
    expect(stripped.map(lineText).join("\n")).toMatch(/later output/);
    expect(stripped.map(lineText).join("\n")).toMatch(/more output/);
  });

  const PERMISSION_FOOTER = (n: number) =>
    `  1/${n}:select  │  Tab:next option  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback`;
  const LIGHT_PERMISSION_FOOTER = (n: number) =>
    `  1/${n}:select  │  Tab:next option  │  ←/→:scope  │  e:edit pattern  │  Ctrl+o:always-approve  │  Ctrl+c:cancel  │  Esc:scrollback`;
  const lightPermission = (rows: string[], footer: string = LIGHT_PERMISSION_FOOTER(rows.length)) =>
    ["  │  Remove hello.txt file", "  │  rm hello.txt", "  │  ← → narrow scope  ·  e edit pattern", "  │", ...rows.map((row) => `  │  ${row}`), "  │", footer].join("\n");

  it("permission refuses a card with no reject row", () => {
    const spoof = [
      "  ┃  Sneaky",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  3 (●) Yes, done",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a light-gutter card with Yes below the reject", () => {
    const spoof = lightPermission([
      "1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "2 (○) No, reject (type to add feedback)",
      "3 (○) Yes, proceed",
      "4 (○) Never allow: rm hello.txt",
    ]);
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a light-gutter card with two reject rows", () => {
    const spoof = lightPermission([
      "1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "2 (○) Yes, proceed",
      "3 (○) No, reject (type to add feedback)",
      "4 (○) No, reject (type to add feedback)",
    ]);
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a light-gutter card with an unclassified Maybe row", () => {
    const spoof = lightPermission([
      "1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "2 (○) Yes, proceed",
      "3 (○) No, reject (type to add feedback)",
      "4 (○) Maybe later",
    ]);
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a bullet card with the ordinary shortcut bar", () => {
    const spoof = lightPermission(
      [
        "1 (•) Yes, and don't ask again for anything (always-approve mode)",
        "2 (○) Yes, proceed",
        "3 (○) No, reject (type to add feedback)",
      ],
      "  Shift+Tab:mode  │  Ctrl+x:shortcuts",
    );
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a multi-digit option number", () => {
    const spoof = [
      "  ┃  Sneaky",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  12 (○) Yes, proceed",
      "  ┃  3 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a duplicate digit even when the labels look right", () => {
    const spoof = [
      "  ┃  Sneaky",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  3 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(4),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a shuffle of the probed labels", () => {
    const spoof = [
      "  ┃  Sneaky",
      "  ┃  3 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  1 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses an upper row it cannot prove is a persistent mode change", () => {
    const spoof = [
      "  ┃  Allow Edit to /tmp/x?",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, just for this file",
      "  ┃  3 (●) Yes",
      "  ┃  4 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(4),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a Yes row that is itself a persistent mode change", () => {
    const spoof = [
      "  ┃  Allow Edit to /tmp/x?",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, allow all edits during this session",
      "  ┃  3 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a card whose rows disagree with the footer's 1/N count", () => {
    const spoof = [
      "  ┃  Remove hello.txt as requested",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  3 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(4),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a bare Yes/No pair — the footer promises an always-approve row", () => {
    const spoof = [
      "  ┃  Allow Edit to /tmp/x?",
      "  ┃  1 (○) Yes",
      "  ┃  2 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(2),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a card carrying an unclassified control row — no partial lift", () => {
    const spoof = [
      "  ┃  Allow Edit to /tmp/x?",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (●) Yes",
      "  ┃  x [ ] unclassified extra action",
      "  ┃  3 (○) No, reject (type to add feedback)",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses unclassified text below the options", () => {
    const spoof = [
      "  ┃  Allow Edit to /tmp/x?",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (●) Yes",
      "  ┃  3 (○) No, reject (type to add feedback)",
      "  ┃  some extra prose the captures never painted here",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses a light-gutter card ending in the ordinary shortcut bar", () => {
    const spoof = [
      "  │  Which color?",
      "  │  1 (○) Red    Warm",
      "  │  2 (○) Green  Calm",
      "  │  z (○) Type your answer here",
      "  │  ↑/↓ navigate · y copy                                                                 Enter:submit",
      "  Shift+Tab:mode  │  Ctrl+x:shortcuts",
    ].join("\n");
    const lines = splitLines(parseAnsi(spoof));
    expect(detectAskRegion(lines)).toBeNull();
    expect(grokAdapter.buildBlocks(lines).every((b) => b.kind === "raw")).toBe(true);
  });

  it("ask refuses a mid-line │ as a gutter", () => {
    const spoof = [
      "  not a card │",
      "  │  1 (○) Red    Warm",
      "  │  2 (○) Green  Calm",
      "  │  z (○) Type your answer here",
      "  │  ↑/↓ navigate · y copy                                                                 Enter:submit",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses prose that merely contains Enter:submit — the hint must be the hint row", () => {
    const spoof = [
      "  ┃  Press Enter:submit when you are ready to continue",
      "  ┃  1 (○) Red    Warm",
      "  ┃  2 (○) Green  Calm",
      "  ┃  z (○) Type your answer here",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses unclassified text below the options", () => {
    const spoof = [
      "  ┃  Which color?",
      "  ┃  1 (○) Red    Warm",
      "  ┃  2 (○) Green  Calm",
      "  ┃  z (○) Type your answer here",
      "  ┃  some stray prose under the card",
      "  ┃  ↑/↓ navigate · y copy                                                                 Enter:submit",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a footer separated from the card by transcript", () => {
    const spoof = [
      "  ┃  Sneaky",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  3 (○) No, reject (type to add feedback)",
      "  later transcript output",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("permission refuses a footer floating far below the card — the gap is bounded", () => {
    const spoof = [
      "  ┃  Remove hello.txt as requested",
      "  ┃  1 (○) Yes, and don't ask again for anything (always-approve mode)",
      "  ┃  2 (○) Yes, proceed",
      "  ┃  3 (○) No, reject (type to add feedback)",
      "",
      "",
      "",
      "",
      PERMISSION_FOOTER(3),
    ].join("\n");
    expect(detectPermissionRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses a footer separated from the card by transcript", () => {
    const spoof = [
      "  ┃  Which color?",
      "  ┃  1 (○) Red    Warm",
      "  ┃  2 (○) Green  Calm",
      "  ┃  z (○) Type your answer here",
      "  ┃  ↑/↓ navigate · y copy                                                                 Enter:submit",
      "  later transcript output",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses a radio card with no z row", () => {
    const spoof = [
      "  ┃  Which color?",
      "  ┃  1 (○) Red    Warm",
      "  ┃  2 (○) Green  Calm",
      "  ┃  ↑/↓ navigate · y copy                                                                 Enter:submit",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses a radio card with no Enter:select/submit/edit hint", () => {
    const spoof = [
      "  ┃  Which color?",
      "  ┃  1 (○) Red    Warm",
      "  ┃  2 (○) Green  Calm",
      "  ┃  z (○) Type your answer here",
      "  ┃  ↑/↓ navigate · y copy",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("ask refuses a card that paints an a–f option row", () => {
    const spoof = [
      "  ┃  Which color?",
      "  ┃  1 (○) Red    Warm",
      "  ┃  2 (○) Green  Calm",
      "  ┃  a (○) Extra  Unprobed letter option",
      "  ┃  z (○) Type your answer here",
      "  ┃  ↑/↓ navigate · y copy                                                                 Enter:submit",
      "  Tab:next answer  │  Esc:scrollback",
    ].join("\n");
    expect(detectAskRegion(splitLines(parseAnsi(spoof)))).toBeNull();
  });

  it("an ordinary composer holding Build anything is still a draft", () => {
    const screen = [
      "  ╭────────────────────────────────────────╮",
      "  │ ❯ Build anything                       │",
      "  ╰──────────────────── Grok 4.6 (high) ─╯",
      "",
      "  Shift+Tab:mode  │  Ctrl+.:shortcuts",
    ].join("\n");
    expect(grokAdapter.extractInputDraft(splitLines(parseAnsi(screen)))).toBe("Build anything");
  });

  it("the live ASCII > composer is ready and a draft in it is readable", () => {
    const idle = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--prompt-ascii.txt"), "utf8")));
    const draft = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "grok--prompt-ascii-draft.txt"), "utf8")),
    );
    expect(grokAdapter.composerReady!(idle)).toBe(true);
    expect(grokAdapter.extractInputDraft(idle)).toBeNull();
    expect(grokAdapter.composerReady!(draft)).toBe(true);
    expect(grokAdapter.extractInputDraft(draft)).toBe("hello from the phone");
  });

  it("the startup screen's composer is usable — the [stable] chip is chrome, not a torn frame", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--startup.txt"), "utf8")));
    expect(grokAdapter.composerReady!(lines)).toBe(true);
    const [block] = grokAdapter.buildBlocks(lines);
    expect(block?.kind).toBe("raw");
    if (block?.kind !== "raw") return;
    const text = block.lines.map(lineText).join("\n");
    // The composer box and the chip row are stripped; the welcome banner box stays as content.
    expect(text).not.toContain("[stable]");
    expect(text).not.toContain("❯");
    expect(text).toContain("Grok 4.6 is here!");
  });

  it("Grok Build 1.0.13's startup chip is chrome — the first send is not refused", () => {
    const lines = splitLines(
      parseAnsi(readFileSync(join(PANES_DIR, "grok--startup-build-chip.txt"), "utf8")),
    );
    expect(grokAdapter.composerReady!(lines)).toBe(true);
    const [block] = grokAdapter.buildBlocks(lines);
    expect(block?.kind).toBe("raw");
    if (block?.kind !== "raw") return;
    const text = block.lines.map(lineText).join("\n");
    expect(text).not.toContain("[stable]");
    expect(text).not.toContain("Grok Build  1.0.13");
    expect(text).not.toMatch(/│\s*>/);
  });

  it("blank rows render unpainted in every block; glyph rows keep their backgrounds", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--permission-edit.txt"), "utf8")));
    // The live frame paints base-coat colour across fully blank rows (the gray-stripe bug) and
    // rgb(36,36,36) as the dialog card's elevated surface. Only empty rows lose their paint.
    const hadPaintedBlank = lines.some(
      (l) => l.segments.every((s) => s.text.trim() === "") &&
        l.segments.some((s) => s.style.backgroundColor !== undefined),
    );
    expect(hadPaintedBlank).toBe(true);
    const rendered = grokAdapter.buildBlocks(lines).flatMap((b) => b.lines);
    for (const l of rendered) {
      if (l.segments.every((s) => s.text.trim() === "")) {
        expect(l.segments.every((s) => s.style.backgroundColor === undefined)).toBe(true);
      }
    }
    expect(
      rendered.some((l) => l.segments.some((s) => s.style.backgroundColor === "rgb(36,36,36)")),
    ).toBe(true);
  });

  it("the raw block is the chrome-stripped buffer, not the original", () => {
    const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "grok--fresh-idle.txt"), "utf8")));
    const [block] = grokAdapter.buildBlocks(lines);
    expect(block?.kind).toBe("raw");
    if (block?.kind !== "raw") return;
    const text = block.lines.map(lineText).join("\n");
    expect(text).not.toContain("╭");
    expect(lines.map(lineText).join("\n")).toContain("╭");
  });
});
