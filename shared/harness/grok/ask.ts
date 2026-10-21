import { regionSignature, rstrip, lastNonBlankIndex } from "../scan";
// Grok `ask_user_question` card — the captured 2026-08-31 w50:p1 card uses a light `│` gutter
// and `Shift+x:dismiss`; older captures use the heavy `┃` gutter. Both replace the composer.
// Digit N on a radio card was live-probed (ASK_NOTES.md): `2` submitted immediately. Official keys
// continue `1`–`9` then `a`–`f` (Grok user-guide); the phone sends that key. A gap, a letter past
// `f`, or a card that does not start at `1` is a different widget — refuse. Checkbox (`[ ]`) cards
// are a different widget. Live Grok 1.0.52 (2026-10-13): a digit toggles that box and leaves the
// card up. Space still toggles the focused row, so the phone keeps `tab-space-enter` and never
// emits a digit or an `a`–`f` letter. The hint verb names the advance button: `Enter:select`
// and `Enter:next` move to the next question, `Enter:submit` sends the form. Live Grok 4.7
// (2026-10-14) repaints a checkbox hint as `Enter:next` once a box is checked. The complete
// radio layout is that consecutive key run, a `z` row, and an inner
// `Enter:select|submit|edit|next` hint. A card missing
// any of those is refused.
// Esc-park keeps the same card; its footer differs and must still match. Radio prepends Tab so a
// tap re-enters before the digit. Checkbox sets `parked` so the Tab/Space walk Tabs once to re-enter
// before Space; Enter is `Tab, Enter`. Radio `z` is modelled as `purpose: "free-text"` (key `z`) so
// a focused row can lock the option buttons; the phone types that row (submitPromptFeedback). Pi
// and Cursor free-text keys are digits and stay untyped. Screen-only when no catalog is passed.
// One radio option is a real card (a council model question can name a single model). A pending
// `ask_user_question` catalog fills labels the pane ellipsized and options the card scrollbar hid.
//
// When a radio card's hint row contains `[n/m]` with m ≥ 2, it lifts as a `wizard` (question phase)
// rather than `prompt-select`. Stepper chips show 1/m..m/m; Right/Left navigate between questions
// (ASK_NOTES.md); a digit answers the current step. Parked cards and z-focused/edit-hint cards fall
// back to `prompt-select`. `answered` and `chosen` are never inferred from Grok's paint.
//
// When a checkbox card's hint row contains `[n/m]` with m ≥ 2, it lifts as `multi-select` with
// stepper chips 1/m..m/m (parked → no chips), still recipe `tab-space-enter`, digits never emitted.

import type { StyledLine } from "../blocks";
import type { PromptFeedback, PromptModel, PromptOption } from "../prompt-model";
import type { MultiSelectModel, MultiSelectOption } from "../multi-select-model";
import type { WizardModel, WizardOption, WizardStepChip } from "../wizard-model";
import {
  GUTTER_OPTION_ANY,
  gutterCardRange,
  lineText,
  } from "./markers";
import { parseDecisionMarkerLine } from "../../decision-marker";
import type { TranscriptAsk } from "../../wire";
import { catalogSignature, matchAskQuestion } from "./ask-catalog";
import { overlayChecks } from "./ask-checks";

export interface AskRegion {
  model: PromptModel;
  startLine: number;
}

export interface AskWizardRegion {
  model: WizardModel;
  startLine: number;
}

// Official ask keys, in order. Option index i sends ASK_KEYS[i]. Checkbox rows use the same
// order as their ordinal `n` (a = 10 … f = 15) and never send the letter.
const ASK_KEYS = "123456789abcdef";
const CHECKBOX = /^\s*[┃│]\s+[1-9a-f]\s+\[[ x✔✓]\]/i;
const CHECKBOX_ROW = /^\s*[┃│]\s+([1-9a-f])\s+\[([ x✔✓])\]\s*(.*?)\s*$/i;
const Z_CHECKBOX = /^\s*[┃│]\s+z\s+\[[ x✔✓]\]\s+Type your answer here\s*$/i;
// `a`–`f` continue the radio sequence. Any other letter radio row (including a bare `z` that
// missed the free-text rules above) is a different widget.
const LETTER_RADIO = /^\s*[┃│]\s+([a-fA-F])\s+\(([●○])\)\s+(.+?)\s*$/;
const OTHER_LETTER_RADIO = /^\s*[┃│]\s+[a-zA-Z]\s+\(([●○])\)/;
// A radio mark on a checkbox card is a different widget. Digits and `a`–`f` both.
const RADIO_MARK_ROW = /^\s*[┃│]\s+\S{1,3}\s+\([●○•]\)/;
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
const HINT_ROW = /^\s*[┃│]\s+(?:\[\d+\/\d+\]\s+)?↑\/↓ navigate\b.*Enter:(select|submit|edit|next)$/i;
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

function parseRadioAsk(lines: StyledLine[], catalog?: TranscriptAsk | null): RadioAskParse | null {
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
  // Walking upward, each unclassified row overwrote `question`, so a preview line under the
  // prompt (live Grok 1.0.52: the focused option's preview) was dropped. Keep every row.
  const questionParts: string[] = [];
  let questionLine = -1;
  let decision: { thread: string; run: string } | undefined;
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

  function pushRadio(token: string, rawBody: string): boolean {
    const n = token.toLowerCase();
    if (seen.has(n)) return false;
    seen.add(n);
    // Grok's own scrollbar column paints a `█` cell at the right edge of long option rows —
    // it is chrome, not the description's last word.
    const raw = rawBody.trim().replace(/\s+█$/, "");
    const split = raw.split(/\s{2,}/);
    const label = (split[0] ?? raw).trim();
    const description = takeWrap(split.slice(1).join(" ").trim());
    const option: PromptOption = { label, keys: [n] };
    if (description !== undefined) option.description = description;
    options.unshift(option);
    return true;
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
    const letter = LETTER_RADIO.exec(t);
    if (letter) {
      if (!pushRadio(letter[1]!, letter[3]!)) return null;
      continue;
    }
    if (OTHER_LETTER_RADIO.test(t)) return null;
    const opt = GUTTER_OPTION_ANY.exec(t);
    if (opt) {
      if (!pushRadio(opt[1]!, opt[3]!)) return null;
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
    const marker = parseDecisionMarkerLine(body);
    if (marker.kind === "found") {
      decision = { thread: marker.thread, run: marker.run };
      continue;
    }
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
    questionParts.unshift(body);
    questionLine = i;
  }

  const question = questionParts.join(" ");
  if (!sawHint) return null;
  if (!feedback) return null;
  if (!isAskFooter(texts[fi]!, feedback.focused)) return null;
  if (question === "" || options.length < 1) return null;
  const aligned = options.every((o, i) => o.keys[0] === ASK_KEYS[i]);
  const matched = catalog
    ? matchAskQuestion(catalog, {
        widget: "radio",
        question,
        step,
        visible: options.map((o) => ({ n: ASK_KEYS.indexOf(o.keys[0]!) + 1, label: o.label })),
        blob: texts.slice(start, card.end + 1).join("\n"),
      })
    : null;
  let outQuestion = question;
  let outOptions = options;
  if (matched) {
    const rebuilt: PromptOption[] = [];
    for (let i = 0; i < matched.options.length && i < ASK_KEYS.length; i++) {
      const src = matched.options[i]!;
      const key = ASK_KEYS[i]!;
      const opt: PromptOption = { label: src.label, keys: [key] };
      if (src.description) opt.description = src.description;
      rebuilt.push(opt);
    }
    if (rebuilt.length > 0) {
      outQuestion = matched.question;
      outOptions = rebuilt;
    }
  } else if (!aligned) {
    // A window that does not start at `1` is not the whole question. Without a catalog that names
    // the hidden rows, refuse — keys 3–4 must not be sent as 1–2.
    return null;
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
    for (let i = 0; i < outOptions.length; i++) {
      const o = outOptions[i]!;
      outOptions[i] = { ...o, keyLabel: o.keys[0], keys: ["Tab", ...o.keys] };
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
        question: outQuestion,
        options: outOptions,
        family: "select",
        feedback,
        coreSignature: outQuestion,
        signature,
        ...(decision ? { decision } : {}),
      },
    },
    questionLine,
    step,
    parked,
  };
}

/** ask_user_question radio card at the tail, or null. */
export function detectAskRegion(lines: StyledLine[], catalog?: TranscriptAsk | null): AskRegion | null {
  return parseRadioAsk(lines, catalog)?.region ?? null;
}

/** Multi-question radio ask ([n/m] hint, m ≥ 2) as a `wizard` question step, or null. */
export function detectAskWizardRegion(lines: StyledLine[], catalog?: TranscriptAsk | null): AskWizardRegion | null {
  const parsed = parseRadioAsk(lines, catalog);
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
  // The focused checkbox cell is the one whose background differs from the `z` row. A majority
  // vote is wrong at exactly two options: each colour appears once, map order makes the real
  // highlight the mode, and the other row is reported. Live Grok 1.0.44 paints focus
  // rgb(70,70,70) and the unfocused row plus `z` rgb(64,64,64). Zero differences means `z` is
  // focused, the card is parked, or the paint is unreadable — return null rather than Tab onto `z`.
  if (zBg) {
    const differ = rows.filter((row) => row.bg && row.bg !== zBg);
    if (differ.length === 1) return differ[0]!.n;
    if (differ.length === 0) return null;
  }

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
  let leaders = 0;
  for (const count of counts.values()) {
    if (count === modeCount) leaders += 1;
  }
  if (leaders !== 1) return null;
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
 * hint, ask footer) but `[ ]` marks. A digit toggles and is never emitted. Lifted cards use
 * Tab/Space/Enter; this presence check still forces the dump when the card is unlifted (e.g. an
 * invalid step). Rows scrolled off the card still count: the `z [ ]` row and the hint are enough.
 * Herdr often leaves these as `working`.
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
  let sawRadio = false;
  for (let i = card.start; i <= card.end; i++) {
    const t = texts[i]!;
    if (CHECKBOX.test(t)) sawCheckbox = true;
    if (Z_CHECKBOX.test(t)) sawZ = true;
    if (HINT_ROW.test(t)) sawHint = true;
    if (RADIO_MARK_ROW.test(t)) sawRadio = true;
  }
  // A radio card has `z (○)`, not this. A checkbox whose rows scrolled off still has `z [ ]`.
  if (!sawZ || !sawHint || (sawRadio && !sawCheckbox)) return false;
  return isAskFooter(texts[fi]!, false);
}

/** Checkbox ask at the tail as a `multi-select` model, or null. Radio → null; `[n/m]` → steps. */
export function detectCheckboxAskRegion(
  lines: StyledLine[],
  catalog?: TranscriptAsk | null,
): CheckboxAskRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0) return null;
  if (!isAskFooter(texts[fi]!, false)) return null;
  const parked = FOOTER_PARKED.test(texts[fi]!);

  const card = gutterCardRange(texts, fi, "any");
  if (card === null) return null;

  const options: MultiSelectOption[] = [];
  const optionRows: { n: number; index: number; bg: string | undefined }[] = [];
  const questionParts: string[] = [];
  let questionLine = -1;
  let step: { n: number; m: number } | null = null;
  let sawZ = false;
  let zBg: string | undefined;
  let sawHint = false;
  let hintVerb = "";
  // Topmost checkbox row, fixed before the walk. Setting it as the walk climbs made a wrapped
  // description between option 1 and option 2 look like the question, and the question's own
  // second line was then overwritten.
  let firstOption = -1;
  for (let i = card.start; i <= card.end; i++) {
    if (CHECKBOX.test(texts[i]!)) {
      firstOption = i;
      break;
    }
  }
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
      hintVerb = (hint[1] ?? "").toLowerCase();
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
      const token = cb[1]!.toLowerCase();
      const n = ASK_KEYS.indexOf(token) + 1;
      if (n === 0 || seen.has(token)) return null;
      seen.add(token);
      const mark = cb[2] ?? " ";
      const body = splitOptionBody(cb[3] ?? "");
      const description = takeWrap(body.description);
      const option: MultiSelectOption = {
        n,
        label: body.label,
        checked: mark !== " ",
      };
      if (description !== undefined) option.description = description;
      options.unshift(option);
      optionRows.unshift({ n: option.n, index: i, bg: checkboxCellBg(lines[i]!) });
      continue;
    }
    if (RADIO_MARK_ROW.test(t)) return null;
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
    questionParts.unshift(body);
    questionLine = i;
  }

  const screenQuestion = questionParts.join(" ");
  if (!sawHint || !sawZ) return null;
  if (step !== null && (step.n < 1 || step.n > step.m)) return null;
  // `2` then `a` is a different widget. A window of `3`,`4` is the same widget with its top
  // scrolled away — refuse it until a catalog names the rows that are not painted.
  const contiguous = options.every((o, i) => i === 0 || o.n === options[i - 1]!.n + 1);
  if (options.length > 0 && !contiguous) return null;

  const matched = catalog
    ? matchAskQuestion(catalog, {
        widget: "checkbox",
        question: screenQuestion,
        step,
        visible: options.map((o) => ({ n: o.n, label: o.label })),
        blob: texts.slice(card.start, card.end + 1).join("\n"),
      })
    : null;
  const startsAtOne = options.length >= 1 && options.every((o, i) => o.n === i + 1);
  const screenOk = screenQuestion !== "" && startsAtOne;

  let outQuestion = screenQuestion;
  let outOptions = options;
  let signature: string | null = null;
  if (matched && catalog) {
    const painted = new Set(options.map((o) => o.n));
    const glyph = new Map(options.map((o) => [o.n, o.checked]));
    const built: MultiSelectOption[] = matched.options.map((src, i) => {
      const opt: MultiSelectOption = {
        n: i + 1,
        label: src.label,
        checked: painted.has(i + 1) ? (glyph.get(i + 1) ?? false) : false,
      };
      if (src.description) opt.description = src.description;
      return opt;
    });
    outOptions = overlayChecks(catalog.id, step?.n ?? 1, built, painted);
    outQuestion = matched.question;
    signature = catalogSignature(
      catalog.id,
      step,
      outQuestion,
      outOptions.map((o) => o.label),
    );
  } else if (!screenOk) {
    return null;
  }

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

  const startLine = questionLine >= 0 ? questionLine : firstOption >= 0 ? firstOption : card.start;
  if (startLine < 0) return null;
  let regionSig: string;
  if (optionRows.length > 0) {
    const lastOption = optionRows[optionRows.length - 1]!.index;
    if (signature === null) signature = checkboxCoreSignature(texts, startLine, lastOption);
    regionSig = regionSignature(texts, startLine, lastOption + 1);
  } else {
    regionSig = regionSignature(texts, card.start, card.end + 1);
  }
  if (signature === null || signature === "" || regionSig === "") return null;
  const focusedN = focusedOptionN(optionRows, zBg);

  return {
    startLine,
    model: {
      phase: "checkbox",
      question: outQuestion,
      options: outOptions,
      escape: null,
      pointer: focusedN === null ? "other" : "option",
      steps,
      // `Enter:select` and `Enter:next` advance. `Enter:submit` sends the form. The button
      // says which of those the hint row names.
      advanceLabel: hintVerb === "select" || hintVerb === "next" ? "Next" : "Submit",
      recipe: "tab-space-enter",
      ...(parked ? { parked: true } : {}),
      focusedN,
      signature,
      regionSignature: regionSig,
    },
  };
}
