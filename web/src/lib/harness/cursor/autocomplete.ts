// Cursor CLI's live autocomplete popups — two shapes that both block `locateComposer` if unpeeled:
//
// 1. Slash-command list under a bare `→ /partial` prompt (2026-09-13 captures:
//    `cursor--autocomplete-slash*.txt`).
// 2. `/model` argument picker under `→ /model …` (2026-09-14 captures:
//    `cursor--autocomplete-model*.txt`).
//
// Unpeeled, the status-row walk stops on popup rows, `promptBody` never reaches the live `→ …`
// prompt, `composerReady` / `extractInputDraft` read false, and phone sends report "Message didn't
// reach the input box" (actions.ts) while the draft is visibly on screen.

import { isBlank, lineText } from "../../blocks";
import { promptBody } from "./markers";

export interface CursorAutocompleteEntry {
  name: string;
  description: string;
}

export interface CursorAutocompleteRun {
  /** Index of the popup's first row — first entry/footer under the blank chrome. */
  start: number;
  /** Index of the `→ …` prompt line the popup hangs off. */
  promptLine: number;
  entries: CursorAutocompleteEntry[];
}

// --- Slash-command popup (`/c`, `/clear`, …) --------------------------------

// Selected entry: three spaces, arrow, space, name, gap, description. Name column starts at 5.
const SELECTED_ENTRY_ROW = /^ {3}→ (\/\S.*?)( {2,})(\S.*)$/;
const SELECTED_BARE_ROW = /^ {3}→ (\/\S.*?)\s*$/;

// Unselected entry: five spaces, name, gap, description.
const ENTRY_ROW = /^ {5}(\/\S.*?)( {2,})(\S.*)$/;
const BARE_ENTRY_ROW = /^ {5}(\/\S.*?)\s*$/;

// Overflow footer when the list is taller than the viewport (`↓ more below` / `↑ more above`).
const FOOTER_ROW = /^ {5}[↓↑] /;

// Wrapped-description continuation: whitespace then text; checked against the run's description column.
const CONTINUATION_ROW = /^( {4,})(\S.*)$/;

// --- `/model` argument popup ---------------------------------------------------

// Header row: ` Models matching "partial" … Max mode: OFF` (leading space; filter text quoted).
const MODEL_HEADER_ROW = /^ Models matching "/;

// Selected model: one space, arrow, two spaces, name, gap, description (`→  Composer 2.5 …`).
const MODEL_SELECTED_ROW = /^ →  (\S.*?)( {2,})(\S.*)$/;
const MODEL_SELECTED_BARE_ROW = /^ →  (\S.*?)\s*$/;

// Unselected model: four spaces, name, gap, description.
const MODEL_ENTRY_ROW = /^ {4}(\S.*?)( {2,})(\S.*)$/;
const MODEL_BARE_ENTRY_ROW = /^ {4}(\S.*?)\s*$/;

// Pagination (` 1-10 of 17`) and help footer under the list.
const MODEL_PAGINATION_ROW = /^ \d+-\d+ of \d+$/;
const MODEL_HELP_FOOTER_ROW = /^ Edit prompt to filter • Enter to select • Tab to edit$/;

const MAX_AUTOCOMPLETE_LINES = 60;

function isSlashPopupRow(t: string): boolean {
  return (
    SELECTED_ENTRY_ROW.test(t) ||
    SELECTED_BARE_ROW.test(t) ||
    ENTRY_ROW.test(t) ||
    BARE_ENTRY_ROW.test(t) ||
    FOOTER_ROW.test(t) ||
    CONTINUATION_ROW.test(t)
  );
}

function isModelPopupRow(t: string): boolean {
  return (
    MODEL_HEADER_ROW.test(t) ||
    MODEL_SELECTED_ROW.test(t) ||
    MODEL_SELECTED_BARE_ROW.test(t) ||
    MODEL_ENTRY_ROW.test(t) ||
    MODEL_BARE_ENTRY_ROW.test(t) ||
    MODEL_PAGINATION_ROW.test(t) ||
    MODEL_HELP_FOOTER_ROW.test(t) ||
    CONTINUATION_ROW.test(t)
  );
}

/**
 * Find an autocomplete popup at the tail of `texts` (`end` exclusive — `end - 1` is the last
 * non-blank row), or null.
 */
export function findAutocompleteRun(texts: string[], end: number): CursorAutocompleteRun | null {
  return findSlashAutocompleteRun(texts, end) ?? findModelAutocompleteRun(texts, end);
}

function findSlashAutocompleteRun(texts: string[], end: number): CursorAutocompleteRun | null {
  let i = end - 1;
  let rows = 0;
  while (i >= 0 && rows < MAX_AUTOCOMPLETE_LINES) {
    const t = texts[i]!;
    if (isBlank(t)) {
      i--;
      continue;
    }
    if (!isSlashPopupRow(t)) break;
    rows++;
    i--;
  }
  if (rows === 0 || i < 0) return null;

  const start = i + 1;
  while (i >= 0 && isBlank(texts[i]!)) i--;
  if (i < 0) return null;

  const promptLine = i;
  const draft = promptBody(texts[promptLine]!);
  if (draft === null || !draft.trim().startsWith("/")) return null;

  const entries = readSlashEntries(texts, start, end);
  return entries === null ? null : { start, promptLine, entries };
}

function findModelAutocompleteRun(texts: string[], end: number): CursorAutocompleteRun | null {
  let i = end - 1;
  let rows = 0;
  let sawHeader = false;
  while (i >= 0 && rows < MAX_AUTOCOMPLETE_LINES) {
    const t = texts[i]!;
    if (isBlank(t)) {
      i--;
      continue;
    }
    if (!isModelPopupRow(t)) break;
    if (MODEL_HEADER_ROW.test(t)) sawHeader = true;
    rows++;
    i--;
  }
  if (rows === 0 || i < 0 || !sawHeader) return null;

  const start = i + 1;
  while (i >= 0 && isBlank(texts[i]!)) i--;
  if (i < 0) return null;

  const promptLine = i;
  const draft = promptBody(texts[promptLine]!);
  if (draft === null || !draft.trim().startsWith("/model")) return null;

  const entries = readModelEntries(texts, start, end);
  return entries === null ? null : { start, promptLine, entries };
}

function readSlashEntries(texts: string[], start: number, end: number): CursorAutocompleteEntry[] | null {
  const entries: CursorAutocompleteEntry[] = [];
  let column = -1;
  for (let j = start; j < end; j++) {
    const t = texts[j]!;
    if (isBlank(t)) continue;
    if (FOOTER_ROW.test(t)) continue;

    const selected = SELECTED_ENTRY_ROW.exec(t);
    if (selected !== null) {
      const at = 5 + selected[1]!.length + selected[2]!.length;
      if (column < 0) column = at;
      else if (at !== column) return null;
      entries.push({ name: selected[1]!, description: selected[3]!.trimEnd() });
      continue;
    }
    const selectedBare = SELECTED_BARE_ROW.exec(t);
    if (selectedBare !== null) {
      entries.push({ name: selectedBare[1]!, description: "" });
      continue;
    }
    const entry = ENTRY_ROW.exec(t);
    if (entry !== null) {
      const at = 5 + entry[1]!.length + entry[2]!.length;
      if (column < 0) column = at;
      else if (at !== column) return null;
      entries.push({ name: entry[1]!, description: entry[3]!.trimEnd() });
      continue;
    }
    const bare = BARE_ENTRY_ROW.exec(t);
    if (bare !== null) {
      entries.push({ name: bare[1]!, description: "" });
      continue;
    }
    const cont = CONTINUATION_ROW.exec(t);
    if (cont === null) return null;
    const last = entries.at(-1);
    if (last === undefined || cont[1]!.length !== column) return null;
    last.description =
      last.description === "" ? cont[2]!.trimEnd() : `${last.description} ${cont[2]!.trimEnd()}`;
  }
  return entries.length === 0 ? null : entries;
}

function readModelEntries(texts: string[], start: number, end: number): CursorAutocompleteEntry[] | null {
  const entries: CursorAutocompleteEntry[] = [];
  let column = -1;
  for (let j = start; j < end; j++) {
    const t = texts[j]!;
    if (isBlank(t)) continue;
    if (
      MODEL_HEADER_ROW.test(t) ||
      MODEL_PAGINATION_ROW.test(t) ||
      MODEL_HELP_FOOTER_ROW.test(t)
    ) {
      continue;
    }

    const selected = MODEL_SELECTED_ROW.exec(t);
    if (selected !== null) {
      const at = 4 + selected[1]!.length + selected[2]!.length;
      if (column < 0) column = at;
      else if (at !== column) return null;
      entries.push({ name: selected[1]!, description: selected[3]!.trimEnd() });
      continue;
    }
    const selectedBare = MODEL_SELECTED_BARE_ROW.exec(t);
    if (selectedBare !== null) {
      entries.push({ name: selectedBare[1]!, description: "" });
      continue;
    }
    const entry = MODEL_ENTRY_ROW.exec(t);
    if (entry !== null) {
      const at = 4 + entry[1]!.length + entry[2]!.length;
      if (column < 0) column = at;
      else if (at !== column) return null;
      entries.push({ name: entry[1]!, description: entry[3]!.trimEnd() });
      continue;
    }
    const bare = MODEL_BARE_ENTRY_ROW.exec(t);
    if (bare !== null) {
      entries.push({ name: bare[1]!, description: "" });
      continue;
    }
    const cont = CONTINUATION_ROW.exec(t);
    if (cont === null) return null;
    const last = entries.at(-1);
    if (last === undefined || cont[1]!.length !== column) return null;
    last.description =
      last.description === "" ? cont[2]!.trimEnd() : `${last.description} ${cont[2]!.trimEnd()}`;
  }
  return entries.length === 0 ? null : entries;
}

export { lineText };
