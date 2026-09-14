// Cursor CLI ask-question card detector (`AskQuestionForm`).
// Source ground truth: `%LOCALAPPDATA%\cursor-agent\versions\2026.09.10-fd3934a\3484.index.js`
// (`./src/components/ask-question-form.tsx` and `./src/utils/interaction-utils.ts`).
//
// Recipe: from pointer row `p` to option row `i`: |i - p| × (Down if i > p else Up), then Enter.
// Single-select: Enter on 1-of-1 selects and submits (on k-of-n it selects and advances).
// Hazard keys: `s` submits the ask; `k`, Esc, and Ctrl+C skip it — never send these.
// Digits do nothing on option rows. Space does not advance.
// Multi-select cards stay raw this pass. See ASK_NOTES.md for full details.

import type { StyledLine } from "../../blocks";
import type { PromptFeedback, PromptModel, PromptOption } from "../prompt-model";
import { isBlank, lastNonBlankIndex, regionSignature, rstrip } from "../scan";
import {
  ASK_BOX_BOTTOM,
  ASK_BOX_ROW,
  ASK_BOX_TOP,
  ASK_COUNTER,
  ASK_FOOTER,
  ASK_LABEL_WRAP,
  ASK_MULTI_SUFFIX,
  ASK_OPTION,
  ASK_OTHER,
  isStatusRow,
  lineText,
  promptBody,
} from "./markers";

export interface ParsedAskOption {
  pointer: boolean;
  checked: boolean;
  label: string;
}

export interface AskCard {
  top: number;
  bottom: number;
  firstOption: number;
  k: number;
  n: number;
  multi: boolean;
  question: string;
  rows: ParsedAskOption[];
  pointer: number;
  otherText: string;
}

export interface AskRegion {
  model: PromptModel;
  startLine: number;
}

interface RawBox {
  top: number;
  bottom: number;
  inner: { text: string; lineIndex: number }[];
}

function extractAskBox(texts: string[]): RawBox | null {
  const end = lastNonBlankIndex(texts);
  if (end < 0) return null;

  // Walk up over optional tail chrome: status rows, blanks, prompt row, blanks
  let i = end;
  let statusCount = 0;
  while (i >= 0 && statusCount < 4 && isStatusRow(texts[i]!)) {
    statusCount++;
    i--;
  }
  while (i >= 0 && isBlank(texts[i]!)) {
    i--;
  }
  if (i >= 0 && promptBody(texts[i]!) !== null) {
    i--;
    let blanks = 0;
    while (i >= 0 && isBlank(texts[i]!)) {
      blanks++;
      if (blanks > 4) return null;
      i--;
    }
  }

  if (i < 0 || !ASK_BOX_BOTTOM.test(texts[i]!)) return null;
  const bottom = i;

  const inner: { text: string; lineIndex: number }[] = [];
  let top = -1;
  for (let j = bottom - 1; j >= Math.max(0, bottom - 80); j--) {
    if (ASK_BOX_TOP.test(texts[j]!)) {
      top = j;
      break;
    }
    const m = ASK_BOX_ROW.exec(texts[j]!);
    if (m === null) return null;
    const raw = m[1]!;
    const innerText = rstrip(raw.startsWith(" ") ? raw.slice(1) : raw);
    inner.unshift({ text: innerText, lineIndex: j });
  }
  if (top < 0) return null;

  return { top, bottom, inner };
}

export function parseAskCard(lines: StyledLine[]): AskCard | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const box = extractAskBox(texts);
  if (box === null) return null;

  const rawInner = box.inner;
  let idx = 0;

  // 1. Title: the first non-blank row (any non-empty text; do not require "Cursor ask")
  while (idx < rawInner.length && rawInner[idx]!.text.length === 0) {
    idx++;
  }
  if (idx >= rawInner.length) return null;
  idx++; // title row consumed

  // Separator blanks (1–2)
  let blanks = 0;
  while (idx < rawInner.length && rawInner[idx]!.text.length === 0) {
    blanks++;
    idx++;
  }
  if (blanks < 1 || blanks > 2 || idx >= rawInner.length) return null;

  // 2. Counter: Question k of n (1 <= k <= n)
  const counterMatch = ASK_COUNTER.exec(rawInner[idx]!.text);
  if (!counterMatch) return null;
  const k = parseInt(counterMatch[1]!, 10);
  const n = parseInt(counterMatch[2]!, 10);
  if (!(1 <= k && k <= n)) return null;
  idx++;

  // Separator blanks (1–2)
  blanks = 0;
  while (idx < rawInner.length && rawInner[idx]!.text.length === 0) {
    blanks++;
    idx++;
  }
  if (blanks < 1 || blanks > 2 || idx >= rawInner.length) return null;

  // 3. Question: joined non-blank rows up to the next blank, starts with `${k}. `
  const questionParts: string[] = [];
  while (idx < rawInner.length && rawInner[idx]!.text.length > 0) {
    questionParts.push(rawInner[idx]!.text.trim());
    idx++;
  }
  if (questionParts.length === 0) return null;
  let joinedQuestion = questionParts.join(" ");
  const prefix = `${k}. `;
  if (!joinedQuestion.startsWith(prefix)) return null;
  joinedQuestion = joinedQuestion.slice(prefix.length).trim();
  const multi = ASK_MULTI_SUFFIX.test(joinedQuestion);
  if (multi) {
    joinedQuestion = joinedQuestion.replace(ASK_MULTI_SUFFIX, "").trim();
  }
  if (joinedQuestion.length === 0) return null;

  // Separator blanks (1–2)
  blanks = 0;
  while (idx < rawInner.length && rawInner[idx]!.text.length === 0) {
    blanks++;
    idx++;
  }
  if (blanks < 1 || blanks > 2 || idx >= rawInner.length) return null;

  // 4. Options: rows up to next blank
  let firstOption = -1;
  const rows: ParsedAskOption[] = [];
  while (idx < rawInner.length && rawInner[idx]!.text.length > 0) {
    const rowObj = rawInner[idx]!;
    const optMatch = ASK_OPTION.exec(rowObj.text);
    if (optMatch) {
      if (firstOption < 0) {
        firstOption = rowObj.lineIndex;
      }
      const pointer = optMatch[1] === "› ";
      const checked = optMatch[2] === "x";
      const label = optMatch[3]!.trim();
      rows.push({ pointer, checked, label });
    } else if (ASK_LABEL_WRAP.test(rowObj.text)) {
      if (rows.length === 0) return null;
      const last = rows[rows.length - 1]!;
      last.label = `${last.label} ${rowObj.text.trim()}`;
    } else {
      return null;
    }
    idx++;
  }
  if (rows.length === 0 || firstOption < 0) return null;

  // Separator blanks (1–2)
  blanks = 0;
  while (idx < rawInner.length && rawInner[idx]!.text.length === 0) {
    blanks++;
    idx++;
  }
  if (blanks < 1 || blanks > 2 || idx >= rawInner.length) return null;

  // 5. Footer: exactly ASK_FOOTER, with only blanks after it
  if (!ASK_FOOTER.test(rawInner[idx]!.text)) return null;
  idx++;
  while (idx < rawInner.length) {
    if (rawInner[idx]!.text.length > 0) return null;
    idx++;
  }

  // 6. Validate options: >= 3 rows, exactly one pointer, last row is Other:
  if (rows.length < 3) return null;
  let pointerIndex = -1;
  for (let r = 0; r < rows.length; r++) {
    if (rows[r]!.pointer) {
      if (pointerIndex >= 0) return null;
      pointerIndex = r;
    }
  }
  if (pointerIndex < 0) return null;

  const otherRow = rows[rows.length - 1]!;
  const otherMatch = ASK_OTHER.exec(otherRow.label);
  if (!otherMatch) return null;
  for (let r = 0; r < rows.length - 1; r++) {
    if (ASK_OTHER.test(rows[r]!.label)) return null;
  }
  const otherRaw = otherMatch[1]!.trim();
  const otherText = otherRaw === "(type to answer)" ? "" : otherRaw;

  if (!multi) {
    const checkedCount = rows.filter((r) => r.checked).length;
    if (checkedCount > 1) return null;
  }

  return {
    top: box.top,
    bottom: box.bottom,
    firstOption,
    k,
    n,
    multi,
    question: joinedQuestion,
    rows,
    pointer: pointerIndex,
    otherText,
  };
}

export function askCardPresent(lines: StyledLine[]): boolean {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const box = extractAskBox(texts);
  if (box === null) return false;

  for (let k = box.inner.length - 1; k >= 0; k--) {
    if (box.inner[k]!.text.length > 0) {
      return ASK_FOOTER.test(box.inner[k]!.text);
    }
  }
  return false;
}

export function detectAskRegion(lines: StyledLine[]): AskRegion | null {
  const card = parseAskCard(lines);
  if (!card) return null;

  // Multi-select cards stay raw this pass: Enter adds the pointed row before
  // submitting, so a Submit button needs its own pointer walk; actions.ts has no
  // such recipe, and nothing is probed.
  if (card.multi) return null;

  const realOptionRows = card.rows.slice(0, card.rows.length - 1);
  const p = card.pointer;

  const options: PromptOption[] = [];
  for (let i = 0; i < realOptionRows.length; i++) {
    const diff = Math.abs(i - p);
    const dir = i > p ? "Down" : "Up";
    const keys: string[] = [];
    for (let s = 0; s < diff; s++) {
      keys.push(dir);
    }
    keys.push("Enter");

    options.push({
      label: realOptionRows[i]!.label,
      keys,
      keyLabel: String(i + 1),
    });
  }

  const feedback: PromptFeedback = {
    key: String(card.rows.length),
    focused: p === card.rows.length - 1,
    text: card.otherText,
    purpose: "free-text",
  };

  const texts = lines.map((l) => rstrip(lineText(l)));
  const signature = regionSignature(texts, card.top, card.bottom + 1);
  if (signature === "") return null;

  const labels = options.map((o) => o.label);
  const coreSignature = [card.question, ...labels].join("\n");

  const model: PromptModel = {
    question: card.question,
    options,
    family: "select",
    feedback,
    coreSignature,
    signature,
  };

  return {
    model,
    startLine: card.firstOption,
  };
}
