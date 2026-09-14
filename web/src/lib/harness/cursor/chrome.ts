// Cursor CLI chrome — the bare `→` prompt and the 1–3 status rows under it (mode / Auto / cwd).
// No box borders. Permission, trust, and ask-question dialogs own the keyboard (the composer
// paints under ask cards, but typing is refused so phone sends never type `s` or `k`); detectors in
// those modules must win before stripChrome peels anything. Live-probed 2026-09-12.

import { PROMPT_TAIL_LINES } from "@shared/limits";
import type { StyledLine } from "../../blocks";
import { lastNonBlankIndex, rstrip } from "../scan";
import { findAutocompleteRun } from "./autocomplete";
import { askCardPresent } from "./ask";
import { detectPermissionRegion } from "./permission";
import { detectTrustRegion } from "./trust";
import {
  WORKING_HINT,
  isBlank,
  isDraftContinuationRow,
  isPlaceholderDraft,
  isStatusRow,
  lineText,
  promptBody,
} from "./markers";

const MAX_STATUS_ROWS = 4;
const MAX_BLANK_ABOVE_STATUS = 4;
const MAX_DRAFT_CONTINUATION_ROWS = 100;

export interface ComposerLoc {
  /** Index of the `→ …` prompt row. */
  prompt: number;
  /** Inclusive first status row under the prompt, or -1 when none. */
  statusStart: number;
  /** Exclusive end of the status run (= lastNonBlank + 1 when status present). */
  statusEnd: number;
}

/**
 * Locate Cursor's free-text prompt at the buffer tail, or null.
 *
 *     → <draft or placeholder>          [optional ctrl+c to stop]
 *
 *     Plan (shift+tab to cycle)         optional mode line
 *     Auto · 7.3%                       optional usage / policy
 *     C:\path · branch                  cwd
 */
export function locateComposer(lines: StyledLine[]): ComposerLoc | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const end = lastNonBlankIndex(texts);
  if (end < 0) return null;

  // Peel Cursor's live autocomplete popups off the tail FIRST, before the status-row walk runs.
  // Two shapes: slash-command rows under `→ /partial`, and the `/model` argument picker under
  // `→ /model …` (`Models matching "…"` header; selected row `→  Name`; optional pagination footer).
  // Both replace Auto/cwd status rows with list rows that match neither `isStatusRow` nor blank, so
  // the walk below would stop on the popup and never reach the `→ …` prompt above it. Unpeeled, that
  // reads as "no composer on screen" while the draft is visibly sitting in a live prompt row (see
  // autocomplete.ts — collie#34/#76 shape).
  const popup = findAutocompleteRun(texts, end + 1);
  if (popup !== null) {
    return { prompt: popup.promptLine, statusStart: -1, statusEnd: popup.promptLine + 1 };
  }

  // Collect a short run of status rows at the tail (cwd / Auto / mode / N task(s)).
  // Cursor 2026-09 paints `1 task` between the follow-up prompt and Auto while working; if that
  // row is not status, the walk stops on it and locateComposer returns null — phone sends then
  // refuse or "Type anyway?" into a stall ("Message didn't reach the input box").
  let statusEnd = end + 1;
  let i = end;
  let statusCount = 0;
  while (i >= 0 && statusCount < MAX_STATUS_ROWS && isStatusRow(texts[i]!)) {
    statusCount++;
    i--;
  }
  const statusStart = statusCount > 0 ? i + 1 : -1;

  // Optional blanks between prompt and status (or between prompt and EOF).
  let blanks = 0;
  while (i >= 0 && isBlank(texts[i]!)) {
    if (++blanks > MAX_BLANK_ABOVE_STATUS) return null;
    i--;
  }
  // A long draft soft-wraps onto indented continuation rows above the status block. Unpeeled,
  // the walk stops on the first continuation and never reaches the `→` prompt — composerReady
  // goes false and phone sends stall ("Message didn't reach the input box").
  let continuations = 0;
  while (i >= 0 && continuations < MAX_DRAFT_CONTINUATION_ROWS && isDraftContinuationRow(texts[i]!)) {
    continuations++;
    i--;
  }
  if (i < 0) return null;
  if (promptBody(texts[i]!) === null) return null;

  return {
    prompt: i,
    statusStart,
    statusEnd: statusCount > 0 ? statusEnd : i + 1,
  };
}

export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map((l) => rstrip(lineText(l)));
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.length === 0 ? lines : lines.slice(0, 0);

  const box = locateComposer(lines);
  if (box !== null) {
    end = box.prompt;
    while (end > 0 && isBlank(texts[end - 1]!)) end--;
  }

  return end === lines.length ? lines : lines.slice(0, end);
}

export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  if (
    detectPermissionRegion(lines) !== null ||
    detectTrustRegion(lines) !== null ||
    askCardPresent(lines)
  ) {
    return [];
  }
  const box = locateComposer(lines);
  if (box === null || box.statusStart < 0) return [];
  const out: StyledLine[] = [];
  for (let i = box.statusStart; i < box.statusEnd; i++) {
    if (!isBlank(rstrip(lineText(lines[i]!)))) out.push(lines[i]!);
  }
  return out;
}

export function extractInputDraft(lines: StyledLine[]): string | null {
  if (
    detectPermissionRegion(lines) !== null ||
    detectTrustRegion(lines) !== null ||
    askCardPresent(lines)
  ) {
    return null;
  }
  const box = locateComposer(lines);
  if (box === null) return null;
  const texts = lines.map((l) => rstrip(lineText(l)));
  const body = promptBody(texts[box.prompt]!);
  if (body === null) return null;
  const parts: string[] = [];
  const head = body.trim();
  if (head.length > 0) parts.push(head);
  const stop = box.statusStart >= 0 ? box.statusStart : box.statusEnd;
  for (let j = box.prompt + 1; j < stop; j++) {
    if (isBlank(texts[j]!)) continue;
    if (!isDraftContinuationRow(texts[j]!)) break;
    parts.push(texts[j]!.trim());
  }
  const draft = parts.join(" ");
  if (draft.length === 0 || isPlaceholderDraft(draft)) return null;
  return draft;
}

export function composerReady(lines: StyledLine[]): boolean {
  if (detectPermissionRegion(lines) !== null) return false;
  if (detectTrustRegion(lines) !== null) return false;
  if (askCardPresent(lines)) return false;
  return locateComposer(lines) !== null;
}

const BRIDGE_PROMPT_TAIL_LINES = PROMPT_TAIL_LINES;

export function composerPrompt(lines: StyledLine[]): string | null {
  if (!composerReady(lines)) return null;
  const box = locateComposer(lines);
  if (box === null) return null;
  const texts = lines.map((l) => rstrip(lineText(l)));
  const end = lastNonBlankIndex(texts);
  if (end < 0) return null;
  // Bridge binds within the last PROMPT_TAIL_LINES non-blank rows. A live `/` popup taller than that
  // window (common — the overflow list is ~10 rows) means we cannot name a verifiable region: return
  // null and take an unbound write. Short filtered lists that still fit stay bindable.
  let nonBlankBelow = 0;
  for (let i = box.prompt + 1; i <= end; i++) {
    if (!isBlank(texts[i]!)) nonBlankBelow++;
  }
  if (nonBlankBelow >= BRIDGE_PROMPT_TAIL_LINES) return null;
  return texts[box.prompt]!;
}

/** True when the working hint is on the prompt — useful for tests; not a block kind. */
export function isWorkingChrome(lines: StyledLine[]): boolean {
  const box = locateComposer(lines);
  if (box === null) return false;
  return WORKING_HINT.test(lineText(lines[box.prompt]!));
}
