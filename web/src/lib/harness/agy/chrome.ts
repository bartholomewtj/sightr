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

export function hasInputBox(lines: StyledLine[]): boolean {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return false;
  return locateInputBox(texts, end) !== null;
}
