// Semantic Block AST — the intermediate representation between the ANSI parse and the React
// renderer. `raw` mirrors terminal output verbatim; every other kind lifts a dialog into a typed
// payload the renderer draws as buttons. Those payloads are harness-NEUTRAL contracts, each in its
// own harness/*-model.ts (re-exported below): what ANY adapter promises when it emits that kind, so
// the renderers and the race guard are written against the model, never against a harness's
// internals. The discriminated union is shaped so further grammars (tool calls, …) are added as new
// `kind`s without disturbing these.
//
// The pipeline is: parseLines(text) → StyledLine[] →
// buildBlocks(lines, ctx) → Block[]. splitLines (and the pure helpers below) live here; the
// block-BUILDING step is the harness DISPATCHER (harness/index) routing to a per-agent adapter, so
// this core module has NO dependency on the agent grammars — the edge is one-way, which is what lets
// an adapter import this AST without forming a cycle. These functions are PURE (no React) and,
// together with the parser, run once per unique text (memoised by the renderer), so they're off the
// hot polling path. The Claude grammars themselves (prompt-select detection, chrome stripping) live
// in harness/claude; which agents get them is decided by the adapter registry (harness/registry).
//
// Invariant (relied on by find-in-output): joining every RAW block's line text with "\n" reproduces
// the visible mirror text character-for-character. The presentation pass (`presentBlocks`) strips
// trailing padded spaces from raw blocks and renders them; find's haystack and link offsets are
// built from those same presented lines, so find coordinate space stays character-coherent with
// what is drawn. `splitLines` preserves the byte-exact stream for the reply guard, statusline
// extractors, and dialog grammars.

import { parseAnsi, type AnsiSegment } from "./ansi";
import type { PromptModel } from "./harness/prompt-model";
import type { WizardModel } from "./harness/wizard-model";
import type { PreviewSelectModel } from "./harness/preview-model";
import type { MultiSelectModel } from "./harness/multi-select-model";
import type { MenuModel } from "./harness/menu-model";
import type { AutocompleteModel } from "./harness/autocomplete-model";

// Re-export every dialog model so consumers (the block components, the race guards) have one import
// site for the AST's typed payloads. All five are harness-NEUTRAL contracts (harness/*-model.ts):
// the payload an adapter promises when it emits that block kind, not a Claude internal — the
// dependency points at the shared modules, never at claude/. These are TYPE-ONLY re-exports (erased
// under verbatimModuleSyntax), so they add no runtime edge into harness/ either — the value
// dependency stays one-way (harness → blocks).
export type { PromptModel, PromptOption, PromptFamily, PromptFeedbackPurpose } from "./harness/prompt-model";
export type { WizardModel, WizardOption, WizardStepChip, WizardAnswer } from "./harness/wizard-model";
export type { PreviewSelectModel, PreviewOption, PreviewNote } from "./harness/preview-model";
export type {
  MultiSelectModel,
  MultiSelectOption,
  MultiSelectEscape,
  MultiPointer,
} from "./harness/multi-select-model";
export type { MenuModel, MenuAction, MenuNav, MenuLeftRight } from "./harness/menu-model";
export type { AutocompleteModel, AutocompleteEntry } from "./harness/autocomplete-model";

/** One visual line: the styled segments that make it up, with the line-terminating "\n" removed. */
export interface StyledLine {
  segments: AnsiSegment[];
}

/** A run of raw terminal output. Renders as verbatim styled text (the T1 mirror). */
export interface RawBlock {
  kind: "raw";
  lines: StyledLine[];
}

/**
 * A single-choice Claude dialog lifted out of the raw mirror and rendered as native buttons. It
 * REPLACES the menu region ([firstOption … tail]) in place; the question and any preamble stay in
 * the raw block above it. `lines` is the raw region it replaced — retained for provenance only; it
 * is NOT rendered as text and NOT part of the find haystack (find runs over raw blocks only).
 */
export interface PromptSelectBlock {
  kind: "prompt-select";
  prompt: PromptModel;
  lines: StyledLine[];
}

/**
 * A multi-question AskUserQuestion wizard (the stepper dialog) lifted out of the raw mirror and
 * rendered as a native step-by-step form. Like `prompt-select` it REPLACES its region
 * ([stepper header … tail]) in place; `lines` is provenance only — not rendered, not searchable.
 */
export interface WizardBlock {
  kind: "wizard";
  wizard: WizardModel;
  lines: StyledLine[];
}

/**
 * A preview-variant AskUserQuestion (options + preview pane + the per-question note affordance;
 * grammar/NOTES_NOTES.md) lifted out of the raw mirror. Like the other dialog blocks it REPLACES
 * its region in place; `lines` is provenance only — not rendered, not searchable.
 */
export interface PreviewSelectBlock {
  kind: "preview-select";
  preview: PreviewSelectModel;
  lines: StyledLine[];
}

/**
 * A multi-select AskUserQuestion (the checkbox form + its review screen) lifted out of the raw
 * mirror and rendered as native checkboxes / a confirm screen. Like the other dialog blocks it
 * REPLACES its region in place; `lines` is provenance only — not rendered, not searchable.
 */
export interface MultiSelectBlock {
  kind: "multi-select";
  multi: MultiSelectModel;
  lines: StyledLine[];
}

/**
 * A GENERIC modal menu (the `/model` picker and its kin) claimed by the last-resort footer grammar —
 * a screen no specific dialog grammar owns, driven by the keys it printed in its own footer. Unlike
 * the dialog blocks above, its region text IS rendered: the grammar understands the footer, not the
 * body, so the body has to stay readable for the buttons under it to mean anything. `lines` is that
 * region — still not part of the find haystack (find runs over raw blocks only).
 */
export interface MenuBlock {
  kind: "menu";
  menu: MenuModel;
  lines: StyledLine[];
}

/**
 * The agent's own COMPLETION POPUP while the operator types into its input box (Claude's slash-command
 * menu). Unlike every other non-`raw` kind this one is PRESENTATIONAL: it emits no keystrokes and has
 * no row in harness/dialog-contract.ts, because nothing on that screen owns the keyboard — the input
 * box is live underneath it and the composer must stay free to type. `lines` is the popup's own region
 * (provenance; the block renders the parsed entries, not the text) and is not part of the find
 * haystack.
 */
export interface AutocompleteBlock {
  kind: "autocomplete";
  autocomplete: AutocompleteModel;
  lines: StyledLine[];
}

/**
 * A semantic block. A discriminated union on `kind`; new members are added purely additively, so a
 * `switch (block.kind)` in the renderer stays exhaustive.
 */
export type Block =
  | RawBlock
  | PromptSelectBlock
  | WizardBlock
  | PreviewSelectBlock
  | MultiSelectBlock
  | MenuBlock
  | AutocompleteBlock;

/**
 * Split parsed segments into visual lines at "\n" boundaries. The newline characters become the
 * separators *between* lines and are dropped from segment text, so `lines.map(text).join("\n")`
 * reconstructs the original visible string exactly.
 *
 * A segment whose text has no newline is reused as-is (no allocation). A segment carrying newline(s)
 * is sliced into per-line pieces that each keep the original segment's style/flags — so a styled run
 * straddling a line break stays styled on both sides. Empty pieces (adjacent newlines, or a leading/
 * trailing newline) contribute no segment but still open/close a line, preserving blank lines.
 */
/** Parse raw pane text into styled lines. This is the single ANSI parsing entry point. */
export function parseLines(text: string): StyledLine[] {
  return splitLines(parseAnsi(text));
}

export function splitLines(segments: AnsiSegment[]): StyledLine[] {
  const lines: StyledLine[] = [];
  let current: AnsiSegment[] = [];

  for (const seg of segments) {
    const t = seg.text;
    if (t.indexOf("\n") === -1) {
      // Common case (parser flushes at every "\n", so most segments have none): reuse verbatim.
      current.push(seg);
      continue;
    }
    // Segment contains one or more newlines: distribute its text across the lines it spans, cloning
    // the style onto each non-empty piece.
    let start = 0;
    for (;;) {
      const idx = t.indexOf("\n", start);
      const end = idx === -1 ? t.length : idx;
      if (end > start) current.push({ ...seg, text: t.slice(start, end) });
      if (idx === -1) break;
      lines.push(styledLine(current));
      current = [];
      start = idx + 1;
    }
  }

  // The trailing run (after the last "\n", or the whole input if it had none) is the final line —
  // pushed even when empty so a trailing newline yields a terminating blank line.
  lines.push(styledLine(current));
  return lines;
}

function styledLine(segments: AnsiSegment[]): StyledLine {
  return { segments };
}

// -------------------------------------------------------------------------------------------------
// Presentation pass: trailing-padding stripping and Grok canvas cleanup.
//
// This pass runs between `buildBlocks` and the renderer (ansi-output.tsx). `splitLines` stays byte-
// exact so safety-critical consumers (reply guard, statusline extractors, dialog grammars) see exact
// pane bytes. The mirror always pans (no wrap), so this pass does not classify rows.
//
// Grok paints every transcript row to the pane width with a near-black canvas fill (rgb(20,20,20)
// plus a █ scrollbar cell) and a blank vpad row between markdown lines. This pass drops that canvas
// fill (user-prompt / code-block greys stay), strips trailing █, collapses right-aligned timestamp
// pads, and removes coloured all-space vpad rows. Plain unstyled blank lines are kept.

const MIN_TRAILING_PAD = 2;
// Grok's scrollbar thumb. Same alphabet grok/markers.ts rstrip already uses; presentLine has to
// know it too because Raw terminal (the default) skips that adapter.
const FULL_BLOCK = "\u2588";
// Near-black neutral greys Grok uses as the page canvas / scrollbar, not as a highlight. Code
// blocks (rgb(44,44,44)) and user prompts (rgb(64,64,64)) sit above this and keep their fill.
const CANVAS_BG_MAX = 32;
const CANVAS_BG_SPREAD = 8;
const CANVAS_RGB = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/;

function isPadChar(c: string): boolean {
  return c === " " || c === "\t" || c === FULL_BLOCK;
}

function isPresentBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (!isPadChar(text[i]!)) return false;
  }
  return true;
}

function trailingPadCount(text: string): number {
  let n = 0;
  let sawBlock = false;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i]!;
    if (c === FULL_BLOCK) {
      n++;
      sawBlock = true;
    } else if (c === " " || c === "\t") {
      n++;
    } else {
      break;
    }
  }
  if (sawBlock) return n;
  return n >= MIN_TRAILING_PAD ? n : 0;
}

function isCanvasBg(bg: string | undefined): boolean {
  if (!bg) return false;
  const m = CANVAS_RGB.exec(bg);
  if (!m) return false;
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  return Math.max(r, g, b) <= CANVAS_BG_MAX && Math.max(r, g, b) - Math.min(r, g, b) <= CANVAS_BG_SPREAD;
}

function withoutCanvasBg(seg: AnsiSegment): AnsiSegment {
  if (!isCanvasBg(seg.bg)) return seg;
  const style = { ...seg.style };
  delete style.backgroundColor;
  const next: AnsiSegment = { ...seg, style };
  delete next.bg;
  return next;
}

function stripCanvasBg(segments: AnsiSegment[]): AnsiSegment[] {
  let changed = false;
  const out = segments.map((s) => {
    const next = withoutCanvasBg(s);
    if (next !== s) changed = true;
    return next;
  });
  return changed ? out : segments;
}

function hasBackground(line: StyledLine): boolean {
  return line.segments.some((s) => s.bg !== undefined);
}

// Right-align a short token with a long space run. Applied here so Raw terminal still gets it.
// No-op when the adapter already collapsed the gap to two spaces.
const RIGHT_ALIGN_PAD = /^(.*?)\s{8,}(\S.{0,40})$/;

function removeChars(segments: AnsiSegment[], start: number, count: number): AnsiSegment[] {
  if (count <= 0) return segments;
  const out: AnsiSegment[] = [];
  let i = 0;
  const endAt = start + count;
  for (const seg of segments) {
    const end = i + seg.text.length;
    if (end <= start || i >= endAt) {
      out.push(seg);
    } else {
      const left = start > i ? seg.text.slice(0, start - i) : "";
      const right = end > endAt ? seg.text.slice(endAt - i) : "";
      const text = left + right;
      if (text.length > 0) out.push({ ...seg, text });
    }
    i = end;
  }
  return out;
}

function collapseRightAlignedPad(segments: AnsiSegment[]): AnsiSegment[] {
  const text = segments.map((s) => s.text).join("");
  const m = RIGHT_ALIGN_PAD.exec(text);
  if (!m) return segments;
  const leftLen = m[1]!.length;
  const rightLen = m[2]!.length;
  const gapEnd = text.length - rightLen;
  const remove = gapEnd - leftLen - 2;
  if (remove <= 0) return segments;
  return removeChars(segments, leftLen + 2, remove);
}

function stripTrailingSpaces(segments: AnsiSegment[], count: number): AnsiSegment[] {
  let toRemove = count;
  const result: AnsiSegment[] = [];

  let lastKeptIndex = -1;
  let trimmedLastSeg: AnsiSegment | null = null;

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (toRemove === 0) {
      if (lastKeptIndex === -1) lastKeptIndex = i;
      continue;
    }
    if (seg.text.length <= toRemove) {
      toRemove -= seg.text.length;
    } else {
      const newText = seg.text.slice(0, seg.text.length - toRemove);
      trimmedLastSeg = { ...seg, text: newText };
      lastKeptIndex = i - 1;
      toRemove = 0;
    }
  }

  for (let i = 0; i <= lastKeptIndex; i++) {
    result.push(segments[i]!);
  }
  if (trimmedLastSeg) {
    result.push(trimmedLastSeg);
  }
  return result;
}

/**
 * Strip trailing padded spaces / █ and drop Grok's near-black canvas fill.
 * Operates purely on presentation.
 */
function presentLine(line: StyledLine): StyledLine {
  if (line.segments.length === 0) return line;

  const text = lineText(line);
  let newSegments = line.segments;
  if (isPresentBlank(text)) {
    newSegments = [];
  } else {
    const trailing = trailingPadCount(text);
    if (trailing > 0) {
      newSegments = stripTrailingSpaces(line.segments, trailing);
    }
    newSegments = collapseRightAlignedPad(newSegments);
    newSegments = stripCanvasBg(newSegments);
  }

  if (newSegments === line.segments) return line;
  return { segments: newSegments };
}

/**
 * Present a list of StyledLines. Preserves array and line object references when unchanged.
 * Coloured all-space vpad rows (Grok's per-line block padding) are dropped so they do not
 * become empty striped gaps on a phone; a plain unstyled blank line is kept.
 */
function presentLines(lines: StyledLine[]): StyledLine[] {
  let changed = false;
  const out: StyledLine[] = [];
  for (const l of lines) {
    const dropPad = isPresentBlank(lineText(l)) && hasBackground(l);
    const pl = presentLine(l);
    if (pl !== l) changed = true;
    if (dropPad) {
      changed = true;
      continue;
    }
    out.push(pl);
  }
  return changed ? out : lines;
}

/**
 * Present semantic blocks for rendering: presents lines in raw and menu blocks, leaving
 * interactive dialog blocks untouched.
 */
export function presentBlocks(blocks: Block[]): Block[] {
  let changed = false;
  const out = blocks.map((b) => {
    if (b.kind === "raw" || b.kind === "menu") {
      const pl = presentLines(b.lines);
      if (pl !== b.lines) {
        changed = true;
        return { ...b, lines: pl } as Block;
      }
      return b;
    }
    return b;
  });
  return changed ? out : blocks;
}

// The two generic StyledLine probes. They live HERE, in the core AST module that imports nothing
// from harness/, because they are properties of a StyledLine and of no grammar: the renderer
// (components/ansi-output.tsx) and every harness adapter need them, and a second copy in a
// harness-specific module would make a neutral consumer import a harness. harness/claude/markers
// re-exports them so the Claude grammars keep their one import site.

/** The visible text of a line: its segments' text concatenated (the "\n" separator lives between
 *  lines, so a single line's text never contains one). */
export function lineText(line: StyledLine): string {
  return line.segments.map((s) => s.text).join("");
}

/** True when a line is empty or only whitespace. */
export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** Drop a trailing run of blank lines (keeps the raw block above the buttons tight). Exported for the
 *  harness adapters, whose pipelines tighten the raw region above a lifted dialog with it. */
export function trimTrailingBlank(lines: StyledLine[]): StyledLine[] {
  let end = lines.length;
  while (end > 0 && isBlank(lineText(lines[end - 1]!))) end--;
  return end === lines.length ? lines : lines.slice(0, end);
}
