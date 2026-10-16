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
// Nothing here invents keys. Options carry the keys the adapter's model already encodes; a dialog the
// kit cannot answer with one tap (multi-select, wizard, preview, a focused free-text row) is published
// with no options and the operator answers it in the Terminal tab.

import { normalizePromptRegion } from "../../../../shared/prompt-binding";
import { parseLines, type Block, type StyledLine } from "../blocks";
import { detectNoEchoPrompt } from "../no-echo";
import { agyBuildBlocks } from "./agy/index";
import { claudeBuildBlocks } from "./claude/index";
import { cursorBuildBlocks } from "./cursor/index";
import { isSkipLabel } from "./cursor/permission";
import { grokBuildBlocks } from "./grok/index";
import { isRejectLabel } from "./grok/permission";
import type { MenuModel } from "./menu-model";
import { piBuildBlocks } from "./pi/index";
import type { PromptModel } from "./prompt-model";

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
  /** The last BOUND_TEXT_LINES non-blank lines of the read, normalized. The bridge keeps it. */
  boundText: string;
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

function fromPrompt(agent: string, model: PromptModel): Omit<DialogParse, "boundText"> {
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

function fromMenu(model: MenuModel): Omit<DialogParse, "boundText"> {
  return {
    kind: "menu",
    prompt: model.title,
    options: model.actions.map((a) => ({ label: a.label, keys: [...a.keys], ...(a.cancel ? { destructive: true } : {}) })),
  };
}

function fromBlock(agent: string, block: DialogBlock): Omit<DialogParse, "boundText"> {
  switch (block.kind) {
    case "prompt-select":
      return fromPrompt(agent, block.prompt);
    case "menu":
      return fromMenu(block.menu);
    // Multi-step and checkbox dialogs need more than one tap: published without options (T17).
    case "wizard":
      return { kind: "question", prompt: block.wizard.phase === "question" ? block.wizard.question : "Review your answers", options: [] };
    case "multi-select":
      return { kind: "question", prompt: block.multi.phase === "checkbox" ? block.multi.question : "Review your answers", options: [] };
    case "preview-select":
      return { kind: "question", prompt: block.preview.question, options: [] };
  }
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
  if (block) return { ...fromBlock(agent, block), boundText };
  const password = detectNoEchoPrompt(lines);
  if (password !== null) return { kind: "password", prompt: password, options: [], boundText };
  return null;
}
