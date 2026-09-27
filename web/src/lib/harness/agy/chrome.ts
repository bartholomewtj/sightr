import type { StyledLine } from "../../blocks";
import { isBlank, isBoxBorder, lineText } from "./markers";
import { findTailBox } from "../scan";

const MAX_STATUS_LINES = 4;
const MAX_DRAFT_LINES = 100;
const PROMPT_REGEX = /^[❯›>]\s*/;

export interface LocatedBox {
  top: number;
  prompt: number;
  bottomBorder: number;
  statusEnd: number;
}

export function locateInputBox(texts: string[], end: number): LocatedBox | null {
  // AGY has no safe bare-prompt fallback: submitted messages and selection rows use the same `>`
  // glyph, so only the complete boxed shape may authorise a composer.
  const box = findTailBox(texts, {
    end,
    bottom: isBoxBorder,
    top: isBoxBorder,
    below: () => true,
    maxBelow: MAX_STATUS_LINES - 1,
    inner: (text) => !isBoxBorder(text) && !PROMPT_REGEX.test(text),
    maxInner: MAX_DRAFT_LINES,
    prompt: (text) => PROMPT_REGEX.test(text),
    maxBlankRun: MAX_DRAFT_LINES,
  });
  if (box === null) return null;
  return { top: box.top, prompt: box.prompt, bottomBorder: box.bottom, statusEnd: box.belowEnd };
}

export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.slice(0, 0);

  const box = locateInputBox(texts, end);
  if (box !== null) {
    end = box.top;
    while (end > 0 && isBlank(texts[end - 1]!)) end--;
  }

  return end === lines.length ? lines : lines.slice(0, end);
}

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

export function extractInputDraft(lines: StyledLine[]): string | null {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;
  const box = locateInputBox(texts, end);
  if (box === null) return null;
  let head = texts[box.prompt]!.replace(PROMPT_REGEX, "").trim();
  const parts = [head];
  for (let i = box.prompt + 1; i < box.bottomBorder; i++) {
    const text = texts[i]!.trim();
    if (text.length > 0) parts.push(text);
  }
  return parts.join(" ").trim() || null;
}

/**
 * A draft taller than the box scrolls: Agy swaps its head for `↑ N more lines` and shows only the
 * tail (live 2026-09-28, Agy 1.2.12, 40 wrapped rows → `> ↑ 56 more lines`). N counts wrapped screen
 * rows, which the phone cannot map back to text, so the marker proves nothing on its own.
 */
const SCROLLED_HEAD = /^↑\s*\d+\s+more\s+lines?(?=\s|$)/;

/** Fewest non-space characters of visible tail worth matching against the send's end. */
const MIN_TAIL_CHARS = 8;

/** True when the draft is a scrolled box: the marker, then only the tail of the real text. */
export function isScrolledDraft(draft: string): boolean {
  return SCROLLED_HEAD.test(draft);
}

/**
 * The guard's second look for a scrolled box. The cursor sits at the end of a fresh paste, so the
 * visible rows are the END of what was sent: accept only when the tail, whitespace-stripped (the box
 * re-wraps rows), is how the sent text ends.
 */
export function scrolledDraftCarriesSend(sent: string, draft: string): boolean {
  const head = SCROLLED_HEAD.exec(draft);
  if (head === null) return false;
  const tail = draft.slice(head[0].length).replace(/\s+/g, "");
  if (tail.length < MIN_TAIL_CHARS) return false;
  return sent.replace(/\s+/g, "").endsWith(tail);
}

export function hasInputBox(lines: StyledLine[]): boolean {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return false;
  return locateInputBox(texts, end) !== null;
}
