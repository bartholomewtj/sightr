import { regionSignature, rstrip, lastNonBlankIndex } from "../scan";
// Grok Build permission card — the heavy `┃` or light `│` gutter dialog that replaces the
// composer when a tool needs approval. The card's option count varies by tool class, so the gate
// is classification, not a pinned layout: the footer must name this card family and count its
// rows, there must be exactly one one-shot Yes above exactly one reject, and every other row must
// PROVE it is a persistent mode change by its label — those are never buttons. A row that
// fits no class refuses the whole card (fail-closed null). Digit N confirms row N immediately;
// probed on both layouts; the live light-gutter card specifically confirmed digits 3 (Yes) and
// 4 (No). Pure; no pane access.

import type { StyledLine } from "../../blocks";
import type { PromptModel } from "../prompt-model";
import { GUTTER_OPTION_PERMISSION, gutterCardRange, lineText, } from "./markers";

export interface PermissionRegion {
  model: PromptModel;
  startLine: number;
}

const FOOTER_COUNT = /(?:^|\s)1\/([1-9]):select/;
const FOOTER_TAB = /Tab:next option/i;
const FOOTER_ALWAYS = /Ctrl\+o:always-approve/i;
const FOOTER_CANCEL = /Ctrl\+c:cancel/i;

// Every row except the one-shot Yes and reject must be a persistent mode change, recognised by
// its label. Probed shapes include global always-approve ("…don't ask again for anything
// (always-approve mode)"), "Always allow", "Never allow", and the session-scoped variant
// ("Yes, allow all edits during this session"). A row matching neither has semantics we haven't
// probed — refuse the card.
const PERSISTENT = /always-approve|don['’]t ask again|this session|^always allow:|^never allow:/i;
const YES_ROW = /^yes\b/i;
const NO_ROW = /^no, reject\b/i;
const FOREIGN_OPTION = /^\s*[┃│]\s+\S{1,3}\s+[([]/;
const SCOPE_CHROME_ROW = /^← → narrow scope\s+·\s+e edit pattern$/;

/** Trailing parenthetical stripped for the button face — "No, reject (type to add feedback)"
 *  renders as "No, reject"; a label without one is unchanged. */
function buttonLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** Permission card at the tail, or null. */
export function detectPermissionRegion(lines: StyledLine[]): PermissionRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0) return null;
  const footer = texts[fi]!;
  const count = FOOTER_COUNT.exec(footer);
  if (count === null) return null;
  if (!FOOTER_TAB.test(footer) || !FOOTER_ALWAYS.test(footer) || !FOOTER_CANCEL.test(footer)) {
    return null;
  }

  const card = gutterCardRange(texts, fi, "permission");
  if (card === null) return null;
  const start = card.start;

  let firstOption = -1;
  for (let i = card.start; i <= card.end; i++) {
    if (GUTTER_OPTION_PERMISSION.test(texts[i]!)) {
      firstOption = i;
      break;
    }
  }
  if (firstOption < 0) return null;

  // Visual order, not a Map: a duplicate digit would otherwise last-write-win and a
  // shuffled card would still look like a probed 1..n layout.
  const ordered: { digit: string; label: string }[] = [];
  let question = "";
  for (let i = card.end; i >= card.start; i--) {
    const t = texts[i]!;
    const opt = GUTTER_OPTION_PERMISSION.exec(t);
    if (opt) {
      ordered.unshift({ digit: opt[1]!, label: opt[3]!.trim() });
      continue;
    }
    // A row shaped like a control — a short key token followed by a mark — that GUTTER_OPTION
    // did not match is an unprobed widget row (letter key, checkbox, multi-digit): refuse the
    // whole card rather than lift around it.
    if (FOREIGN_OPTION.test(t)) return null;
    const body = t.replace(/^\s*[┃│]\s*/, "").trim();
    if (body === "" || SCOPE_CHROME_ROW.test(body)) continue;
    // Unclassified text is QUESTION only above the first option row — where the captured cards
    // put the title and command. Below the options it is an unprobed row: refuse.
    if (i > firstOption) return null;
    question = body;
  }

  // The footer's own row count is the cross-check: a torn frame that lost an option row (or
  // gained a stray one) disagrees with `1/N:select` and refuses. Minimum three rows: the footer
  // advertises Ctrl+o:always-approve, so a card without a persistent row above the Yes/No pair
  // contradicts its own footer — every capture has at least one.
  const n = ordered.length;
  if (question === "" || n < 3 || n !== Number(count[1]!)) return null;
  for (let i = 0; i < n; i++) {
    if (ordered[i]!.digit !== String(i + 1)) return null;
  }

  const yesRows = ordered.filter((row) => YES_ROW.test(row.label) && !PERSISTENT.test(row.label));
  const noRows = ordered.filter((row) => NO_ROW.test(row.label));
  if (yesRows.length !== 1 || noRows.length !== 1) return null;
  const yes = yesRows[0]!;
  const no = noRows[0]!;
  const yesIndex = ordered.indexOf(yes);
  const noIndex = ordered.indexOf(no);
  if (yesIndex >= noIndex) return null;
  for (let i = 0; i < n; i++) {
    if (i !== yesIndex && i !== noIndex && !PERSISTENT.test(ordered[i]!.label)) return null;
  }

  const signature = regionSignature(texts, start, fi + 1);
  if (signature === "") return null;

  return {
    // The block replaces the options down; the gutter question/chrome rows above stay in the raw mirror.
    // Same contract as Claude's prompt-select: the renderer never repeats the question, so the
    // mirror is where the operator reads what they're approving.
    startLine: firstOption,
    model: {
      question,
      options: [
        { label: buttonLabel(yes.label), keys: [yes.digit] },
        { label: buttonLabel(no.label), keys: [no.digit] },
      ],
      family: "permission",
      coreSignature: question,
      signature,
    },
  };
}
