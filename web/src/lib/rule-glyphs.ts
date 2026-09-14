// Shared Unicode rule-glyph classes. Claude's grammar retains its established broad box-drawing
// contract. THIS FILE IS THE ALPHABET, not a predicate: `markers.ts` (isBoxBorder /
// isInputBoxTopBorder) is the only place that asks "is this Claude's input box?" — U+2500 only,
// floored in display cells. Its false positive types a message into a screen that is not the
// input box. Share the alphabet here; never share a predicate or a threshold.

/** All box-drawing glyphs accepted by the existing Claude horizontal-rule grammar. */
export const BOX_DRAWING_RULE_GLYPH_CLASS = "─-╿";
/** Block eighths used by terminal separators. */
const BLOCK_EIGHTH_RULE_GLYPH_CLASS = "▁-▔";
/** Figure, en, em, and horizontal-bar dashes. ASCII hyphen remains deliberately excluded. */
export const UNICODE_DASH_RULE_GLYPH_CLASS = "‒-―";

/** The established Claude horizontal-rule contract. */
export const CLAUDE_RULE_GLYPH_CLASS =
  BOX_DRAWING_RULE_GLYPH_CLASS + BLOCK_EIGHTH_RULE_GLYPH_CLASS + UNICODE_DASH_RULE_GLYPH_CLASS;

