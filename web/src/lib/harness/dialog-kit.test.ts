import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { verifyExpectedPrompt } from "@shared/prompt-binding";
import { parseLines, type Block } from "../blocks";
import {
  BOUND_TEXT_LINES,
  boundTextOf,
  DIALOG_KIT_AGENTS,
  dialogModel,
  dialogPipeline,
  dialogRegion,
  freeTextModel,
  parseDialog,
} from "./dialog-kit";
import { DIALOG_CONTRACT } from "./dialog-contract";
import { WIZARD_CANCEL_KEYS, WIZARD_SUBMIT_KEYS } from "./wizard-model";
import { ADAPTER_AGENTS, adapterFor } from "./registry";

// The bridge parses a blocked pane's screen with parseDialog and answers it with the option's keys.
// It must lift exactly what the phone's adapter lifts from the same screen, or a card would offer a
// button the phone would not (or the reverse). Same contract as dialog-sniff.test.ts.

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");
const raw = (file: string) => readFileSync(join(PANES_DIR, file), "utf8");
const fixtures = (prefix: string) =>
  readdirSync(PANES_DIR)
    .filter((f) => f.startsWith(`${prefix}--`) && f.endsWith(".txt"))
    .sort();

/** Fixture prefix per agent string (antigravity shares agy's captures). */
const PREFIX: Record<string, string> = { claude: "claude", cursor: "cursor", agy: "agy", antigravity: "agy", grok: "grok", pi: "pi" };

type DialogBlock = Exclude<Block, { kind: "raw" } | { kind: "autocomplete" }>;
const adapterDialog = (agent: string, file: string): DialogBlock | undefined =>
  adapterFor(agent)!
    .buildBlocks(parseLines(raw(file)))
    .findLast((b): b is DialogBlock => b.kind !== "raw" && b.kind !== "autocomplete");

const CASES = DIALOG_KIT_AGENTS.flatMap((agent) => fixtures(PREFIX[agent]!).map((file) => [agent, file] as const));

describe("dialog kit — the adapters' own pipelines", () => {
  it("covers exactly the agents that have adapters", () => {
    expect([...DIALOG_KIT_AGENTS].sort()).toEqual([...ADAPTER_AGENTS].sort());
  });

  it.each([...ADAPTER_AGENTS])("%s: the pipeline is the adapter's buildBlocks", (agent) => {
    expect(dialogPipeline(agent)).toBe(adapterFor(agent)!.buildBlocks);
  });

  it("has fixtures with and without dialogs", () => {
    expect(CASES.some(([a, f]) => adapterDialog(a, f) !== undefined)).toBe(true);
    expect(CASES.some(([a, f]) => adapterDialog(a, f) === undefined)).toBe(true);
  });
});

describe("parseDialog — agrees with the adapter on every fixture", () => {
  it.each(CASES)("%s %s", (agent, file) => {
    const block = adapterDialog(agent, file);
    const parsed = parseDialog(agent, raw(file));
    if (!block) {
      expect(parsed === null || parsed.kind === "password").toBe(true);
      return;
    }
    expect(parsed).not.toBeNull();
    const p = parsed!;
    // The binding the bridge will re-check is on the screen it came from, inside the matcher's tail.
    expect(verifyExpectedPrompt(raw(file), p.boundText)).toEqual({ ok: true });
    const regionBound = block.kind === "wizard" || block.kind === "multi-select" || block.kind === "preview-select";
    if (!regionBound) expect(p.boundText.split("\n").length).toBeLessThanOrEqual(BOUND_TEXT_LINES);
    switch (block.kind) {
      case "prompt-select": {
        const model = block.prompt;
        if (model.decision) {
          expect(p.via).toBe("whistlr");
          expect(p.options.every((o) => o.keys.length === 0)).toBe(true);
          break;
        }
        expect(p.kind).toBe(model.family === "permission" ? "permission" : model.family === "trust" ? "trust" : "question");
        // A trust question the terminal wrapped is rejoined (unwrapPrompt); it starts with the adapter's line.
        if (p.kind === "trust") expect(p.prompt.startsWith(model.question)).toBe(true);
        else expect(p.prompt).toBe(model.question);
        if (model.feedback?.focused) expect(p.options).toEqual([]);
        else expect(p.options.map((o) => ({ label: o.label, keys: o.keys }))).toEqual(model.options.map((o) => ({ label: o.label, keys: o.keys })));
        break;
      }
      case "menu":
        expect(p.kind).toBe("menu");
        expect(p.prompt).toBe(block.menu.title);
        expect(p.options.map((o) => o.keys)).toEqual(block.menu.actions.map((a) => a.keys));
        break;
      case "wizard": {
        // T17: the model's region binds; each step is answered by its option's own keys.
        const model = block.wizard;
        expect(p.kind).toBe("question");
        expect(p.boundText).toBe(dialogRegion("wizard", model));
        expect(p.steps).toEqual(model.steps.length > 0 ? model.steps : undefined);
        if (model.phase === "question") {
          expect(p.prompt).toBe(model.question);
          if (model.feedback?.editing) expect(p.options).toEqual([]);
          else {
            expect(p.options.map((o) => o.keys)).toEqual(model.options.map((o) => o.keys));
            expect(p.options.map((o) => o.destructive === true)).toEqual(model.options.map((o) => o.escape));
          }
        } else {
          expect(p.prompt).toBe("Review your answers");
          expect(p.answers ?? []).toEqual(model.answers);
          const submit = model.submitKeys === null ? [] : [model.submitKeys ?? WIZARD_SUBMIT_KEYS];
          expect(p.options.map((o) => o.keys)).toEqual([...submit, model.cancelKeys ?? WIZARD_CANCEL_KEYS]);
          expect(p.options.at(-1)!.destructive).toBe(true);
        }
        break;
      }
      case "multi-select": {
        const model = block.multi;
        expect(p.kind).toBe("question");
        expect(p.boundText).toBe(dialogRegion("multi-select", model));
        if (model.phase === "checkbox") {
          expect(p.prompt).toBe(model.question);
          expect(p.multiSelect).toEqual({ checked: model.options.map((o) => o.checked), advanceLabel: model.advanceLabel });
          expect(p.options.slice(0, model.options.length).map((o) => o.label)).toEqual(model.options.map((o) => o.label));
          // Claude toggles by digit; Grok and Cursor need the walk, so their boxes carry no keys.
          expect(p.options.slice(0, model.options.length).map((o) => o.keys)).toEqual(
            model.options.map((o) => (model.recipe === undefined ? [String(o.n)] : [])),
          );
          expect(p.options.length).toBe(model.options.length + (model.escape ? 1 : 0));
          if (model.escape) expect(p.options.at(-1)).toMatchObject({ label: model.escape.label, destructive: true });
          expect(p.steps).toEqual(model.steps ?? undefined);
        } else {
          expect(p.multiSelect).toBeUndefined();
          expect(p.options.map((o) => [o.label, o.keys])).toEqual([
            ["Submit", ["1"]],
            ["Cancel", ["2"]],
          ]);
          expect(p.answers ?? []).toEqual(model.answers);
        }
        break;
      }
      case "preview-select": {
        const model = block.preview;
        expect(p.kind).toBe("question");
        expect(p.prompt).toBe(model.question);
        expect(p.boundText).toBe(dialogRegion("preview-select", model));
        const pointed = model.options.findIndex((o) => o.pointed);
        expect(p.preview).toEqual({ optionIndex: pointed, lines: model.preview });
        if (model.note.state === "editing") expect(p.options).toEqual([]);
        else expect(p.options.map((o) => o.keys)).toEqual(model.options.map((o) => [String(o.n)]));
        expect(p.steps).toEqual(model.steps ?? undefined);
        break;
      }
    }
    // The bridge's recipes re-derive the same model from the same screen.
    if (regionBound) {
      const model = dialogModel(agent, raw(file), block.kind);
      expect(model).not.toBeNull();
      expect((DIALOG_CONTRACT[block.kind].commits as (a: unknown, b: unknown) => boolean)(model, block.kind === "wizard" ? block.wizard : block.kind === "multi-select" ? block.multi : block.preview)).toBe(true);
    }
  });
});

describe("parseDialog — kinds and fields", () => {
  it("a Claude permission prompt is a permission with the adapter's digits", () => {
    const p = parseDialog("claude", raw("claude--permission-bash.txt"))!;
    expect(p.kind).toBe("permission");
    expect(p.prompt).toBe("Do you want to proceed?");
    expect(p.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(p.options.some((o) => o.destructive)).toBe(false); // Claude has no deny list
  });

  it("trust prompts are trust", () => {
    expect(parseDialog("claude", raw("claude--trust-prompt.txt"))?.kind).toBe("trust");
    expect(parseDialog("cursor", raw("cursor--trust-workspace.txt"))?.kind).toBe("trust");
  });

  it("ask cards and plan approvals are questions", () => {
    expect(parseDialog("cursor", raw("cursor--ask-fruit.txt"))?.kind).toBe("question");
    expect(parseDialog("grok", raw("grok--ask-color.txt"))?.kind).toBe("question");
    expect(parseDialog("claude", raw("claude--select-menu.txt"))?.kind).toBe("question");
    expect(parseDialog("claude", raw("claude--plan-approval.txt"))?.kind).toBe("question");
  });

  it("the generic menu is a menu, its Esc marked destructive", () => {
    const p = parseDialog("claude", raw("claude--menu-model-picker.txt"))!;
    expect(p.kind).toBe("menu");
    expect(p.options.length).toBeGreaterThan(0);
    for (const o of p.options) expect(o.destructive === true).toBe(o.keys.includes("Escape"));
  });

  it("marks the adapters' own deny rows", () => {
    const cursor = parseDialog("cursor", raw("cursor--permission-command.txt"))!;
    expect(cursor.options.map((o) => [o.label, o.destructive === true])).toEqual([
      ["Run (once)", false],
      ["Skip", true],
    ]);
    const grok = parseDialog("grok", raw("grok--permission-rm.txt"))!;
    expect(grok.kind).toBe("permission");
    expect(grok.options.at(-1)!.destructive).toBe(true);
    expect(grok.options[0]!.destructive).toBeUndefined();
  });

  it("a Claude wizard step: digits answer, the stepper rides along, Chat about this aborts", () => {
    const p = parseDialog("claude", raw("claude--wizard-q2.txt"))!;
    expect(p).toMatchObject({ kind: "question", prompt: "What scope should this work have?" });
    expect(p.options.map((o) => [o.label, o.keys, o.destructive === true])).toEqual([
      ["Small", ["1"], false],
      ["Medium", ["2"], false],
      ["Large", ["3"], false],
      ["Chat about this", ["5"], true],
    ]);
    expect(p.steps).toEqual([
      { label: "Focus area", answered: true, current: false },
      { label: "Scope", answered: false, current: true },
      { label: "Workflow", answered: false, current: false },
    ]);
    expect(p.multiSelect).toBeUndefined();
  });

  it("a wizard review lists the answers with Submit and Cancel", () => {
    const p = parseDialog("claude", raw("claude--wizard-submit.txt"))!;
    expect(p.prompt).toBe("Review your answers");
    expect(p.answers).toEqual([
      { question: "Which focus area should we work on?", answer: "UI" },
      { question: "What scope should this work have?", answer: "Medium" },
      { question: "How should we approach the work?", answer: "Plan first" },
    ]);
    expect(p.options).toEqual([
      { label: "Submit", keys: ["1"] },
      { label: "Cancel", keys: ["2"], destructive: true },
    ]);
    // Pi submits with Enter and cancels with Escape.
    expect(parseDialog("pi", raw("pi--ask-wizard-submit.txt"))!.options.map((o) => o.keys)).toEqual([["Enter"], ["Escape"]]);
  });

  it("the live Pi ask (2026-10-18) is a question card walked by arrows, the free-text row left out", () => {
    const p = parseDialog("pi", raw("pi--ask-radio-recommended.txt"))!;
    expect(p.kind).toBe("question");
    expect(p.prompt).toBe("Pick an animal");
    expect(p.options.map((o) => [o.label, o.keys])).toEqual([
      ["Cat (Recommended)", ["Enter"]],
      ["Dog", ["Down", "Enter"]],
    ]);
    expect(p.options.every((o) => o.description !== undefined && o.destructive === undefined)).toBe(true);
    // Bound to the frame and Pi's footer, not to the transcript above it.
    const bound = p.boundText.split("\n");
    expect(bound).toContain("> 1. Cat (Recommended)");
    expect(bound).toContain(" ↑↓ navigate • Enter select • Esc cancel");
    expect(bound.at(-1)).toMatch(/^↑4 ↓443 .*1\.1%\/1\.0M \(auto\)/);
  });

  it("a Pi multi-question card: the picked row's ✓ rides along, and the steps can be walked", () => {
    const picked = raw("pi--ask-wizard-q1.txt").replace("2. Green", "2. Green ✓");
    const p = parseDialog("pi", picked)!;
    expect(p.options.map((o) => [o.label, o.chosen === true])).toEqual([
      ["Red", false],
      ["Green", true],
      ["Blue", false],
    ]);
    expect(p.navigable).toBe(true);
    // The same card with nothing picked is a different screen, so a different request.
    expect(parseDialog("pi", raw("pi--ask-wizard-q1.txt"))!.boundText).not.toBe(p.boundText);
    // The review step can go back too.
    expect(parseDialog("pi", raw("pi--ask-wizard-submit.txt"))!.navigable).toBe(true);
    // A single question has no steps to walk.
    expect(parseDialog("pi", raw("pi--ask-radio-recommended.txt"))!.navigable).toBeUndefined();
  });

  it("a checkbox question carries its boxes, the advance label and Chat about this", () => {
    const p = parseDialog("claude", raw("claude--select-multiselect-checked.txt"))!;
    expect(p.multiSelect).toEqual({ checked: [false, true, true, false], advanceLabel: "Submit" });
    expect(p.options.map((o) => o.label)).toEqual(["Cheese", "Mushrooms", "Olives", "Peppers", "Chat about this"]);
    expect(p.options[4]).toMatchObject({ keys: ["6"], destructive: true });
    expect(p.steps).toBeUndefined();
    const step = parseDialog("claude", raw("claude--wizard-multiselect-q1.txt"))!;
    expect(step.multiSelect).toEqual({ checked: [false, false, false, false], advanceLabel: "Next" });
    expect(step.steps?.map((s) => s.label)).toEqual(["Toppings", "Crust"]);
    const grok = parseDialog("grok", raw("grok--ask-multi-checked.txt"))!;
    expect(grok.multiSelect).toEqual({ checked: [false, true, false], advanceLabel: "Submit" });
    expect(grok.options.every((o) => o.keys.length === 0)).toBe(true);
  });

  it("a preview select carries the pointed option's pane", () => {
    const p = parseDialog("claude", raw("claude--select-preview.txt"))!;
    expect(p.options.map((o) => [o.label, o.keys])).toEqual([
      ["Boxy", ["1"]],
      ["Rounded", ["2"]],
      ["Minimal", ["3"]],
    ]);
    expect(p.preview!.optionIndex).toBe(0);
    expect(p.preview!.lines[0]).toMatch(/^┌─+┐$/);
    // While the note input is focused nothing can be answered from Sightr.
    expect(parseDialog("claude", raw("claude--select-preview-note-input.txt"))!.options).toEqual([]);
  });

  it("a draftr-marked card goes through whistlr: labels only, no keys", () => {
    const marker = "whistlr.decision thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee run=5a81defb";
    const p = parseDialog("claude", `${raw("claude--select-menu.txt")}\n${marker}\n`)!;
    expect(p).toMatchObject({ kind: "question", via: "whistlr", decision: { thread: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", run: "5a81defb" } });
    expect(p.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue", "Chat about this"]);
    expect(p.options.every((o) => o.keys.length === 0)).toBe(true);
  });

  it("a password prompt is password with no options", () => {
    const text = raw("claude--done.txt") + "\n$ sudo ls\n[sudo] password for bart: ";
    const p = parseDialog("claude", text)!;
    expect(p.kind).toBe("password");
    expect(p.prompt).toBe("[sudo] password for bart:");
    expect(p.options).toEqual([]);
  });

  it("a resting screen is null", () => {
    expect(parseDialog("claude", raw("claude--done.txt"))).toBeNull();
    expect(parseDialog("cursor", raw("cursor--fresh-idle.txt"))).toBeNull();
  });

  it("matches the agent string exactly", () => {
    const text = raw("claude--permission-bash.txt");
    for (const agent of ["Claude", "claude-code", "claude ", "shell", "", "toString", "constructor"]) {
      expect(parseDialog(agent, text)).toBeNull();
      expect(dialogPipeline(agent)).toBeUndefined();
    }
  });

  it("is null on an empty read", () => {
    expect(parseDialog("claude", "")).toBeNull();
    expect(parseDialog("claude", "\n\n  \n")).toBeNull();
  });

  it("boundText is the last 12 non-blank lines, SGR and trailing spaces removed", () => {
    const text = Array.from({ length: 20 }, (_, i) => `\x1b[1mline ${i}\x1b[0m   \n\n`).join("");
    expect(boundTextOf(text)).toBe(Array.from({ length: 12 }, (_, i) => `line ${i + 8}`).join("\n"));
  });
});

describe("dialog kit — leaf import closure", () => {
  // The bridge imports this file at runtime and its root typecheck runs before `web/` installs, so
  // nothing reachable from here may name a package (`react`, `@shared/...`, anything not relative).
  const closure = (entry: string) => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gms)) {
        const spec = m[1]!;
        if (!spec.startsWith(".")) {
          bad.push(`${file}: ${spec}`);
          continue;
        }
        const base = resolve(dirname(file), spec);
        const target = [base, `${base}.ts`, join(base, "index.ts")].find((p) => p.endsWith(".ts") && existsSync(p));
        if (!target) throw new Error(`cannot resolve ${spec} from ${file}`);
        visit(target);
      }
    };
    visit(entry);
    return { files: [...seen], bad };
  };

  it("imports no package, directly or transitively", () => {
    const { files, bad } = closure(join(import.meta.dirname, "dialog-kit.ts"));
    expect(bad).toEqual([]);
    // It really walked the adapters (a broken walker would pass vacuously).
    for (const leaf of ["claude/prompt-select.ts", "grok/ask.ts", "pi/ask.ts", "cursor/chrome.ts", "no-echo.ts"]) {
      expect(files.some((f) => f.replace(/\\/g, "/").endsWith(leaf))).toBe(true);
    }
  });
});

// ── Free text (live captures, 2026-10-18: fixtures/live-free-text) ──────────────────────────────

const LIVE_DIR = join(import.meta.dirname, "..", "..", "fixtures", "live-free-text");
const live = (file: string) => readFileSync(join(LIVE_DIR, file), "utf8");

describe("dialog kit — free-text rows", () => {
  it("an empty AskUserQuestion row makes the question freeText; the row is never an option", () => {
    const parsed = parseDialog("claude", live("claude--ask-free-text-live.txt"))!;
    expect(parsed.kind).toBe("question");
    expect(parsed.freeText).toBe(true);
    expect(parsed.options.map((o) => o.label)).toEqual(["A", "B", "Chat about this"]);
    expect(freeTextModel("claude", live("claude--ask-free-text-live.txt"))).toMatchObject({
      openKeys: ["3"],
      ready: false,
      text: "",
      typeable: true,
      submitKeys: ["Enter"],
    });
  });

  it("a row typed into: no options (digits would be typed), not freeText (the caret hazard)", () => {
    const parsed = parseDialog("claude", live("claude--ask-free-text-typed.txt"))!;
    expect(parsed.options).toEqual([]);
    expect(parsed.freeText).toBeUndefined();
    const row = freeTextModel("claude", live("claude--ask-free-text-typed.txt"))!;
    expect(row).toMatchObject({ ready: true, text: "my own answer C", typeable: false, openKeys: [] });
    // Same dialog: the pointer and the typed text do not move its identity.
    expect(row.identity).toBe(freeTextModel("claude", live("claude--ask-free-text-live.txt"))!.identity);
  });

  it("a Claude wizard step with its row typed into (wrapped footer) parses, options locked", () => {
    const parsed = parseDialog("claude", live("claude--wizard-free-text-typed.txt"))!;
    expect(parsed.kind).toBe("question");
    expect(parsed.steps?.map((s) => s.label)).toEqual(["First", "Second"]);
    expect(parsed.options).toEqual([]);
    expect(freeTextModel("claude", live("claude--wizard-free-text-typed.txt"))).toMatchObject({
      ready: true,
      text: "free one",
      typeable: false,
    });
  });

  it("Pi: arrows then Enter open the editor; the open editor is the same dialog, ready", () => {
    const closed = freeTextModel("pi", live("pi--ask-radio-live.txt"))!;
    expect(closed).toMatchObject({ openKeys: ["Down", "Down", "Enter"], ready: false, typeable: true });
    expect(parseDialog("pi", live("pi--ask-radio-live.txt"))!.freeText).toBe(true);
    const open = freeTextModel("pi", live("pi--ask-radio-editing.txt"))!;
    expect(open).toMatchObject({ openKeys: [], ready: true, text: "", typeable: true });
    expect(open.identity).toBe(closed.identity);
    const typed = freeTextModel("pi", live("pi--ask-radio-editing-typed.txt"))!;
    expect(typed).toMatchObject({ ready: true, text: "my pi answer Z", typeable: false });
    expect(typed.identity).toBe(closed.identity);
    const wizard = freeTextModel("pi", live("pi--ask-wizard-editing.txt"))!;
    expect(wizard).toMatchObject({ ready: true, text: "", typeable: true });
  });

  it("only measured rows: Grok's `z` row and a plan dialog are never typed by the bridge", () => {
    for (const file of fixtures("grok")) expect(freeTextModel("grok", raw(file))).toBeNull();
    for (const file of fixtures("claude").filter((f) => f.includes("plan"))) {
      expect(freeTextModel("claude", raw(file))).toBeNull();
      expect(parseDialog("claude", raw(file))?.freeText).toBeUndefined();
    }
  });
});

describe("a wrapped trust question is rejoined", () => {
  it("the unnumbered trust dialog's three-line sentence reads whole on the card", () => {
    expect(parseDialog("claude", raw("claude--trust-prompt-unnumbered.txt"))?.prompt).toBe(
      "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
    );
  });

  it("a one-line question is left alone", () => {
    expect(parseDialog("claude", raw("claude--trust-prompt.txt"))?.prompt).toMatch(/folder first\.$/);
    expect(parseDialog("agy", raw("agy--trust-prompt.txt"))?.prompt).toBe("Do you trust the contents of this project?");
  });
});
