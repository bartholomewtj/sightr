// Pi `askuserquestion` detector.
//
// Pi paints an askuserquestion frame inside its editor slot between two accent rules.
// Single-question frames lift as prompt-select; multi-question frames lift as a wizard.
//
// Keystroke recipe: Pi ignores digits entirely (handleInput in ask.ts). Options are selected
// by walking the `>` pointer using Up/Down arrow keys, followed by Enter. Digits are NEVER
// emitted (ADR 0009). The option number is presented via keyLabel.
//
// "Type something." is free-text. On a multi-question card it stays on the wizard as `feedback`:
// the phone walks the pointer with arrows, Enter opens the editor, then types and Enter submits.
// Digits are never sent. While the pointer sits on that row, or the editor is open, option buttons
// lock. A one-question card still models the row as prompt-select feedback and does not type it.
//
// See ASK_NOTES.md for verified recipe, source references, and live observations.

import type { StyledLine } from "../../blocks";
import type { PromptFeedback, PromptModel } from "../prompt-model";
import type { WizardModel, WizardOption, WizardStepChip } from "../wizard-model";
import { isBlank, regionSignature } from "../scan";
import {
  DESCRIPTION,
  HELP_INPUT,
  HELP_MULTI,
  HELP_SINGLE,
  LABEL_WRAP,
  lineText,
  OPTION,
  OTHER_LABEL,
  rstrip,
  RULE,
  STATS,
  TAB_BAR,
  YOUR_ANSWER,
} from "./markers";
import { parseDecisionMarkerLine } from "@shared/decision-marker";

export interface PiAskOption {
  label: string;
  description?: string;
  keys: string[];
  keyLabel?: string;
  /** Set when Pi painted a trailing ` ✓` on this row (multiSelect, toggled on). */
  chosen?: boolean;
}

export interface PiAskParse {
  multi: boolean;
  topRule: number;
  firstOptionLine: number;
  question: string;
  options: PiAskOption[];
  feedback: PromptFeedback;
  steps: WizardStepChip[];
  signature: string;
  coreSignature: string;
  /** Keys that open the editor: arrows onto `Type something.`, then Enter. Never a digit. */
  openKeys: string[];
  /** Enter on `Type something.` has opened Pi's editor. */
  editing: boolean;
  /** Editor contents (cursor and padding removed). Empty outside input mode. */
  editorText: string;
  /** The free-text row carries Pi's trailing `✓` (a saved custom answer). */
  otherChosen: boolean;
  decision?: { thread: string; run: string };
}

export interface PiPromptRegion {
  model: PromptModel;
  startLine: number;
}

export interface PiWizardRegion {
  model: WizardModel;
  startLine: number;
}

interface RawOption {
  hasPointer: boolean;
  num: number;
  label: string;
  description?: string;
  lineIndex: number;
  /** Trailing ` ✓` on a multiSelect row Pi has toggled on. */
  chosen: boolean;
  /** Trailing ` ✎` — this is the free-text row and the editor is open. */
  pencil: boolean;
}

/**
 * The frame's closing rule: the last RULE within four rows of the tail, followed by 0, 2 or 3
 * footer rows (PWD, stats, optional extension status), or -1.
 */
function closingRule(texts: string[]): number {
  const fi = lastNonBlankIndex(texts);
  if (fi < 0) return -1;

  let c = -1;
  const minC = Math.max(0, fi - 4);
  for (let i = fi; i >= minC; i--) {
    if (RULE.test(texts[i]!)) {
      c = i;
      break;
    }
  }
  if (c < 0) return -1;

  // The non-blank rows after c must number 0, 2 or 3
  const afterRows = texts.slice(c + 1, fi + 1);
  const nonBlankAfter = afterRows.filter((t) => !isBlank(t));
  const count = nonBlankAfter.length;
  if (count !== 0 && count !== 2 && count !== 3) return -1;

  if (count > 0) {
    // at most one blank row between c and the first of them
    const firstNonBlankIndex = afterRows.findIndex((t) => !isBlank(t));
    if (firstNonBlankIndex > 1) return -1;
    // second non-blank row must match STATS
    if (!STATS.test(nonBlankAfter[1]!)) return -1;
  }
  return c;
}

/** Help row just above the closing rule. A narrow pane wraps "… Esc" / "cancel" onto the next row. */
function helpAbove(
  texts: string[],
  c: number,
): { start: number; multi: boolean; input: boolean } | null {
  if (c < 2) return null;
  let start = c - 1;
  const kindOf = (row: string): "single" | "multi" | "input" | null => {
    if (HELP_SINGLE.test(row)) return "single";
    if (HELP_MULTI.test(row)) return "multi";
    if (HELP_INPUT.test(row)) return "input";
    return null;
  };
  let kind = kindOf(texts[start]!);
  if (kind === null && start >= 1) {
    const cont = texts[start]!.trim();
    const head = texts[start - 1]!;
    if (cont.length > 0 && cont.length <= 16 && /navigate/.test(head)) {
      const joined = kindOf(`${head.trimEnd()} ${cont}`);
      if (joined !== null) {
        kind = joined;
        start -= 1;
      }
    }
  }
  if (kind === null) return null;
  if (start < 1 || !isBlank(texts[start - 1]!)) return null;
  return { start, multi: kind === "multi", input: kind === "input" };
}

/**
 * The editor Pi paints under the options once Enter has opened `Type something.`.
 * Returns the blank row directly under the options (where the normal walker starts) and the text.
 * Border rows are `─`; a non-final visual line is `width - 1` columns (the cursor column is reserved),
 * so a space at a wrap survives. The last line's trailing spaces are the cursor plus padding.
 */
function takeEditor(
  texts: string[],
  helpStart: number,
): { optionsEndBlank: number; text: string } | null {
  let i = helpStart - 1;
  if (i < 1 || !isBlank(texts[i]!)) return null;
  i--;
  const rows: string[] = [];
  while (i >= 0 && !YOUR_ANSWER.test(texts[i]!)) {
    rows.push(texts[i]!);
    i--;
    if (rows.length > 30) return null;
  }
  if (i < 1 || !isBlank(texts[i - 1]!)) return null;
  rows.reverse();
  return { optionsEndBlank: i - 1, text: readEditorText(rows) };
}

function readEditorText(rows: string[]): string {
  const border = rows.map((r) => r.trim()).find((t) => /^─{4,}$/.test(t));
  const width = border?.length ?? 0;
  const content = rows.filter((r) => {
    const t = r.trim();
    return t.length > 0 && !/^─+$/.test(t);
  });
  if (content.length === 0) return "";
  if (width === 0) return content.map((r) => r.trim()).join("");
  const layout = Math.max(1, width - 1);
  return content
    .map((r, idx) => {
      const body = r.startsWith(" ") ? r.slice(1) : r;
      if (idx < content.length - 1) return body.slice(0, layout);
      return body.trimEnd();
    })
    .join("");
}

export function detectPiAsk(lines: StyledLine[]): PiAskParse | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. Footer anchor: the closing rule c
  const c = closingRule(texts);
  if (c < 0) return null;

  // 2. Help row. Options sit above the blank that sits above the help.
  const help = helpAbove(texts, c);
  if (!help) return null;
  let multi = help.multi;
  const editing = help.input;
  const helpStart = help.start;

  // 3. Options. In input mode the editor sits between the options and the help row.
  let editorText = "";
  let r = helpStart - 2;
  if (editing) {
    const taken = takeEditor(texts, helpStart);
    if (!taken) return null;
    editorText = taken.text;
    r = taken.optionsEndBlank - 1;
  }
  let pendingDesc: string[] = [];
  let pendingLabelWrap: string[] = [];
  const collectedOptions: RawOption[] = [];

  while (r >= 0 && !isBlank(texts[r]!)) {
    const text = texts[r]!;
    const match = OPTION.exec(text);
    if (match) {
      const hasPointer = match[1] === "> ";
      const num = Number(match[2]);
      let label = match[3]!.trim();
      if (pendingLabelWrap.length > 0) {
        label = [label, ...pendingLabelWrap.reverse()].join(" ");
        pendingLabelWrap = [];
      }
      // Pi paints a trailing check on a toggled multiSelect row, and ` ✎` while the editor
      // is open. Strip both before the "Type something." check, or the phone drops the buttons.
      const pencil = label.endsWith(" ✎");
      if (pencil) label = label.slice(0, -2);
      const chosen = label.endsWith(" ✓");
      if (chosen) label = label.slice(0, -2);
      let description: string | undefined = undefined;
      if (pendingDesc.length > 0) {
        description = pendingDesc.reverse().join(" ");
        pendingDesc = [];
      }
      collectedOptions.push({
        hasPointer,
        num,
        label,
        description,
        lineIndex: r,
        chosen,
        pencil,
      });
      r--;
      continue;
    }
    if (DESCRIPTION.test(text)) {
      pendingDesc.push(text.trim());
      r--;
      continue;
    }
    if (LABEL_WRAP.test(text)) {
      pendingLabelWrap.push(text.trim());
      r--;
      continue;
    }
    return null;
  }

  if (pendingDesc.length > 0 || pendingLabelWrap.length > 0) return null;
  if (r < 0 || !isBlank(texts[r]!)) return null;
  const blankAboveOptions = r;

  const parsedOptions = collectedOptions.reverse();
  const n = parsedOptions.length;
  if (n < 3) return null;

  let pointerCount = 0;
  let pointerIndex = -1;
  for (let i = 0; i < n; i++) {
    const opt = parsedOptions[i]!;
    if (opt.num !== i + 1) return null;
    if (opt.hasPointer) {
      pointerCount++;
      pointerIndex = i;
    }
  }
  if (pointerCount !== 1 || pointerIndex < 0) return null;

  if (parsedOptions[n - 1]!.label !== OTHER_LABEL) return null;
  for (let i = 0; i < n - 1; i++) {
    if (parsedOptions[i]!.label === OTHER_LABEL) return null;
    if (parsedOptions[i]!.pencil) return null;
  }
  if (parsedOptions[n - 1]!.pencil !== editing) return null;
  const firstOptionLine = parsedOptions[0]!.lineIndex;

  // 4. Question: non-blank rows above blankAboveOptions, each starting with one space
  let qRow = blankAboveOptions - 1;
  const questionLines: string[] = [];
  let decision: { thread: string; run: string } | undefined;
  while (qRow >= 0 && !isBlank(texts[qRow]!) && !RULE.test(texts[qRow]!)) {
    const t = texts[qRow]!;
    const m = parseDecisionMarkerLine(t);
    if (m.kind === "found") {
      decision = { thread: m.thread, run: m.run };
      questionLines.push(t.trim());
      qRow--;
      continue;
    }
    if (!t.startsWith(" ")) return null;
    questionLines.push(t.trim());
    qRow--;
  }
  if (questionLines.length === 0) return null;
  const question = questionLines.reverse().join(" ").trim();
  if (question === "") return null;

  // 5. Tab bar & Top rule. Input mode uses one help row for both shapes, so the tab bar
  // decides. A one-question editor stays raw — the phone does not type that card.
  let topRule = -1;
  let steps: WizardStepChip[] = [];

  if (editing) {
    if (qRow >= 0 && isBlank(texts[qRow]!)) multi = true;
    else if (qRow >= 0 && RULE.test(texts[qRow]!)) multi = false;
    else return null;
    if (!multi) return null;
  }

  if (!multi) {
    if (qRow < 0 || !RULE.test(texts[qRow]!)) return null;
    topRule = qRow;
  }
 else {
    if (qRow < 0 || !isBlank(texts[qRow]!)) return null;
    let tbRow = qRow - 1;
    const tabBarLineIndices: number[] = [];
    while (tbRow >= 0 && !RULE.test(texts[tbRow]!)) {
      if (isBlank(texts[tbRow]!)) return null;
      tabBarLineIndices.push(tbRow);
      tbRow--;
    }
    if (tbRow < 0 || !RULE.test(texts[tbRow]!)) return null;
    topRule = tbRow;
    if (tabBarLineIndices.length === 0) return null;
    tabBarLineIndices.reverse();

    const joinedTabBar = tabBarLineIndices.map((idx) => texts[idx]!).join("");
    const tabMatch = TAB_BAR.exec(joinedTabBar);
    if (!tabMatch) return null;

    const middle = tabMatch[1]!;
    const chipRegex = /([□■]) (.+?)(?=\s{3}[□■] |\s*$)/g;
    let cm;
    interface RawChip {
      label: string;
      answered: boolean;
    }
    const rawChips: RawChip[] = [];
    while ((cm = chipRegex.exec(middle)) !== null) {
      rawChips.push({
        label: cm[2]!.trim(),
        answered: cm[1] === "■",
      });
    }
    if (rawChips.length < 2) return null;

    // Current chip detection
    const allTabBarSegments = tabBarLineIndices.flatMap((idx) => lines[idx]!.segments);
    let baseBg: string | undefined = undefined;
    for (const seg of allTabBarSegments) {
      if (seg.text.includes("←")) {
        baseBg = seg.bg;
        break;
      }
    }

    const diffBgSegments = allTabBarSegments.filter((seg) => seg.bg !== baseBg);

    // If Submit chip qualifies, return null
    if (diffBgSegments.some((seg) => seg.text.includes("Submit"))) {
      return null;
    }

    const qualifyingIndices: number[] = [];
    for (let i = 0; i < rawChips.length; i++) {
      const chip = rawChips[i]!;
      if (diffBgSegments.some((seg) => seg.text.includes(chip.label))) {
        qualifyingIndices.push(i);
      }
    }

    steps = rawChips.map((chip, idx) => ({
      label: chip.label,
      answered: chip.answered,
      current: qualifyingIndices.length === 1 && qualifyingIndices[0] === idx,
    }));
  }

  // 6. Keys
  const p = pointerIndex;
  const realOptions: PiAskOption[] = [];
  for (let i = 0; i < n - 1; i++) {
    const raw = parsedOptions[i]!;
    const diff = i - p;
    let keys: string[];
    if (diff > 0) {
      keys = [...Array(diff).fill("Down"), "Enter"];
    } else if (diff < 0) {
      keys = [...Array(-diff).fill("Up"), "Enter"];
    } else {
      keys = ["Enter"];
    }
    const opt: PiAskOption = {
      label: raw.label,
      keys,
      keyLabel: String(i + 1),
      ...(raw.chosen ? { chosen: true } : {}),
    };
    if (raw.description !== undefined) {
      opt.description = raw.description;
    }
    realOptions.push(opt);
  }

  const otherDiff = n - 1 - p;
  const openKeys =
    otherDiff > 0
      ? [...Array<string>(otherDiff).fill("Down"), "Enter"]
      : otherDiff < 0
        ? [...Array<string>(-otherDiff).fill("Up"), "Enter"]
        : ["Enter"];

  const feedback: PromptFeedback = {
    key: String(n),
    focused: p === n - 1,
    text: editorText,
    purpose: "free-text",
  };

  // 7. Signature
  const signature = regionSignature(texts, topRule, c + 1);
  const coreSignature = [question, ...realOptions.map((o) => o.label)].join("\n");

  // 8. Return
  return {
    multi,
    topRule,
    firstOptionLine,
    question,
    options: realOptions,
    feedback,
    steps,
    signature,
    coreSignature,
    openKeys,
    editing,
    editorText,
    otherChosen: parsedOptions[n - 1]!.chosen,
    ...(decision ? { decision } : {}),
  };
}

export function detectPiPromptRegion(lines: StyledLine[]): PiPromptRegion | null {
  const parsed = detectPiAsk(lines);
  if (!parsed) return null;
  // Multi frames, including the pointer on `Type something.` and the open editor, are wizards.
  if (parsed.multi || parsed.editing) return null;

  const model: PromptModel = {
    question: parsed.question,
    options: parsed.options,
    family: "select",
    feedback: parsed.feedback,
    coreSignature: parsed.coreSignature,
    signature: parsed.signature,
    ...(parsed.decision ? { decision: parsed.decision } : {}),
  };

  return {
    model,
    startLine: parsed.firstOptionLine,
  };
}

export function detectPiWizardRegion(lines: StyledLine[]): PiWizardRegion | null {
  const parsed = detectPiAsk(lines);
  if (!parsed || !parsed.multi) return null;

  const options: WizardOption[] = parsed.options.map((opt) => ({
    label: opt.label,
    ...(opt.description !== undefined ? { description: opt.description } : {}),
    keys: opt.keys,
    ...(opt.keyLabel !== undefined ? { keyLabel: opt.keyLabel } : {}),
    chosen: opt.chosen === true,
    escape: false,
  }));

  const model: WizardModel = {
    phase: "question",
    steps: parsed.steps,
    question: parsed.question,
    options,
    signature: parsed.signature,
    feedback: {
      keys: parsed.openKeys,
      keyLabel: parsed.feedback.key,
      focused: parsed.feedback.focused,
      editing: parsed.editing,
      text: parsed.editorText,
      customChosen: parsed.otherChosen,
    },
  };

  return {
    model,
    startLine: parsed.topRule,
  };
}

const REVIEW_TITLE = /^\s*Ready to submit$/;
const REVIEW_READY = /^\s*Press Enter to submit$/;
const REVIEW_MISSING = /^\s*Unanswered: (.+)$/;
const MAX_REVIEW_ROWS = 40;

/**
 * The multi-question frame's Submit tab (`Ready to submit`), as a wizard `review`. Pi's submit keys
 * differ from Claude's: Enter submits — and only once every question is answered — and Esc cancels
 * the whole ask (`~/.pi/agent/extensions/ask.ts` handleInput, Submit tab branch). Pi echoes each
 * answer as `<chip label>: <answer>`, so the question side of the review is the chip label.
 * Live 2026-09-27 (pane wGK:p2): before this the tab stayed raw and a phone had no way to submit.
 */
export function detectPiReviewRegion(lines: StyledLine[]): PiWizardRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const c = closingRule(texts);
  if (c < 4) return null;
  const help = helpAbove(texts, c);
  if (!help || !help.multi) return null;

  const statusIdx = help.start - 2;
  if (statusIdx < 1) return null;
  const status = texts[statusIdx]!;
  const ready = REVIEW_READY.test(status);
  if (!ready && !REVIEW_MISSING.test(status)) return null;
  if (!isBlank(texts[statusIdx - 1]!)) return null;

  // Walk up over the echoed answers to the title.
  let title = -1;
  for (let i = statusIdx - 2; i >= Math.max(0, c - MAX_REVIEW_ROWS); i--) {
    if (REVIEW_TITLE.test(texts[i]!)) {
      title = i;
      break;
    }
  }
  if (title < 2 || !isBlank(texts[title - 1]!)) return null;

  // Tab bar (it may wrap) between the top rule and the blank above the title.
  let topRule = -1;
  for (let i = title - 2; i >= Math.max(0, title - 6); i--) {
    if (RULE.test(texts[i]!)) {
      topRule = i;
      break;
    }
  }
  if (topRule < 0) return null;
  const tabBar = TAB_BAR.exec(texts.slice(topRule + 1, title - 1).join(""));
  if (!tabBar) return null;
  const steps: WizardStepChip[] = [];
  const chipRegex = /([□■]) (.+?)(?=\s{3}[□■] |\s*$)/g;
  let cm;
  while ((cm = chipRegex.exec(tabBar[1]!)) !== null) {
    steps.push({ label: cm[2]!.trim(), answered: cm[1] === "■", current: false });
  }
  if (steps.length < 2) return null;

  // `<label>: <answer>` rows; a row that starts no known label continues the answer above it.
  const answers: { question: string; answer: string }[] = [];
  for (let i = title + 2; i < statusIdx - 1; i++) {
    const t = texts[i]!;
    if (isBlank(t)) continue;
    const step = steps.find((st) => t.trimStart().startsWith(`${st.label}: `));
    if (step) {
      answers.push({ question: step.label, answer: t.trimStart().slice(step.label.length + 2).trim() });
    } else if (answers.length > 0) {
      const last = answers[answers.length - 1]!;
      last.answer = `${last.answer} ${t.trim()}`;
    } else {
      return null;
    }
  }

  const signature = regionSignature(texts, topRule, c + 1);
  if (signature === "") return null;
  return {
    startLine: topRule,
    model: {
      phase: "review",
      steps,
      answers,
      incomplete: !ready,
      signature,
      submitKeys: ready ? ["Enter"] : null,
      cancelKeys: ["Escape"],
    },
  };
}

function lastNonBlankIndex(texts: string[]): number {
  let i = texts.length - 1;
  while (i >= 0 && isBlank(texts[i]!)) i--;
  return i;
}
