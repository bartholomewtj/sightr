import { regionSignature, rstrip, lastNonBlankIndex } from "../scan";
// Grok `ask_user_question` card — the captured 2026-08-31 w50:p1 card uses a light `│` gutter
// and `Shift+x:dismiss`; older captures use the heavy `┃` gutter. Both replace the composer.
// Digit N on a radio card was live-probed (ASK_NOTES.md): `2` submitted immediately. Checkbox
// (`[ ]`) cards are a different widget — a digit submits rather than toggles. They lift as
// `multi-select` with recipe `tab-space-enter` (phone Keys tray, 2026-09-03): Tab walks, Space
// toggles, Enter submits. Never emit a digit. The complete radio layout is consecutive 1..n
// radios, a `z` row, and an inner `Enter:select|submit|edit` hint. A card missing any of those,
// or painting an `a`–`f` option row, is a different widget — refuse rather than emit digits.
// Esc-park keeps the same card; its footer differs and must still match. Radio prepends Tab so a
// tap re-enters before the digit. Checkbox sets `parked` so the Tab/Space walk Tabs once to re-enter
// before Space; Enter is `Tab, Enter`. Radio `z` is modelled as `purpose: "free-text"` so a focused
// row can lock the option buttons; Sighter does not type into it. Pure; no pane access.
//
// When a radio card's hint row contains `[n/m]` with m ≥ 2, it lifts as a `wizard` (question phase)
// rather than `prompt-select`. Stepper chips show 1/m..m/m; Right/Left navigate between questions
// (ASK_NOTES.md); a digit answers the current step. Parked cards and z-focused/edit-hint cards fall
// back to `prompt-select`. `answered` and `chosen` are never inferred from Grok's paint.
//
// When a checkbox card's hint row contains `[n/m]` with m ≥ 2, it lifts as `multi-select` with
// stepper chips 1/m..m/m (parked → no chips), still recipe `tab-space-enter`, digits never emitted.

import type { StyledLine } from "../../blocks";
import type { PromptFeedback, PromptModel, PromptOption } from "../prompt-model";
import type { MultiSelectModel, MultiSelectOption } from "../multi-select-model";
import type { WizardModel, WizardOption, WizardStepChip } from "../wizard-model";
import {
  GUTTER_OPTION_ANY,
  gutterCardRange,
  lineText,
  } from "./markers";

export interface AskRegion {
  model: PromptModel;
  startLine: number;
}

export interface AskWizardRegion {
  model: WizardModel;
  startLine: number;
}

const CHECKBOX = /^\s*[┃│]\s+[1-9]\s+\[[ x✔✓]\]/i;
const CHECKBOX_ROW = /^\s*[┃│]\s+([1-9])\s+\[([ x✔✓])\]\s*(.*?)\s*$/i;
const Z_CHECKBOX = /^\s*[┃│]\s+z\s+\[[ x✔✓]\]\s+Type your answer here\s*$/i;
// Official keys include `a`–`f` as answers. Those digits/letters are unprobed, so a card that
// paints one is a different widget — refuse rather than emit 1..n and ignore the extras.
const LETTER_OPTION = /^\s*[┃│]\s+[a-zA-Z]\s+\(([●○])\)/;
// Idle z is `(○)`. The English placeholder is the usual rest; after typing then Esc-park the
// row can keep `> hi` instead of the placeholder (live R10). Still idle — a digit answers.
const Z_IDLE = /^\s*[┃│]\s+z\s+\(○\)(.*)$/;
// Focused z: older captures use `(●) ❯`; live Grok 1.x paints `(•) >` (U+2022 + ASCII >).
const Z_FOCUSED = /^\s*[┃│]\s+z\s+\([●•]\)\s+[❯>]\s*(.*)$/;
// The card's inner hint row, anchored to its captured shape: an optional wizard step (`[1/2]`),
// the `↑/↓ navigate` legend, then the Enter verb ending the row. An unanchored substring let
// question prose containing "Enter:submit" satisfy the layout gate (review repro) — the hint
// must be the hint ROW, not words inside one. The `edit` verb is the ONE grid-visible tell that
// the keyboard sits on the `z` row: after Esc leaves a focused `z`, the row repaints as idle
// `z (○)` and the global footer says `Tab:next answer` — but a digit still types into the
// free-text field (live-probed 2026-08-22, twice via the guarded send path;
// grok--ask-z-parked.txt). `select`/`submit` mean the cursor is on an option row.
const HINT_ROW = /^\s*[┃│]\s+(?:\[\d+\/\d+\]\s+)?↑\/↓ navigate\b.*Enter:(select|submit|edit)$/i;
const HINT_STEP = /^\s*[┃│]\s+\[(\d+)\/(\d+)\]\s+↑\/↓ navigate\b/;
// A row shaped like a control — a short key token followed by a mark — that no specific rule
// matched is an unprobed widget row: refuse the whole card rather than lift around it.
const FOREIGN_OPTION = /^\s*[┃│]\s+\S{1,3}\s+[([]/;
const FOOTER_ACTIVE = /Tab:next answer/i;
const FOOTER_PARKED = /Tab\/Space:question/i;
const FOOTER_Z = /Esc:back/i;

function isAskFooter(text: string, hasZFocus: boolean): boolean {
  if (FOOTER_ACTIVE.test(text) || FOOTER_PARKED.test(text)) return true;
  return hasZFocus && FOOTER_Z.test(text);
}

interface RadioAskParse {
  region: AskRegion;
  questionLine: number;
  step: { n: number; m: number } | null;
  parked: boolean;
}

function parseRadioAsk(lines: StyledLine[]): RadioAskParse | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0) return null;

  const card = gutterCardRange(texts, fi, "any");
  if (card === null) return null;
  const start = card.start;

  let firstOption = -1;
  for (let i = card.start; i <= card.end; i++) {
    if (GUTTER_OPTION_ANY.test(texts[i]!)) {
      firstOption = i;
      break;
    }
  }
  if (firstOption < 0) return null;

  const options: PromptOption[] = [];
  let question = "";
  let questionLine = -1;
  let step: { n: number; m: number } | null = null;
  let feedback: PromptFeedback | undefined;
  let sawHint = false;
  let editHint = false;
  const seen = new Set<string>();
  // Wrapped description lines sit between option rows (live R3: APAC's second line). Walking
  // backward, they appear before the option they belong to — stash, then attach.
  let pendingWrap: string[] = [];

  function takeWrap(description: string): string | undefined {
    if (pendingWrap.length === 0) return description === "" ? undefined : description;
    const extra = pendingWrap.reverse().join(" ").trim();
    pendingWrap = [];
    const joined = [description, extra].filter((s) => s !== "").join(" ");
    return joined === "" ? undefined : joined;
  }

  for (let i = card.end; i >= card.start; i--) {
    const t = texts[i]!;
    if (CHECKBOX.test(t)) return null;
    const zIdle = Z_IDLE.exec(t);
    if (zIdle) {
      let rest = (zIdle[1] ?? "").trim();
      if (/^type your answer here$/i.test(rest)) rest = "";
      else rest = rest.replace(/^[❯>]\s*/, "");
      feedback = { key: "z", focused: false, text: rest, purpose: "free-text" };
      continue;
    }
    const z = Z_FOCUSED.exec(t);
    if (z) {
      feedback = { key: "z", focused: true, text: (z[1] ?? "").trimEnd(), purpose: "free-text" };
      continue;
    }
    if (LETTER_OPTION.test(t)) return null;
    const opt = GUTTER_OPTION_ANY.exec(t);
    if (opt) {
      const n = opt[1]!;
      if (seen.has(n)) return null;
      seen.add(n);
      // Grok's own scrollbar column paints a `█` cell at the right edge of long option rows —
      // it is chrome, not the description's last word.
      const raw = opt[3]!.trim().replace(/\s+█$/, "");
      const split = raw.split(/\s{2,}/);
      const label = (split[0] ?? raw).trim();
      const description = takeWrap(split.slice(1).join(" ").trim());
      const option: PromptOption = { label, keys: [n] };
      if (description !== undefined) option.description = description;
      options.unshift(option);
      continue;
    }
    const hint = HINT_ROW.exec(t);
    if (hint) {
      sawHint = true;
      if (hint[1]!.toLowerCase() === "edit") editHint = true;
      const stepMatch = HINT_STEP.exec(t);
      if (stepMatch) {
        step = { n: Number(stepMatch[1]), m: Number(stepMatch[2]) };
      }
      continue;
    }
    if (FOREIGN_OPTION.test(t)) return null;
    const body = t.replace(/^\s*[┃│]\s*/, "").trim().replace(/\s+█$/, "");
    if (body === "") continue;
    // Unclassified text is QUESTION only above the first option row — where the captured cards
    // put it. Below the options, a gutter continuation is a wrapped description; anything else
    // is an unprobed widget row: refuse.
    if (i > firstOption) {
      if (/^\s*[┃│]/.test(t) && (options.length > 0 || feedback)) {
        pendingWrap.push(body);
        continue;
      }
      return null;
    }
    question = body;
    questionLine = i;
  }

  if (!sawHint) return null;
  if (!feedback) return null;
  if (!isAskFooter(texts[fi]!, feedback.focused)) return null;
  if (question === "" || options.length < 2) return null;
  for (let i = 0; i < options.length; i++) {
    if (options[i]!.keys[0] !== String(i + 1)) return null;
  }
  // `Enter:edit` with an idle-looking z row: the keyboard is parked on the free-text field
  // (Esc from a focused z leaves it there), so a digit would TYPE, not answer. Model it as
  // focused — the renderer locks every option button behind the free-text banner, which is
  // exactly the situation. Live-probed 2026-08-22: digit typed "2" into the field twice via
  // the guarded send path; Up moved off the row and flipped the hint back to Enter:submit.
  if (editHint && !feedback.focused) {
    feedback = { ...feedback, focused: true };
  }

  const parked = FOOTER_PARKED.test(texts[fi]!);
  // Esc-parked card (scrollback view, `Tab/Space:question` footer): a bare digit is silently
  // swallowed — live-probed 2026-08-22 (digit had zero effect; blocked state unchanged). The
  // footer's own named key recovers: Tab re-enters the card, then the digit answers (probed
  // twice — once by QA, once re-verified). The badge keeps showing the digit.
  if (parked) {
    for (let i = 0; i < options.length; i++) {
      const o = options[i]!;
      options[i] = { ...o, keyLabel: o.keys[0], keys: ["Tab", ...o.keys] };
    }
  }

  const signature = regionSignature(texts, start, fi + 1);
  if (signature === "") return null;

  return {
    region: {
      // The block replaces the OPTIONS down; the `┃` question rows above stay in the raw mirror.
      // Same contract as Claude's prompt-select: the renderer never repeats the question, so the
      // mirror is where the operator reads what they're answering.
      startLine: firstOption,
      model: {
        question,
        options,
        family: "select",
        feedback,
        coreSignature: question,
        signature,
      },
    },
    questionLine,
    step,
    parked,
  };
}

/** ask_user_question radio card at the tail, or null. */
export function detectAskRegion(lines: StyledLine[]): AskRegion | null {
  return parseRadioAsk(lines)?.region ?? null;
}

/** Multi-question radio ask ([n/m] hint, m ≥ 2) as a `wizard` question step, or null. */
export function detectAskWizardRegion(lines: StyledLine[]): AskWizardRegion | null {
  const parsed = parseRadioAsk(lines);
  if (!parsed || !parsed.step) return null;
  const { region, questionLine, step, parked } = parsed;
  if (step.m < 2 || step.n < 1 || step.n > step.m) return null;
  if (parked) return null;
  if (region.model.feedback?.focused) return null;

  const steps: WizardStepChip[] = [];
  for (let i = 1; i <= step.m; i++) {
    steps.push({
      label: `${i}/${step.m}`,
      answered: false,
      current: i === step.n,
    });
  }

  const options: WizardOption[] = region.model.options.map((o) => ({
    label: o.label,
    ...(o.description !== undefined ? { description: o.description } : {}),
    keys: [...o.keys],
    chosen: false,
    escape: false,
  }));

  const startLine = questionLine >= 0 ? questionLine : region.startLine;

  return {
    startLine,
    model: {
      phase: "question",
      steps,
      question: region.model.question,
      options,
      signature: region.model.signature,
    },
  };
}

export interface CheckboxAskRegion {
  model: MultiSelectModel;
  startLine: number;
}

function checkboxCellBg(line: StyledLine): string | undefined {
  for (const seg of line.segments) {
    if (seg.text.includes("[") && seg.bg) return seg.bg;
  }
  return undefined;
}

function focusedOptionN(
  rows: { n: number; bg: string | undefined }[],
  zBg: string | undefined,
): number | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.bg) continue;
    counts.set(row.bg, (counts.get(row.bg) ?? 0) + 1);
  }
  let mode: string | undefined;
  let modeCount = 0;
  for (const [bg, count] of counts) {
    if (count > modeCount) {
      mode = bg;
      modeCount = count;
    }
  }
  const highlighted = rows.filter((row) => row.bg && row.bg !== mode);
  if (highlighted.length === 1) return highlighted[0]!.n;
  if (highlighted.length === 0 && zBg && zBg !== mode) return null;
  return null;
}

function splitOptionBody(raw: string): { label: string; description?: string } {
  const cleaned = raw.trim().replace(/\s+█$/, "");
  const parts = cleaned.split(/\s{2,}/);
  const label = (parts[0] ?? cleaned).trim();
  const description = parts.slice(1).join(" ").trim();
  return description === "" ? { label } : { label, description };
}

function checkboxCoreSignature(texts: string[], from: number, to: number): string {
  return texts
    .slice(from, to + 1)
    .map((t) => t.replace(/\[[ xX✔✓]\]/g, "[ ]"))
    .join("\n");
}

/**
 * Checkbox `ask_user_question` at the tail. Same chrome as the radio card (gutter, z row, Enter
 * hint, ask footer) but `[ ]` marks. Digits submit rather than toggle (ASK_NOTES.md). Lifted
 * cards use Tab/Space/Enter; this presence check still forces the dump when the card is unlifted
 * (e.g. an invalid step). Herdr often leaves these as `working`.
 */
export function checkboxAskPresent(lines: StyledLine[]): boolean {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0) return false;
  const card = gutterCardRange(texts, fi, "any");
  if (card === null) return false;

  let sawCheckbox = false;
  let sawZ = false;
  let sawHint = false;
  for (let i = card.start; i <= card.end; i++) {
    const t = texts[i]!;
    if (CHECKBOX.test(t)) sawCheckbox = true;
    if (Z_CHECKBOX.test(t)) sawZ = true;
    if (HINT_ROW.test(t)) sawHint = true;
  }
  if (!sawCheckbox || !sawZ || !sawHint) return false;
  return isAskFooter(texts[fi]!, false);
}

/** Checkbox ask at the tail as a `multi-select` model, or null. Radio → null; `[n/m]` → steps. */
export function detectCheckboxAskRegion(lines: StyledLine[]): CheckboxAskRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0) return null;
  if (!isAskFooter(texts[fi]!, false)) return null;
  const parked = FOOTER_PARKED.test(texts[fi]!);

  const card = gutterCardRange(texts, fi, "any");
  if (card === null) return null;

  const options: MultiSelectOption[] = [];
  const optionRows: { n: number; index: number; bg: string | undefined }[] = [];
  let question = "";
  let questionLine = -1;
  let step: { n: number; m: number } | null = null;
  let sawZ = false;
  let zBg: string | undefined;
  let sawHint = false;
  let firstOption = -1;
  const seen = new Set<string>();
  let pendingWrap: string[] = [];

  function takeWrap(description: string | undefined): string | undefined {
    if (pendingWrap.length === 0) return description === "" ? undefined : description;
    const extra = pendingWrap.reverse().join(" ").trim();
    pendingWrap = [];
    const joined = [description, extra].filter((s) => s !== "").join(" ");
    return joined === "" ? undefined : joined;
  }

  for (let i = card.end; i >= card.start; i--) {
    const t = texts[i]!;
    const hint = HINT_ROW.exec(t);
    if (hint) {
      sawHint = true;
      const s = HINT_STEP.exec(t);
      if (s) step = { n: Number(s[1]), m: Number(s[2]) };
      continue;
    }
    if (Z_CHECKBOX.test(t)) {
      sawZ = true;
      zBg = checkboxCellBg(lines[i]!);
      continue;
    }
    const cb = CHECKBOX_ROW.exec(t);
    if (cb) {
      const n = cb[1]!;
      if (seen.has(n)) return null;
      seen.add(n);
      const mark = cb[2] ?? " ";
      const body = splitOptionBody(cb[3] ?? "");
      const description = takeWrap(body.description);
      const option: MultiSelectOption = {
        n: Number(n),
        label: body.label,
        checked: mark !== " ",
      };
      if (description !== undefined) option.description = description;
      options.unshift(option);
      optionRows.unshift({ n: option.n, index: i, bg: checkboxCellBg(lines[i]!) });
      firstOption = i;
      continue;
    }
    if (LETTER_OPTION.test(t) || GUTTER_OPTION_ANY.test(t)) return null;
    if (FOREIGN_OPTION.test(t)) return null;
    const body = t.replace(/^\s*[┃│]\s*/, "").trim().replace(/\s+█$/, "");
    if (body === "") continue;
    if (i > firstOption && firstOption >= 0) {
      if (/^\s*[┃│]/.test(t) && options.length > 0) {
        pendingWrap.push(body);
        continue;
      }
      return null;
    }
    question = body;
    questionLine = i;
  }

  if (!sawHint || !sawZ) return null;
  if (question === "" || options.length < 2) return null;
  for (let i = 0; i < options.length; i++) {
    if (options[i]!.n !== i + 1) return null;
  }

  if (step !== null && (step.n < 1 || step.n > step.m)) return null;

  let steps: WizardStepChip[] | null = null;
  if (step !== null && step.m >= 2 && !parked) {
    steps = [];
    for (let i = 1; i <= step.m; i++) {
      steps.push({
        label: `${i}/${step.m}`,
        answered: false,
        current: i === step.n,
      });
    }
  }

  const startLine = questionLine >= 0 ? questionLine : firstOption;
  if (startLine < 0) return null;
  const lastOption = optionRows[optionRows.length - 1]!.index;
  const signature = checkboxCoreSignature(texts, startLine, lastOption);
  if (signature === "") return null;
  const focusedN = focusedOptionN(optionRows, zBg);

  return {
    startLine,
    model: {
      phase: "checkbox",
      question,
      options,
      escape: null,
      pointer: focusedN === null ? "other" : "option",
      steps,
      advanceLabel: "Submit",
      recipe: "tab-space-enter",
      ...(parked ? { parked: true } : {}),
      focusedN,
      signature,
      regionSignature: regionSignature(texts, startLine, lastOption + 1),
    },
  };
}
