// Cursor CLI markers — prompt glyph, placeholders, status rows, and dialog option shapes.
// Verified against live pane dumps on 2026-09-12 (probe-cursor / wC0:p1 and the main Cursor seat).
// `N task(s)` status row: live 2026-09-13 (wAC:p1M working chrome).
// `Composer N.N` model row: live 2026-09-13 (wAC:p1S working chrome).
// `Claude Fable …` / `72.6% · N files edited` rows: live 2026-09-14 (wAC:p3X idle, Fable model).

import { isBlank, lineText } from "../../blocks";

export { isBlank, lineText };

/** Bare follow-up / idle prompt. Pointer on a permission option also uses `→` — detectors must run first. */
export const PROMPT_LINE = /^\s*→\s+(.*)$/;

/** Placeholder copy that is not a user draft. */
const PLACEHOLDERS = [
  /^Plan, search, build anything$/i,
  /^Add a follow-up$/i,
  /^Tell the agent what to do instead\b/i,
];

/** Mode / usage / permission-policy status painted under the prompt. */
export const MODE_STATUS =
  /^\s*(?:Auto|Plan|Ask|Debug|Agent|Composer)\b(?:\s|$|\s*\(|\s*·)/;

/** Cwd (+ optional branch) status at the very tail. */
export const CWD_STATUS = /^\s*(?:[A-Za-z]:\\|\/|~\/)/;

/** Todo/task count Cursor paints under the follow-up prompt while a turn is running. */
export const TASK_STATUS = /^\d+\s+tasks?$/i;

/** Context usage and edit stats (`72.6% · 20 files edited`, also embedded in longer status rows). */
export const USAGE_STATUS = /\d+\.?\d*%\s*·/;

/** Model label when Cursor shows the pick outside Auto/Composer (`Claude Fable 5.1 300K High`). */
export const MODEL_STATUS = /^(?:Claude|GPT|Gemini|Grok|Cursor)\b/i;

export const WORKING_HINT = /ctrl\+c to stop/i;

export function promptBody(text: string): string | null {
  const m = PROMPT_LINE.exec(text);
  if (m === null) return null;
  // Strip a right-aligned working hint on the same row.
  return m[1]!.replace(/\s+ctrl\+c to stop\s*$/i, "").trimEnd();
}

export function isPlaceholderDraft(draft: string): boolean {
  const t = draft.trim();
  return PLACEHOLDERS.some((re) => re.test(t));
}

export function isStatusRow(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (MODE_STATUS.test(t)) return true;
  if (CWD_STATUS.test(t)) return true;
  if (TASK_STATUS.test(t)) return true;
  if (USAGE_STATUS.test(t)) return true;
  if (MODEL_STATUS.test(t)) return true;
  // Right-hand policy chip sometimes shares the Auto row; alone it is still status.
  if (/^Run Everything$/i.test(t)) return true;
  return false;
}

/** Wrapped-draft continuation: indented text under the `→` row, above status. Live 2026-09-13. */
export function isDraftContinuationRow(text: string): boolean {
  const t = text.trimEnd();
  if (t.trim().length === 0) return false;
  if (promptBody(t) !== null) return false;
  if (isStatusRow(t)) return false;
  // Cursor soft-wraps with two+ leading spaces and no prompt glyph on the row.
  return /^\s{2,}\S/.test(t) && !/^\s*→/.test(t);
}

/** Command-approval option rows: key is the parenthetical at the end. */
export const APPROVAL_OPTION =
  /^\s*(?:→\s+)?(.+?)\s*\((y|tab|shift\+tab|esc or n)\)\s*$/i;

// Ask-question card markers (`./src/components/ask-question-form.tsx` in v2026.09.10-fd3934a build).
export const ASK_BOX_TOP = /^\s*┌─+┐.*$/;
export const ASK_BOX_BOTTOM = /^\s*└─+┘.*$/;
export const ASK_BOX_ROW = /^\s*│(.*)│.*$/;
export const ASK_COUNTER = /^Question (\d+) of (\d+)$/;
export const ASK_FOOTER =
  /^↑\/↓ option · ←\/→ question · Space select · Enter next\/submit · Esc to skip$/;
export const ASK_OPTION = /^ {2}(› | {2})\[( |x)\] (.*)$/;
export const ASK_LABEL_WRAP = /^ {8}\S/;
export const ASK_OTHER = /^Other: (.*)$/;
export const ASK_MULTI_SUFFIX = / \(multi-select\)$/;

