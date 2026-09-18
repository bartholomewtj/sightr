import { rstrip } from "../scan";
// Grok's grammar stays here: renderer-specific predicates must not be shared. The grammar-free
// row and region scaffolding lives in harness/scan.ts and must not be copied into this adapter. Grok's box is rounded but the STATUS lives in the BOTTOM border, the
// draft lives on a `│ ❯ … │` or `│ > … │` inner row, and a blank + key-hint row sit UNDER the box. They operate
// on the *parsed* line text (segment text joined), never the raw ANSI bytes: SGR codes sit
// *between* glyphs, so a regex over the raw buffer would miss (Grok paints the `╰─` fill and the
// status inside it as separate styled segments — probed on `pane.read format:ansi`, 2026-08-21).
// Pure functions, no I/O, no React.

import { isBlank, lineText } from "../../blocks";

// `lineText` / `isBlank` are properties of a StyledLine, not of any grammar, so they live in the
// neutral core (lib/blocks.ts). Re-exported here so the Grok grammars keep their single import site
// — the same arrangement claude/markers.ts uses, for the same reason.
export { isBlank, lineText };

/**
 * Drop TRAILING whitespace only. Every one of Grok's box rows is padded out to the terminal's full
 * column count, so the closing glyph of a border is followed by nothing on a real capture but by a
 * run of spaces in the buffer — an anchored `…$` regex would never match without this. Leading
 * whitespace is deliberately NOT dropped: Grok indents the box by two columns, and that indent is
 * not load-bearing beyond "optional spaces before the corner".
 *
 * The pad is spaces on the ANSI grid Sightr actually parses. Herdr's *text* snapshot sometimes
 * draws a `█` scrollbar instead; that glyph never reaches this layer.
 */

// `[\s\S]`, never `.`, in the row predicates that capture interior text. A dot is not "any glyph":
// JS excludes `\n`, `\r`, **U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR** from it. The
// first two can never reach here (splitLines cut on them), but the separators can: `rstrip` only
// takes them off the END of a row, so one anywhere else in a model display-name or a typed draft
// survives into `lineText` and silently declines the row. That fails in the worst direction:
// locateComposer returns null on every frame, the box stays duplicated, and `composerReady`
// refuses every reply while no dialog exists.

// Top border: rounded corners with nothing but a rule between them. Grok does NOT write the
// statusline into this row. Tight ON PURPOSE — a `╭── title ──╮` is some other widget.
// Loose on indent: the box sits two columns in. Never decisive alone; locateComposer only checks
// it after the bottom border and the inner-row walk have pinned the rest of the shape.
const COMPOSER_TOP = /^\s*╭─+╮$/;

/** True when the line could be the composer box's top border. Never decisive alone — see above. */
export function isComposerTop(text: string): boolean {
  return COMPOSER_TOP.test(rstrip(text));
}

// Bottom border: rule fill, then an opaque status run, then ` ─╯`. The status is whatever Grok
// painted — display name, optional `(effort)`, optional ` · mode` — and this file must never match
// those tokens. User bubbles close with square `└…┘` and no status run, which is why the capture
// group is the discriminator.
const COMPOSER_BOTTOM = /^\s*╰─+\s+([\s\S]+?)\s+─╯$/;

/**
 * Where the status run sits inside a bottom-border row, or null when the line is not that border.
 *
 * Indices are into `rstrip(text)` — the same string `locateComposer` classifies. extractStatusLines
 * uses the span to slice the original SGR segments rather than restyle the words as a new run.
 */
export function composerStatusSpan(text: string): { start: number; end: number; text: string } | null {
  const t = rstrip(text);
  const m = COMPOSER_BOTTOM.exec(t);
  if (m === null) return null;
  const body = m[1]!;
  if (body.trim() === "") return null;
  const prefix = /^\s*╰─+\s+/.exec(t);
  if (prefix === null) return null;
  const start = prefix[0].length;
  return { start, end: start + body.length, text: body };
}

/** Status text painted into the composer's bottom border, or null when the line is not that border. */
export function composerStatus(text: string): string | null {
  return composerStatusSpan(text)?.text ?? null;
}

// Inner box row, prompt or continuation. Grok pads every inner row to the box width.
const COMPOSER_INNER = /^\s*│ ([\s\S]*)│$/;
// Prompt glyph: 2026-08-21 captures paint `❯`; live Grok 4.6 (2026-08-30, pane w56:p9) paints ASCII `>`.
const COMPOSER_PROMPT = /^\s*│ (?:❯|>)([\s\S]*)│$/;

/** Inner-row body (UNTRIMMED), or null when the line is not a `│ … │` box row. */
export function composerInnerText(text: string): string | null {
  const m = COMPOSER_INNER.exec(rstrip(text));
  return m === null ? null : m[1]!;
}

/**
 * Draft fragment on the prompt row (UNTRIMMED, including the space Grok paints after the glyph
 * when the box is empty). Null when the line is not that row. Glyph is `❯` or ASCII `>`.
 */
export function composerPromptText(text: string): string | null {
  const m = COMPOSER_PROMPT.exec(rstrip(text));
  return m === null ? null : m[1]!;
}

// A row that opens a box after optional indent. Used to refuse a composer that has another widget
// UNDER it. The whole Box Drawing block: this predicate's job is to REJECT, so being generous is
// fail-closed (a null composer, never a keystroke).
const BOX_ROW = /^\s*[─-╿]/;

/** True when this row is a box being drawn (rounded or square) after optional indent. */
export function opensBox(text: string): boolean {
  return BOX_ROW.test(rstrip(text));
}

// Grok's shortcut bar: `Shift+Tab:mode  │  Ctrl+.:shortcuts` idle (live 2026-08-30 is
// `Ctrl+x:shortcuts`), and the working/plan variants (`Ctrl+e:expand thinking`,
// `Space:prompt`, `a:approve`, `Tab:plan`, …). A ghost completion adds
// `Tab/→:accept suggestion` as the first segment (phone screenshot 2026-08-30, pane w56:p7);
// without that token locateComposer treated a writable box as a torn frame.
//
// Once the draft is non-empty, Grok inserts the newline chord next to `Enter:send` (or
// `Enter:queue` while a turn is running): `Shift+Enter/Alt+Enter:newline`, or `Alt+Enter`
// alone on SSH/tmux. Phone screenshot 2026-09-18: the empty-box bar classified, typing
// landed, then this segment appeared and locateComposer returned null — "Message didn't
// reach the input box" with the text sitting in a live composer. Matching only
// `Shift+Enter` leaves `/Alt+Enter:newline` and refuses the row.
//
// locateComposer may only treat those as hints. Arbitrary `word:word` transcript under the
// box is a torn/stale frame, not a hint run — treating it as a hint kept the composer
// writable after the dialog had replaced the bar. A bare `[stable]` chip was originally
// refused on the same reasoning, but a live capture proved it real chrome, not a torn frame
// — see isStatusChipRow below.
//
// Slash-alternates (`Tab/→`, `Shift+Enter/Alt+Enter`) are consumed as one token so a prefix
// cannot win. `Enter` / `Tab` beat a single letter so `Enter:send` is not read as `E`.
const HINT_KEY = "(?:Tab|Space|Esc|Enter|Up|Down|[A-Za-z.→])";
const HINT_MOD = "(?:Shift|Ctrl|Alt)";
const HINT_TOKEN = `(?:${HINT_MOD}\\+)?${HINT_KEY}(?:\\/(?:${HINT_MOD}\\+)?${HINT_KEY})*`;
const HINT_SEGMENT = new RegExp(`^${HINT_TOKEN}:\\S`);

/**
 * True when the row is Grok's key-hint bar. Used to refuse a composer whose "hint run" is
 * actually later output — the fail-closed half of locating.
 */
export function isComposerHint(text: string): boolean {
  const t = rstrip(text);
  if (t === "") return false;
  const parts = t.split(/\s+│\s+/);
  return parts.length > 0 && parts.every((p) => HINT_SEGMENT.test(p.trim()));
}

// On the STARTUP screen the row under the composer holds the channel chip where an active
// session paints the key-hint bar. Two live shapes:
//   `[stable]`                         grok--startup.txt          2026-08-22, Grok Build 1.0.5
//   `Grok Build  <semver> [stable]`    grok--startup-build-chip.txt 2026-08-31, Grok Build 1.0.13
// Refusing that row kept composerReady false on every fresh pane, so the FIRST phone message
// of a session was refused. Only captured chrome qualifies: a looser bracket-run would bless
// torn transcript ending in a tag (`[waiting]`, `[ERROR]`) and reopen the hazard the refusal
// guards. Uncaptured channels (`[preview]`) fail closed.
const CHIP_ROW = /^\[stable\]$/;
const BUILD_CHIP_ROW = /^Grok Build\s+\d+\.\d+\.\d+\s+\[stable\]$/;

/** True when the row is the startup screen's channel chip (bare or Grok Build + version). */
export function isStatusChipRow(text: string): boolean {
  const t = rstrip(text).trimStart();
  return CHIP_ROW.test(t) || BUILD_CHIP_ROW.test(t);
}

/** Index of the last non-blank row in `texts`, or -1 when the buffer is all blank. */

// The gutter card shared by the permission and ask dialogs. Both paint the same option row
// (`<gutter> <digit> (●|○) <body>`) and the same geometry: a contiguous run of gutter rows,
// blank row(s), then the key-hint footer as the last non-blank row. Ask cards use either gutter;
// permissions have their own predicate because the live card also paints the new bullet mark.
export const GUTTER_OPTION = /^\s*┃\s+([1-9])\s+\(([●○])\)\s+(.+?)\s*$/;
export const GUTTER_OPTION_ANY = /^\s*[┃│]\s+([1-9])\s+\(([●○])\)\s+(.+?)\s*$/;
export const GUTTER_OPTION_PERMISSION = /^\s*[┃│]\s+([1-9])\s+\(([●○•])\)\s+(.+?)\s*$/;

type GutterKind = "heavy" | "any" | "permission";

function isCardRow(text: string, kind: GutterKind): boolean {
  return kind === "heavy" ? text.includes("┃") : text.includes("┃") || /^\s*│/.test(text);
}

// Rows allowed between the card's bottom gutter row and its footer: blanks only, and few. Every
// 2026-08-21 capture shows exactly one; the slack covers a torn repaint. Anything non-blank in
// the gap means the footer belongs to something else — refuse rather than pair the footer with
// a card an unbounded distance above it.
const MAX_FOOTER_GAP = 3;

/**
 * The contiguous `┃` run whose bottom sits just above the footer row at `footer`, or null when
 * the gap holds anything but a few blank rows. `start`..`end` are inclusive indices into
 * `texts`; every row in the range contains the `┃` gutter.
 */
export function gutterCardRange(
  texts: string[],
  footer: number,
  kind: GutterKind = "heavy",
): { start: number; end: number } | null {
  let end = footer - 1;
  let gap = 0;
  while (end >= 0 && isBlank(texts[end]!)) {
    end--;
    if (++gap > MAX_FOOTER_GAP) return null;
  }
  if (end < 0 || !isCardRow(texts[end]!, kind)) return null;
  let start = end;
  while (start > 0 && isCardRow(texts[start - 1]!, kind)) start--;
  return { start, end };
}

/** Join rstripped line text over `[from, to)` — the dialog signature the race guard compares. */
