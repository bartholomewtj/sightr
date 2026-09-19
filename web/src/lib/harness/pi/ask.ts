// Pi `askuserquestion` detector.
//
// Pi paints an askuserquestion frame inside its editor slot between two accent rules.
// Single-question frames lift as prompt-select; multi-question frames lift as a wizard.
//
// Keystroke recipe: Pi ignores digits entirely (handleInput in ask.ts). Options are selected
// by walking the `>` pointer using Up/Down arrow keys, followed by Enter. Digits are NEVER
// emitted (ADR 0009). The option number is presented via keyLabel.
//
// "Type something." is free-text input and is never typed from the phone: while Pi's pointer sits
// on it, the option buttons lock (modelled via feedback.focused).
//
// See ASK_NOTES.md for verified recipe, source references, and live observations.

import type { StyledLine } from "../../blocks";
import type { PromptFeedback, PromptModel } from "../prompt-model";
import type { WizardModel, WizardOption, WizardStepChip } from "../wizard-model";
import { isBlank, regionSignature } from "../scan";
import {
  DESCRIPTION,
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
} from "./markers";
import { parseDecisionMarkerLine } from "@shared/decision-marker";

export interface PiAskOption {
  label: string;
  description?: string;
  keys: string[];
  keyLabel?: string;
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
}

export function detectPiAsk(lines: StyledLine[]): PiAskParse | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0) return null;

  // 1. Footer anchor: find closing rule c (last RULE with c >= fi - 4)
  let c = -1;
  const minC = Math.max(0, fi - 4);
  for (let i = fi; i >= minC; i--) {
    if (RULE.test(texts[i]!)) {
      c = i;
      break;
    }
  }
  if (c < 0) return null;

  // The non-blank rows after c must number 0, 2 or 3
  const afterRows = texts.slice(c + 1, fi + 1);
  const nonBlankAfter = afterRows.filter((t) => !isBlank(t));
  const count = nonBlankAfter.length;
  if (count !== 0 && count !== 2 && count !== 3) return null;

  if (count > 0) {
    // at most one blank row between c and the first of them
    const firstNonBlankIndex = afterRows.findIndex((t) => !isBlank(t));
    if (firstNonBlankIndex > 1) return null;
    // second non-blank row must match STATS
    if (!STATS.test(nonBlankAfter[1]!)) return null;
  }

  // 2. Help row
  if (c < 2) return null;
  const helpRow = texts[c - 1]!;
  let multi = false;
  if (HELP_SINGLE.test(helpRow)) {
    multi = false;
  } else if (HELP_MULTI.test(helpRow)) {
    multi = true;
  } else {
    return null;
  }

  if (!isBlank(texts[c - 2]!)) return null;

  // 3. Options, walking up from c - 3
  let r = c - 3;
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
  }
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

  // 5. Tab bar & Top rule
  let topRule = -1;
  let steps: WizardStepChip[] = [];

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
    };
    if (raw.description !== undefined) {
      opt.description = raw.description;
    }
    realOptions.push(opt);
  }

  const feedback: PromptFeedback = {
    key: String(n),
    focused: p === n - 1,
    text: "",
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
    ...(decision ? { decision } : {}),
  };
}

export function detectPiPromptRegion(lines: StyledLine[]): PiPromptRegion | null {
  const parsed = detectPiAsk(lines);
  if (!parsed) return null;
  // Lifts a 1Q frame, or a multi frame whose feedback.focused is true
  if (parsed.multi && !parsed.feedback.focused) return null;

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
  if (!parsed) return null;
  // Lifts a multi frame whose feedback is not focused
  if (!parsed.multi || parsed.feedback.focused) return null;

  const options: WizardOption[] = parsed.options.map((opt) => ({
    label: opt.label,
    ...(opt.description !== undefined ? { description: opt.description } : {}),
    keys: opt.keys,
    ...(opt.keyLabel !== undefined ? { keyLabel: opt.keyLabel } : {}),
    chosen: false,
    escape: false,
  }));

  const model: WizardModel = {
    phase: "question",
    steps: parsed.steps,
    question: parsed.question,
    options,
    signature: parsed.signature,
  };

  return {
    model,
    startLine: parsed.topRule,
  };
}

function lastNonBlankIndex(texts: string[]): number {
  let i = texts.length - 1;
  while (i >= 0 && isBlank(texts[i]!)) i--;
  return i;
}
