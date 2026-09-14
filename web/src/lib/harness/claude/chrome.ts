// Chrome stripping — trims the agent's own TUI chrome off the TAIL of a parsed buffer so the app's
// composer/statusline supersedes it instead of duplicating it. Today that's the Claude Code input
// box (the "❯ …" prompt line sandwiched between two rules) plus the statusline / hint lines below it
// and any trailing blank runs.
//
// Deliberately CONSERVATIVE: it strips only when the WHOLE input-box shape matches confidently at
// the tail, and never removes content above it — when unsure it returns the buffer untouched (the
// T1 raw-mirror fallback). Pure; operates on parsed line text, so a user-configured statusline is
// matched by POSITION (below the box's bottom border), never by its content strings.

import type { StyledLine } from "../../blocks";
import { isBlank, isBoxBorder, isInputBoxTopBorder, lineText } from "./markers";
import { findTailBox } from "../scan";
import { findAutocompleteRun } from "./autocomplete";

// Rows allowed DIRECTLY under the input box's bottom border: the statusline plus its hint row(s)
// ("← for agents", "⏵⏵ bypass permissions on …"). A statusline is an arbitrary user command's output,
// so this run is as tall as the user made it. The ceiling only stops a borderless buffer matching
// unboundedly — it guards less than it looks, and mirrors MAX_FOOTER_LINES: see ADR 0004.
const MAX_STATUS_LINES = 8;

// A newer Claude Code UI paints a "background agents" footer BELOW the statusline/hint, separated from
// them by a blank line: a bold "● main" header and one row per background agent
// ("◯ <agent>  <task…>   <elapsed> · ↓ <tokens>"). We peel it off the tail as chrome too, bounded to
// this many rows (header + a handful of agents, plus a possible "… +N more" line) so a borderless
// buffer still can't strip unboundedly — an over-long block just falls back to the raw mirror.
const MAX_FOOTER_LINES = 8;

// A long draft WRAPS inside the input box: the "❯ …" prompt line plus continuation lines (indented,
// no leading "❯") before the bottom border. We scan up past those to find the prompt, bounded by
// MAX_DRAFT_LINES — but as DEFENSE-IN-DEPTH, not a correctness bound. The caller's read window
// defaults to 200 lines (SIGHTR_READ_LINES, bridge/config.ts) and is client-requestable up to
// MAX_READ_LINES (10,000, bridge/server.ts), so an unbounded walk would let a stray line that happens
// to look like a border (see isBoxBorder in markers.ts) pair up with an unrelated quoted "❯" line
// dozens (or thousands) of lines further up to complete a full (bogus) box shape — the cap, not the
// border test alone, is what keeps that match from reaching all the way there. Every line the walk
// crosses counts against this cap, blank or not: a run of blank padding is not a free pass either
// (see the blank-line skips inside locateInputBox below, both bounded by the same counter). The OLD
// cap (12) was simply too tight: a real 610-char/25-line CJK draft wraps to ~40 rows at a narrow
// pane's column count (CJK glyphs are 2 cells wide), well past it, which made locateInputBox return
// null and stalled the send guard for good (collie#76). Removing the cap entirely was considered and
// rejected for the reason above. 100 comfortably covers the observed ~40-row case plus a worst case
// around 70–80 rows at a 19-column pane, with margin, while still capping how far the walk can reach.
const MAX_DRAFT_LINES = 100;

// Text Claude draws on the "❯" prompt line that is NOT a real user draft — it's a hint the TUI paints
// when the box is otherwise empty. Must never be surfaced as a recoverable draft. Kept as an array so
// more variants can be added without touching the extraction logic.
const INPUT_PLACEHOLDERS = ["Press up to edit queued messages"];

/**
 * Return `lines` with any confidently-matched trailing chrome removed. When nothing matches the
 * input is returned as-is (same reference), so callers can treat an unchanged result as "no chrome".
 */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map(lineText);
  let end = lines.length; // exclusive bound of the kept range

  // 1. Drop a trailing run of blank lines.
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.slice(0, 0);

  // 2. Peel the input box off the tail if the full shape is present. Only then; otherwise the
  //    blank-trim above is the sole (safe) change.
  const box = locateInputBox(texts, end);
  if (box !== null) {
    end = box.top;
    // Drop the blank run now exposed above the box (a fresh session has an empty body above it).
    while (end > 0 && isBlank(texts[end - 1]!)) end--;
  }

  return end === lines.length ? lines : lines.slice(0, end);
}

/**
 * The statusline RUN the agent draws just under its input box — model, ctx%, cwd, branch, tokens,
 * permission mode, whatever the user configured, plus the TUI's own hint row(s). We strip the box
 * off the mirror (stripChrome), so this re-surfaces those rows as app chrome above the composer
 * instead of losing them.
 *
 * ALL of them, not just the first: a statusline is an arbitrary user command's output and is
 * routinely 2–3 rows (ctx/limits on one, model + cwd + branch on the next, permission mode on the
 * third). Surfacing only the first row silently dropped everything after it — the very fields the
 * mirror can no longer show.
 *
 * POSITIONAL only: every non-blank line strictly below the box's bottom border and above where the
 * background-agents footer starts (locateInputBox draws that line, so the footer never leaks in
 * here). Returns the rows STYLED, top to bottom, or `[]` when there's no input box at the tail (a
 * menu is up, or a non-Claude / torn buffer). Never interprets the content — the caller renders it
 * verbatim.
 *
 * Styled, not flattened, because a statusline is colour-carrying by design: the model, the context
 * meter and the git branch are told apart by colour before they're read. Flattening to text here
 * threw that away one call before the strip that renders it. The caller draws these in the mirror's
 * dark space (see mirror-space.ts) — terminal colour only means what it means against a dark
 * background.
 */
export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return [];

  const box = locateInputBox(texts, end);
  if (box === null) return [];

  const rows: StyledLine[] = [];
  for (let j = box.bottomBorder + 1; j < box.statusEnd; j++) {
    if (!isBlank(texts[j]!)) rows.push(lines[j]!);
  }
  return rows;
}

/**
 * The user's draft text stranded on the input box's "❯" prompt line. When a message is queued while
 * the agent is busy and then recalled (Up/Esc), the text lands here and persists across turns — but
 * stripChrome peels the whole box off the mirror, so it becomes invisible, and the composer (local
 * state only) never learns of it. This re-surfaces it so the app can offer to recover it.
 *
 * Reads the prompt line found by locateInputBox: drop the leading "❯" marker and its separator space
 * (Claude renders a U+00A0 there, which JS trim() strips), then trim. A draft too long for one line
 * WRAPS onto continuation lines inside the box; those are folded back in (each trimmed of its
 * alignment indent, joined with a single space — Claude soft-wraps at word boundaries, so the dropped
 * break was a space). Returns `null` when there's no input box at the tail, the box is empty (bare
 * "❯"), or the line is a known TUI placeholder (INPUT_PLACEHOLDERS) rather than a real draft.
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;

  const box = locateInputBox(texts, end);
  if (box === null) return null;

  let head = texts[box.prompt]!.trimStart();
  if (head.startsWith("❯")) head = head.slice(1);
  const parts = [head.trim()];
  // Continuation lines of a wrapped draft: everything between the prompt and the bottom border,
  // de-indented. Blank lines are dropped (interior/trailing padding), so they never inject a space.
  for (let j = box.prompt + 1; j < box.bottomBorder; j++) {
    const t = texts[j]!.trim();
    if (t.length > 0) parts.push(t);
  }
  const draft = parts.join(" ").trim();
  if (draft.length === 0 || INPUT_PLACEHOLDERS.includes(draft)) return null;
  return draft;
}

/**
 * Whether the agent's own free-text input box is on screen at the tail — i.e. whether typing a reply
 * would land in the composer input at all. FALSE means a modal (a menu, a dialog, a full-screen
 * picker) owns the keyboard, so `pane.send_text` would be typed INTO it.
 *
 * Two callers, both of which need exactly this and must not re-derive it:
 *  - the generic menu grammar (menu.ts), whose last-resort footer match would otherwise claim an
 *    ordinary prompt screen that happens to end in a `·`-separated hint row;
 *  - the reply path's pre-flight (lib/reply-action.ts via the adapter's `composerReady`), which
 *    refuses to type at all when the box isn't there.
 */
export function hasInputBox(lines: StyledLine[]): boolean {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return false;
  return locateInputBox(texts, end) !== null;
}

interface InputBox {
  /** Index of the TOP border — the exclusive bound of everything ABOVE the box (stripChrome uses it). */
  top: number;
  /** Index of the "❯" prompt line, between the two borders — carries the draft (extractInputDraft). */
  prompt: number;
  /** Index of the BOTTOM border — the statusline run, if any, starts on the next line. */
  bottomBorder: number;
  /** EXCLUSIVE end of the statusline run: one past its last row, i.e. where the blank separator +
   *  background-agents footer begin (or the buffer's last non-blank line when there is no footer).
   *  `bottomBorder + 1` when the box has no statusline at all. Only the walk down there knows where
   *  the run stops, so it hands the bound out rather than letting extractStatusLines re-derive it. */
  statusEnd: number;
}

/**
 * If the range ending at `end` (exclusive; `end-1` is the last non-blank line) ends in the Claude
 * input-box shape —
 *
 *     <top border>
 *     ❯ <draft>            (the prompt line)
 *     <continuation…>      (0..MAX_DRAFT_LINES wrapped-draft lines, no leading "❯")
 *     <bottom border>
 *     <statusline>         (statusline + hint rows together are 0..MAX_STATUS_LINES, by position)
 *     <hint line>
 *     <blank>              (optional — separates the background-agents footer, if present)
 *     <● main>             (0..MAX_FOOTER_LINES footer lines, matched by position not content)
 *     <◯ agent …>
 *
 * return the top and bottom border indices plus the prompt-line index. Otherwise null. Scans
 * bottom-up.
 *
 * The SLASH-AUTOCOMPLETE POPUP is peeled off the tail FIRST, before any of that. While the operator
 * is typing a slash command, Claude replaces the statusline with its completion list — a run of
 * entry/continuation rows directly under the bottom border, 23 rows for `/model` on a machine with
 * many skills. That run is far taller than MAX_STATUS_LINES, so the statusline walk used to eat the
 * cap and never reach the border: the box went undetected, `hasInputBox` (and therefore
 * `composerReady`) read false, and every send stalled while the draft sat in a live input box.
 *
 * The cap is NOT raised to cover it, per archive/.adr/0004-the-statusline-run-is-bounded.md: the row
 * count is not what protects this walk, and a taller blind window admits more screens it should
 * refuse. Instead the popup is matched by its own SHAPE (./autocomplete.ts) and removed from the tail,
 * and the ordinary walk then runs from the row above it — seeing exactly what it would have seen if
 * the popup were not painted at all.
 *
 * The peel is confirmed, not assumed: the box it produces must hold a draft that STARTS WITH "/",
 * which is the only condition under which Claude paints this popup at all. When it doesn't (or when
 * no popup matches), the walk runs unchanged from `end`, so nothing that worked before can regress.
 */
function locateInputBox(texts: string[], end: number): InputBox | null {
  const popup = findAutocompleteRun(texts, end);
  if (popup !== null) {
    const box = walkInputBox(texts, popup.start);
    if (box !== null && promptIsSlashCommand(texts, box)) return box;
  }
  return walkInputBox(texts, end);
}

/** Whether the box's "❯" line holds a slash command — the draft state that puts the popup on
 *  screen. Claude renders a U+00A0 after the marker, which JS `trim()` strips. */
function promptIsSlashCommand(texts: string[], box: InputBox): boolean {
  const head = texts[box.prompt]!.trimStart();
  return (head.startsWith("❯") ? head.slice(1) : head).trim().startsWith("/");
}

/** The walk itself: bottom-up from `end` (exclusive). */
function walkInputBox(texts: string[], end: number): InputBox | null {
  let scanEnd = end;
  let j = end - 1;
  let footer = 0;
  while (j >= 0 && !isBoxBorder(texts[j]!) && !isBlank(texts[j]!) && footer < MAX_FOOTER_LINES) {
    footer++;
    j--;
  }
  if (footer > 0 && j >= 0 && isBlank(texts[j]!)) {
    while (j >= 0 && isBlank(texts[j]!)) j--;
    scanEnd = j + 1;
  }
  const box = findTailBox(texts, {
    end: scanEnd,
    bottom: isBoxBorder,
    top: isInputBoxTopBorder,
    below: (text) => !isBlank(text) && !isBoxBorder(text),
    maxBelow: MAX_STATUS_LINES,
    inner: (text) => !isBoxBorder(text) && !text.trimStart().startsWith("❯"),
    maxInner: MAX_DRAFT_LINES,
    prompt: (text) => text.trimStart().startsWith("❯"),
    maxBlankRun: MAX_DRAFT_LINES,
  });
  if (box === null) return null;
  return { top: box.top, prompt: box.prompt, bottomBorder: box.bottom, statusEnd: box.belowEnd };
}

