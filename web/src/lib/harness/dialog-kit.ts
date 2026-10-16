// What dialog is a blocked pane showing, and which keys answer it? The BRIDGE asks this (v2 runtime
// requests, bridge/threads/request-ingest.ts): it reads the pane, parses the dialog here, publishes it
// as a card, and later sends one option's keys after the screen still matches `boundText`.
//
// Rules this file keeps (the same as dialog-sniff.ts and composer-kit.ts):
//
//   1. LEAF IMPORTS ONLY. Nothing reachable from here may import `@shared/...`, `react`, or any other
//      package: the bridge's root typecheck has no `paths` and runs before `web/` installs. Each
//      adapter's block pipeline (`<harness>/index.ts`) reaches `shared/` by relative path for that
//      reason. dialog-kit.test.ts walks the import closure and fails on a package import.
//   2. SAME PIPELINE AS THE ADAPTERS. The kit holds each adapter's own `buildBlocks`, so the bridge
//      lifts exactly the dialog the phone would lift from the same screen, in the same order (Claude's
//      preview before wizard before prompt-select before menu, and so on). The test pins each entry
//      `===` the adapter's and checks every fixture.
//   3. EXACT AGENT STRING. Never a prefix (the collie#99 reject). An agent with no adapter gets null.
//
// Nothing here invents keys. Options carry the keys the adapter's model already encodes. A wizard step
// is answered by its option's keys like any question. A checkbox (multi-select) step and a preview
// select need a closed-loop recipe (lib/dialog-recipes.ts), which the bridge runs from a fresh parse
// of the screen (`dialogModel`); their options carry the digit at most. A focused free-text row is
// published with no options and the operator answers it in the Terminal tab (T17).

import { normalizePromptRegion } from "../../../../shared/prompt-binding";
import { parseLines, type Block, type StyledLine } from "../blocks";
import { DIALOG_CONTRACT, dialogModelOf, type DialogKind, type DialogModels } from "./dialog-contract";
import { detectNoEchoPrompt } from "../no-echo";
import { agyBuildBlocks } from "./agy/index";
import { claudeBuildBlocks } from "./claude/index";
import { cursorBuildBlocks } from "./cursor/index";
import { isSkipLabel } from "./cursor/permission";
import { grokBuildBlocks } from "./grok/index";
import { isRejectLabel } from "./grok/permission";
import type { MenuModel } from "./menu-model";
import type { MultiSelectModel } from "./multi-select-model";
import { piBuildBlocks } from "./pi/index";
import type { PreviewSelectModel } from "./preview-model";
import type { PromptModel } from "./prompt-model";
import { WIZARD_CANCEL_KEYS, WIZARD_SUBMIT_KEYS, type WizardModel, type WizardStepChip } from "./wizard-model";

/** The kinds of runtime request a dialog becomes (shared/v2/contracts.ts `RuntimeRequestKind`). */
export type DialogRequestKind = "permission" | "trust" | "password" | "menu" | "question";

export interface DialogOption {
  label: string;
  /** The adapter's own recipe, one Herdr key per entry. Empty on a whistlr card. */
  keys: string[];
  /** The label is on the adapter's own deny / abort list, or the menu marks it as cancel. */
  destructive?: boolean;
  description?: string;
}

export interface DialogParse {
  kind: DialogRequestKind;
  prompt: string;
  options: DialogOption[];
  /**
   * The text the bridge binds its answer to, normalized. For a wizard, preview or checkbox dialog it
   * is the model's own `region` (DIALOG_CONTRACT), the literal dialog on screen; for every other
   * dialog the last BOUND_TEXT_LINES non-blank lines of the read.
   */
  boundText: string;
  /** T17: the stepper chips of a multi-question ask. */
  steps?: WizardStepChip[];
  /** T17: a checkbox step: box state per option (the first `checked.length` options) and the advance label. */
  multiSelect?: { checked: boolean[]; advanceLabel: string };
  /** T17: a preview select: the pointed option's preview pane. */
  preview?: { optionIndex: number; lines: string[] };
  /** T17: the echoed answers of a review step. */
  answers?: { question: string; answer: string }[];
  /** A draftr operator decision: answered through `whistlr reply`, never by typing into the pane. */
  via?: "whistlr";
  decision?: { thread: string; run: string };
}

/**
 * How many non-blank lines of the read `boundText` keeps. The prompt-binding matcher accepts a match
 * that ends inside the last 6 non-blank lines (PROMPT_TAIL_LINES); a tail of the read ends at its
 * last line, so any length fits, and 12 holds the option rows plus the question on every fixture.
 */
export const BOUND_TEXT_LINES = 12;

type Pipeline = (lines: StyledLine[]) => Block[];

const PIPELINES: Record<string, Pipeline> = {
  claude: claudeBuildBlocks,
  cursor: cursorBuildBlocks,
  agy: agyBuildBlocks,
  antigravity: agyBuildBlocks,
  grok: grokBuildBlocks,
  pi: piBuildBlocks,
};

/** An adapter's own deny list, for the permission rows it lifts. Agents without one mark nothing. */
const DENY_LABEL: Record<string, (label: string) => boolean> = {
  cursor: isSkipLabel,
  grok: isRejectLabel,
};

/** The agents this file parses, for the parity test. */
export const DIALOG_KIT_AGENTS: readonly string[] = Object.keys(PIPELINES);

/** The block pipeline the kit runs for `agent` (the adapter's own), or undefined. Exact string. */
export function dialogPipeline(agent: string): Pipeline | undefined {
  return Object.hasOwn(PIPELINES, agent) ? PIPELINES[agent] : undefined;
}

/** The last BOUND_TEXT_LINES non-blank lines of `text`, SGR and trailing spaces removed. */
export function boundTextOf(text: string): string {
  return normalizePromptRegion(text).slice(-BOUND_TEXT_LINES).join("\n");
}

type DialogBlock = Exclude<Block, { kind: "raw" } | { kind: "autocomplete" }>;

function isDialogBlock(block: Block): block is DialogBlock {
  return block.kind !== "raw" && block.kind !== "autocomplete";
}

function fromPrompt(agent: string, model: PromptModel): Lifted {
  if (model.decision) {
    return {
      kind: "question",
      prompt: model.question,
      options: model.options.map((o) => ({ label: o.label, keys: [] })),
      via: "whistlr",
      decision: { thread: model.decision.thread, run: model.decision.run },
    };
  }
  const kind: DialogRequestKind =
    model.family === "permission" ? "permission" : model.family === "trust" ? "trust" : "question";
  // While the free-text row has the keyboard every digit is typed into it, so no option can fire.
  if (model.feedback?.focused) return { kind, prompt: model.question, options: [] };
  const deny = model.family === "permission" && Object.hasOwn(DENY_LABEL, agent) ? DENY_LABEL[agent] : undefined;
  return {
    kind,
    prompt: model.question,
    options: model.options.map((o) => ({
      label: o.label,
      keys: [...o.keys],
      ...(deny?.(o.label) ? { destructive: true } : {}),
      ...(o.description ? { description: o.description } : {}),
    })),
  };
}

function fromMenu(model: MenuModel): Lifted {
  return {
    kind: "menu",
    prompt: model.title,
    options: model.actions.map((a) => ({ label: a.label, keys: [...a.keys], ...(a.cancel ? { destructive: true } : {}) })),
  };
}

type Lifted = Omit<DialogParse, "boundText">;

const REVIEW_PROMPT = "Review your answers";

const stepsOf = (steps: readonly WizardStepChip[] | null | undefined) =>
  steps && steps.length > 0 ? { steps: steps.map((s) => ({ label: s.label, answered: s.answered, current: s.current })) } : {};

const answersOf = (answers: readonly { question: string; answer: string }[]) =>
  answers.length > 0 ? { answers: answers.map((a) => ({ question: a.question, answer: a.answer })) } : {};

/** A wizard step: one option's keys answer and advance; the review submits or cancels. */
function fromWizard(model: WizardModel): Lifted {
  if (model.phase === "review") {
    const options: DialogOption[] = [];
    // `null` = the harness will not submit from this screen yet (Pi with a question unanswered).
    if (model.submitKeys !== null) options.push({ label: "Submit", keys: [...(model.submitKeys ?? WIZARD_SUBMIT_KEYS)] });
    options.push({ label: "Cancel", keys: [...(model.cancelKeys ?? WIZARD_CANCEL_KEYS)], destructive: true });
    return { kind: "question", prompt: REVIEW_PROMPT, options, ...stepsOf(model.steps), ...answersOf(model.answers) };
  }
  // While Pi's editor is open every key is typed into it, so no option can fire.
  const options: DialogOption[] = model.feedback?.editing
    ? []
    : model.options.map((o) => ({
        label: o.label,
        keys: [...o.keys],
        ...(o.escape ? { destructive: true } : {}),
        ...(o.description ? { description: o.description } : {}),
      }));
  return { kind: "question", prompt: model.question, options, ...stepsOf(model.steps) };
}

/**
 * A checkbox step: the boxes first (Claude's digit as keys; Grok and Cursor reach a box by a walk, so
 * none), then "Chat about this", which aborts the ask. The review is Submit (1) and Cancel (2).
 */
function fromMultiSelect(model: MultiSelectModel): Lifted {
  if (model.phase === "review") {
    return {
      kind: "question",
      prompt: REVIEW_PROMPT,
      options: [
        { label: "Submit", keys: ["1"] },
        { label: "Cancel", keys: ["2"], destructive: true },
      ],
      ...answersOf(model.answers),
    };
  }
  const options: DialogOption[] = model.options.map((o) => ({
    label: o.label,
    keys: model.recipe === undefined ? [String(o.n)] : [],
    ...(o.description ? { description: o.description } : {}),
  }));
  if (model.escape) options.push({ label: model.escape.label, keys: [String(model.escape.n)], destructive: true });
  return {
    kind: "question",
    prompt: model.question,
    options,
    multiSelect: { checked: model.options.map((o) => o.checked), advanceLabel: model.advanceLabel },
    ...stepsOf(model.steps),
  };
}

/** A preview select: the digit only moves the pointer, so the bridge's recipe adds the verified Enter. */
function fromPreview(model: PreviewSelectModel): Lifted {
  const pointed = model.options.findIndex((o) => o.pointed);
  return {
    kind: "question",
    prompt: model.question,
    // While the note input has the keyboard every key is typed into it.
    options: model.note.state === "editing" ? [] : model.options.map((o) => ({ label: o.label, keys: [String(o.n)] })),
    ...(pointed >= 0 ? { preview: { optionIndex: pointed, lines: [...model.preview] } } : {}),
    ...stepsOf(model.steps),
  };
}

function fromBlock(agent: string, block: DialogBlock): Lifted {
  switch (block.kind) {
    case "prompt-select":
      return fromPrompt(agent, block.prompt);
    case "menu":
      return fromMenu(block.menu);
    case "wizard":
      return fromWizard(block.wizard);
    case "multi-select":
      return fromMultiSelect(block.multi);
    case "preview-select":
      return fromPreview(block.preview);
  }
}

/** `text` normalized the way `boundText` is (SGR and trailing spaces removed, blank lines dropped). */
export function normalizeBound(text: string): string {
  return normalizePromptRegion(text).join("\n");
}

/** The literal region `model` binds to, normalized like `boundText`. */
export function dialogRegion<K extends DialogKind>(kind: K, model: DialogModels[K]): string {
  return normalizeBound((DIALOG_CONTRACT[kind].region as (m: DialogModels[K]) => string)(model));
}

function boundTextFor(block: DialogBlock, ansiText: string): string {
  const region =
    block.kind === "wizard"
      ? dialogRegion("wizard", block.wizard)
      : block.kind === "multi-select"
        ? dialogRegion("multi-select", block.multi)
        : block.kind === "preview-select"
          ? dialogRegion("preview-select", block.preview)
          : "";
  return region !== "" ? region : boundTextOf(ansiText);
}

/**
 * The tail `kind` dialog of `ansiText` as `agent`'s adapter lifts it, or null. The bridge's recipes
 * re-derive the screen through this between keys, the way v1's race guard does (lib/dialog-guard.ts
 * `dialogDetector`): the adapter's own pipeline, the last block of that kind.
 */
export function dialogModel<K extends DialogKind>(agent: string, ansiText: string, kind: K): DialogModels[K] | null {
  const pipeline = dialogPipeline(agent);
  if (!pipeline || ansiText.length === 0) return null;
  const blocks = pipeline(parseLines(ansiText));
  for (let i = blocks.length - 1; i >= 0; i--) {
    const model = dialogModelOf(blocks[i]!, kind);
    if (model !== null) return model;
  }
  return null;
}

/**
 * The dialog at the tail of `ansiText` (a pane read, ANSI or plain) as `agent`'s adapter would lift
 * it, or a no-echo password prompt (ADR 0017), else null. An agent with no adapter, or an empty read,
 * is null.
 */
export function parseDialog(agent: string, ansiText: string): DialogParse | null {
  const pipeline = dialogPipeline(agent);
  if (!pipeline || ansiText.length === 0) return null;
  const boundText = boundTextOf(ansiText);
  if (boundText === "") return null;
  const lines = parseLines(ansiText);
  const block = pipeline(lines).findLast(isDialogBlock);
  if (block) return { ...fromBlock(agent, block), boundText: boundTextFor(block, ansiText) };
  const password = detectNoEchoPrompt(lines);
  if (password !== null) return { kind: "password", prompt: password, options: [], boundText };
  return null;
}
