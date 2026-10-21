// Pi's input editor, read off the screen. The bridge imports this through composer-kit.ts, so it keeps
// that file's rules: leaf imports only (blocks, markers), never `@shared`, never `react`.
//
// Pi draws its editor as text between two horizontal rules, with no side borders and no prompt
// glyph, directly above a footer whose first row is the working directory and whose second is the
// token / context stats (captured live: pi--idle-empty.txt, pi--draft-wrapped.txt):
//
//   ───────────────────────────────  top border; may carry `── ⠙ Working ──` or `── ↑ 3 more ──`
//   List the files in the web2/…     the draft, word-wrapped; an empty editor is one blank row
//   ───────────────────────────────  bottom border; may carry `── ↓ 2 more ──`
//   ~\path (branch)                  footer: pwd
//   0.0%/262k (auto)    model • lvl  footer: stats (STATS)
//   thickAPI claude via bridge       optional extension status row
//
// Pi's ask dialog takes the editor's place with the same rules around it, so a region holding one of
// its help rows is a dialog, not the composer.
//
// Startup (pi--startup-in-progress.txt): Pi accepts typing as soon as the editor is drawn, but until
// its managed-tool setup ends an Enter only puts the text back in the editor and prints a dim
// "Startup is still in progress" in the chat. Pi then never retries; the text waits for another
// Enter. `submitHeld` is that state: the marker is the newest chat row above the editor.

import { isBlank, lineText, type StyledLine } from "../blocks";
import { HELP_INPUT, HELP_MULTI, HELP_SINGLE, RULE, STATS, TAB_BAR, YOUR_ANSWER } from "./markers";

/** Pi's words when it refuses a submit during startup (interactive-mode `handleStartupSubmit`). */
export const STARTUP_MARKER = "Startup is still in progress";

/** The bottom border: a plain rule, or the scroll border when lines are hidden below. */
const BOTTOM_BORDER = /^─+ ↓ \d+ more ─*$/;
/** The top border: a rule, the scroll border (`↑ N more`), or one carrying the working status. */
const TOP_BORDER = /^─{2,}/;
/** Pi's editor shows at most max(5, 30% of the rows); this bounds the upward search for its top. */
const MAX_EDITOR_ROWS = 60;
/** The bottom border sits this close to the last non-blank row (pwd, stats, one status row). */
const MAX_FOOTER_ROWS = 4;
/** Pi's completion list: the selected row opens with an arrow; at most this many rows show. */
const COMPLETION_SELECTED = /^→ \S/;
const MAX_COMPLETION_ROWS = 10;

const DIALOG_ROWS = [HELP_SINGLE, HELP_MULTI, HELP_INPUT, TAB_BAR, YOUR_ANSWER];

interface EditorBox {
  top: number;
  bottom: number;
}

function locateEditor(texts: string[]): EditorBox | null {
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  if (end < 0) return null;

  // The bottom border: the last rule within the footer's reach of the tail.
  let bottom = -1;
  for (let i = end; i >= Math.max(0, end - MAX_FOOTER_ROWS - MAX_COMPLETION_ROWS); i--) {
    const t = texts[i]!.trimEnd();
    if (RULE.test(t) || BOTTOM_BORDER.test(t)) {
      bottom = i;
      break;
    }
  }
  if (bottom < 1) return null;

  // Under it, nothing (no footer) or the footer: pwd, then stats, then at most two status rows,
  // directly below (a completion list between the border and the footer is not the bare composer).
  const after = texts.slice(bottom + 1, end + 1);
  if (after.length > 0) {
    if (after.some(isBlank)) return null;
    // A slash-command or path completion list may sit between the border and the footer (captured
    // live: pi--slash-menu.txt): up to MAX_COMPLETION_ROWS rows, the selected one first, led by
    // `→ `. It is the composer with its menu open, not another screen.
    let footer = 0;
    while (footer < after.length && !(footer + 1 < after.length && STATS.test(after[footer + 1]!))) footer++;
    if (footer >= after.length - 1 || after.length - footer > MAX_FOOTER_ROWS) return null;
    if (footer > 0 && (footer > MAX_COMPLETION_ROWS || !COMPLETION_SELECTED.test(after[0]!))) return null;
  }

  // The top border starts at column 0; the ask dialog's own rows are indented.
  let top = -1;
  for (let i = bottom - 1; i >= Math.max(0, bottom - 1 - MAX_EDITOR_ROWS); i--) {
    if (TOP_BORDER.test(texts[i]!)) {
      top = i;
      break;
    }
  }
  if (top < 0 || bottom - top < 2) return null;

  for (let i = top + 1; i < bottom; i++) {
    if (DIALOG_ROWS.some((re) => re.test(texts[i]!))) return null;
  }
  return { top, bottom };
}

/** Whether Pi's own input editor is at the tail, with no dialog in its place. */
export function composerReady(lines: StyledLine[]): boolean {
  return locateEditor(lines.map(lineText)) !== null;
}

/**
 * The text in Pi's editor, its wrapped rows joined with one space (Pi wraps at word boundaries, so
 * the dropped break was a space), or null when there is no editor or it is empty. An empty editor is
 * a single blank row (or just the cursor cell); Pi shows no placeholder, so nothing else reads as text.
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const texts = lines.map(lineText);
  const box = locateEditor(texts);
  if (box === null) return null;
  const parts: string[] = [];
  for (let i = box.top + 1; i < box.bottom; i++) {
    const t = texts[i]!.trim();
    if (t.length > 0) parts.push(t);
  }
  const draft = parts.join(" ").trim();
  return draft.length > 0 ? draft : null;
}

/**
 * Pi refused the last submit because startup is still running, and kept the text in the editor: the
 * newest non-blank row above the editor is STARTUP_MARKER. Pi prints that row only in answer to an
 * Enter, and anything Pi adds afterwards (the managed tools' "installed to", the loaded resources)
 * pushes it up, so it reads true only until startup has visibly moved on.
 */
export function submitHeld(lines: StyledLine[]): boolean {
  const texts = lines.map(lineText);
  const box = locateEditor(texts);
  if (box === null) return false;
  for (let i = box.top - 1; i >= 0; i--) {
    if (isBlank(texts[i]!)) continue;
    return texts[i]!.trim() === STARTUP_MARKER;
  }
  return false;
}
