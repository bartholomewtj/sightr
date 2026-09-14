// Cursor CLI's live slash-autocomplete popup — the run of command rows the CLI paints under the bare
// `→ /partial` prompt while the draft is a partial slash command. Same failure shape
// `claude/autocomplete.ts` exists for, adapted to Cursor's chrome.
//
// Unpeeled, `locateComposer` (chrome.ts) never sees the prompt row: its walk only admits a short run
// of Auto/cwd STATUS rows under the prompt (`isStatusRow`, MAX_STATUS_ROWS), and a popup row matches
// neither that nor a blank line, so the walk stops on the popup's own last row and `promptBody` finds
// no `→ ` there. `composerReady` / `extractInputDraft` both read false while the typed text is visibly
// sitting in a live `→ …` row — phone sends then report "Message didn't reach the input box — a dialog
// may be waiting" (actions.ts) even though nothing is wrong.
//
// Live shape (captured 2026-09-13 on Cursor Agent via `herdr pane read`, panes
// `cursor--autocomplete-slash*.txt`):
//
//     → /c                              ← prompt (slash draft)
//                                       ← blank composer-chrome rows (often 2)
//        → /ca       Drive headed…      ← SELECTED entry: 3 spaces + "→ " + name
//          /clear    Start a new…       ← unselected: 5 spaces + name (name column aligns at 5)
//          …
//          ↓ more below                 ← optional scroll footer when the list overflows
//
// Selection is NOT SGR-only (unlike Claude): Cursor paints a `→ ` glyph over columns 3–4 of the
// selected row. Bracketed subcommand hints (`/bedrock [subcommand] […]`) sit in the name column, so
// the name is read non-greedily up to the first 2+-space gap. Matched by SHAPE, not colour.

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

// Selected entry: three spaces, arrow, space, name, gap, description. Name column starts at 5 —
// the same column unselected rows use — because `→ ` occupies columns 3–4.
const SELECTED_ENTRY_ROW = /^ {3}→ (\/\S.*?)( {2,})(\S.*)$/;
const SELECTED_BARE_ROW = /^ {3}→ (\/\S.*?)\s*$/;

// Unselected entry: five spaces, name, gap, description.
const ENTRY_ROW = /^ {5}(\/\S.*?)( {2,})(\S.*)$/;
const BARE_ENTRY_ROW = /^ {5}(\/\S.*?)\s*$/;

// Overflow footer when the list is taller than the viewport (`↓ more below` / `↑ more above`).
const FOOTER_ROW = /^ {5}[↓↑] /;

// Wrapped-description continuation: whitespace then text; checked against the run's description column.
const CONTINUATION_ROW = /^( {4,})(\S.*)$/;

// Generous on purpose, exactly as Claude's cap is: every row still has to match one of the shapes
// above AND land on the run's own description column, so length alone buys nothing.
const MAX_AUTOCOMPLETE_LINES = 60;

function isPopupRow(t: string): boolean {
  return (
    SELECTED_ENTRY_ROW.test(t) ||
    SELECTED_BARE_ROW.test(t) ||
    ENTRY_ROW.test(t) ||
    BARE_ENTRY_ROW.test(t) ||
    FOOTER_ROW.test(t) ||
    CONTINUATION_ROW.test(t)
  );
}

/**
 * Find the popup at the tail of `texts` (`end` exclusive — `end - 1` is the last non-blank row), or
 * null. Conditions:
 *   1. the run reaches the last non-blank line — nothing (no status row) follows a live popup;
 *   2. after skipping the blank composer-chrome rows above the run, the row above is a `→ …` prompt;
 *   3. that prompt's draft starts with "/" — the only state Cursor paints this popup for;
 *   4. every non-footer row in the run is an entry/continuation landing on the description column
 *      the entry rows themselves fix.
 */
export function findAutocompleteRun(texts: string[], end: number): CursorAutocompleteRun | null {
  let i = end - 1;
  let rows = 0;
  while (i >= 0 && rows < MAX_AUTOCOMPLETE_LINES) {
    const t = texts[i]!;
    if (isBlank(t)) break;
    if (!isPopupRow(t)) break;
    rows++;
    i--;
  }
  if (rows === 0 || i < 0) return null;

  const start = i + 1;

  // Cursor leaves blank composer-chrome rows between the prompt and the popup — skip them to reach
  // the `→ …` line. Claude's popup hangs directly under a box border; Cursor has no border.
  while (i >= 0 && isBlank(texts[i]!)) i--;
  if (i < 0) return null;

  const promptLine = i;
  const draft = promptBody(texts[promptLine]!);
  if (draft === null || !draft.trim().startsWith("/")) return null;

  const entries = readEntries(texts, start, end);
  return entries === null ? null : { start, promptLine, entries };
}

function readEntries(texts: string[], start: number, end: number): CursorAutocompleteEntry[] | null {
  const entries: CursorAutocompleteEntry[] = [];
  let column = -1; // description column, fixed by the first entry row that carries one
  for (let j = start; j < end; j++) {
    const t = texts[j]!;
    if (FOOTER_ROW.test(t)) continue;

    const selected = SELECTED_ENTRY_ROW.exec(t);
    if (selected !== null) {
      // name starts at column 5 (`   → ` is 5 cells)
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

export { lineText };
