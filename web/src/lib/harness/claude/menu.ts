// The GENERIC menu grammar — the LAST-RESORT detector for a modal screen no specific grammar owns.
//
// Claude Code paints a growing family of full-screen pickers (`/model`, and whatever ships next)
// that are not AskUserQuestion dialogs: they have no numbered-menu recipe, no `Enter to select`
// footer, and — the part that bit us — no input box at the tail. Before this grammar existed, none
// of the specific detectors claimed the `/model` picker, so Sightr showed no buttons, `dialogPresent`
// stayed false, and a composer send typed the user's message straight INTO the picker.
//
// What makes a generic claim safe is that the screen NAMES ITS OWN KEYS: the footer is a
// `·`-separated list of "<key> to <verb>" hints ("Enter to set as default · s to use this session
// only · Esc to cancel"). The whole row must be hints; a statusline with one hint spliced into it is
// not a modal footer. We up-level exactly those hints into buttons, plus the arrow navigation the
// region advertises. We invent nothing.
//
// DIGITS ARE NEVER SYNTHESISED (.adr/0009). Live-probed 2026-08-05: pressing a digit in the `/model`
// picker confirms instantly AND writes the choice to the user's default for new sessions. A digit is
// therefore an unrecoverable, unprompted-for side effect on a screen whose semantics we do not know —
// so this grammar only ever emits keys the screen itself printed, plus the arrows that move a
// highlight.
//
// Pure functions over `StyledLine[]`, tail-anchored exactly like prompt-select.ts: the footer must be
// the LAST non-blank line, so a picker that has scrolled up simply doesn't match.
//
// THIS FILE IS THE REFERENCE IMPLEMENTATION OF THE GENERIC MODAL CONTRACT, not its definition. The
// model (../menu-model.ts) and the harness-agnostic derivation — footer-hint parsing, the key
// whitelist, label capitalisation, the arrow-row grammar and key constants (../menu-hints.ts) — are
// shared, so another adapter implements menus by supplying its OWN conventions only: where its region
// starts (Claude: the nearest rule/border above the footer), what its tail is, and how it knows an
// input box is on screen (Claude: ./chrome). See HARNESS_CONTRIBUTING.md → "Menus (generic modals)".

import type { StyledLine } from "../../blocks";
import { hasInputBox } from "./chrome";
import { classifyFooter, isBlank, isBoxBorder, isHorizontalRule, lineText } from "./markers";
import { regionSignature } from "../scan";
import type { MenuModel, MenuNav } from "../menu-model";
import { MENU_ARROW_ROW, parseKeyHintFooter } from "../menu-hints";

/** The detection result buildBlocks needs: the model plus `startLine`, the index of the region's
 *  opening rule. Everything above it stays raw. */
export interface MenuRegion {
  model: MenuModel;
  startLine: number;
}

// The pointer glyph marking the currently-highlighted row — its presence is what makes Up/Down
// meaningful (without a highlight there is nothing to move).
const POINTER = "❯";

// The footer's segment separator — duplicated here because this is a Claude-specific convention,
// while menu-hints.ts is shared by every adapter using the generic menu derivation.
const FOOTER_SEGMENT_SPLIT = /\s+·\s+/;
const FOOTER_HINT_SHAPE = /^.+?\s+to\s+.+$/i;
// Two or more spaces inside a segment indicate a terminal column gap between unrelated UI zones.
const FOOTER_COLUMN_GAP = /\s{2,}/;

/** True when the footer is a complete, contiguous bar of key-hint segments. */
function isPureKeyHintBar(footer: string): boolean {
  return footer
    .trim()
    .split(FOOTER_SEGMENT_SPLIT)
    .every((segment) => {
      const t = segment.trim();
      return FOOTER_HINT_SHAPE.test(t) && !FOOTER_COLUMN_GAP.test(t);
    });
}

// How far above the footer to look for the region's opening rule. Generous enough for a tall picker,
// bounded so a borderless buffer can't be claimed unboundedly — no rule within the window, no match.
const REGION_SCAN_WINDOW = 30;

/**
 * Detect a generic menu at the tail of `lines`. Returns the model + its start line, or null.
 *
 * Ordered bails, cheapest and most decisive first:
 *   1. the last non-blank line must parse as a key-hint footer;
 *   2. every `·`-separated segment must be a hint, with no interior column gap;
 *   3. `classifyFooter` must NOT claim it — the known dialog families keep their own grammars, which
 *      encode verified keystroke recipes this one cannot reproduce;
 *   4. there must be NO input box at the tail — a normal prompt screen whose statusline happens to
 *      read like hints is not a modal, and claiming it would put fake buttons under a live composer;
 *   5. a full-width rule / box border must sit within REGION_SCAN_WINDOW above the footer, and carry
 *      a non-blank title line under it.
 *
 * Pure; the caller owns pane access.
 */
export function detectMenuRegion(lines: StyledLine[]): MenuRegion | null {
  const texts = lines.map(lineText);

  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;

  const footer = texts[fi]!;
  if (classifyFooter(footer) !== null) return null;
  if (!isPureKeyHintBar(footer)) return null;
  const actions = parseKeyHintFooter(footer);
  if (actions.length === 0) return null;
  if (hasInputBox(lines)) return null;

  // The region's top: the nearest rule/border above the footer. The picker draws one full-width rule
  // across the screen where its modal begins, which is the only structural boundary it offers.
  let top = -1;
  for (let i = fi - 1, seen = 0; i >= 0 && seen < REGION_SCAN_WINDOW; i--, seen++) {
    if (isBoxBorder(texts[i]!) || isHorizontalRule(texts[i]!)) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;

  // Title = the first non-blank line under the rule. A rule with nothing but the footer beneath it
  // is not a menu we can name, so bail rather than render an untitled panel.
  let title = "";
  for (let i = top + 1; i < fi; i++) {
    if (!isBlank(texts[i]!)) {
      title = texts[i]!.trim();
      break;
    }
  }
  if (title === "") return null;

  // Affordances advertised INSIDE the region (never assumed): a highlighted row means Up/Down do
  // something; an "←/→ to adjust" row means Left/Right do, and names what.
  const nav: MenuNav = { upDown: false };
  for (let i = top + 1; i < fi; i++) {
    const t = texts[i]!;
    if (t.includes(POINTER)) nav.upDown = true;
    if (nav.leftRight === undefined) {
      const arrow = MENU_ARROW_ROW.exec(t);
      if (arrow) nav.leftRight = { verb: arrow[2]!.trim(), label: arrow[1]!.trim() };
    }
  }

  const signature = regionSignature(texts, top, fi + 1);
  return {
    model: { title, actions, nav, signature, region: signature },
    startLine: top,
  };
}

/** Detect a generic menu at the tail of `lines`, returning just the model (or null) — the thin
 *  matcher the race guard re-derives with, and the one tests assert on. */
export function detectMenu(lines: StyledLine[]): MenuModel | null {
  return detectMenuRegion(lines)?.model ?? null;
}
