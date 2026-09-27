// Grok's live prompt line, in one grammar for both sides (spec 08). The web adapter
// (web/src/lib/harness/grok/markers.ts) reads the draft off the boxed composer row; the bridge's
// session claims (bridge/journal/grok.ts) fingerprint the same line to tell sibling panes apart.
// Two grammars drifted: a box-only one on the web, a bare `> …` one in the bridge that never
// matched the boxed row. The jsonl log has its own grammar, which stays in the journal.
//
// Pure, no imports: the bridge loads this at runtime.

/**
 * The composer's prompt row: `│ ❯ … │`, or `│ > … │` from live Grok 4.6 (2026-08-30). The capture
 * is the draft UNTRIMMED, including the space Grok paints after the glyph. Match against a line
 * with its trailing padding stripped.
 */
export const GROK_BOXED_PROMPT = /^\s*│ (?:❯|>)([\s\S]*)│$/;

/** The same line as `pane.read` text can give it at phone width: no box, just the glyph. */
const BARE_PROMPT = /^\s*(?:❯|>)\s+(.+)$/;

/** Grok paints a `3:31 PM` clock at the end of the prompt row. */
const TRAILING_CLOCK = /\s+\d{1,2}:\d{2}(?:\s*[AaPp][Mm])?\s*$/;

/** The prompt body on one line, boxed or bare, trimmed and clock-stripped; null when not one. */
export function grokPromptBody(line: string): string | null {
  const text = line.replace(/\s+$/, "");
  const raw = GROK_BOXED_PROMPT.exec(text)?.[1] ?? BARE_PROMPT.exec(text)?.[1];
  if (raw === undefined) return null;
  const body = raw.replace(TRAILING_CLOCK, "").trim();
  return body === "" ? null : body;
}
