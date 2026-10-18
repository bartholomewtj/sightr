// The prompt-binding matcher: the ONE function the bridge 409s on (bridge/pane-write-routes.ts) and
// the one the web conformance suite tests every adapter's dialog regions against (spec 06). Pure, so
// both sides import it; the only dependency is the shared tail-window constant.

import { PROMPT_TAIL_LINES } from "./limits.ts";

/**
 * Normalize a rendered prompt region for comparison across terminal redraws.
 *
 * A terminal redraw can append trailing padding or change blank-line layout without changing the
 * question, so trailing whitespace and blank lines are ignored. Leading indentation and internal
 * alignment must survive because they can be semantic content in a displayed diff or command.
 */
const SGR_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*m/g;
/**
 * A tool call's status bullet at the start of a line. Claude blinks it (`●` / blank) while the call
 * waits on a permission dialog, and that line sits inside the dialog's bound tail (live 18 Oct 2026,
 * 2.1.302, a `Read file` prompt): two reads a second apart differed only there, so the request was
 * re-created every poll and an answer's binding check missed half the time. It is read as a blank.
 */
const BLINKING_BULLET = /^(\s*)[●⏺](?= )/;

export function normalizePromptRegion(text: string): string[] {
  return text
    .replace(SGR_SEQUENCE, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(BLINKING_BULLET, "$1 ").replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
}

// The shared limit is the non-blank tail window accepted by this matcher; see shared/limits.ts.
export const DEFAULT_PROMPT_TAIL_LINES = PROMPT_TAIL_LINES;

export type PromptBindingResult =
  | { ok: true }
  | { ok: false; reason: "empty" | "not_found" | "not_in_tail" };

export function verifyExpectedPrompt(
  freshText: string,
  expected: string,
  tailLines = DEFAULT_PROMPT_TAIL_LINES,
): PromptBindingResult {
  const freshLines = normalizePromptRegion(freshText);
  const expectedLines = normalizePromptRegion(expected);
  if (expectedLines.length === 0) return { ok: false, reason: "empty" };

  let lastMatch = -1;
  candidate: for (let start = 0; start <= freshLines.length - expectedLines.length; start++) {
    for (let offset = 0; offset < expectedLines.length; offset++) {
      if (freshLines[start + offset] !== expectedLines[offset]) continue candidate;
    }
    lastMatch = start;
  }
  if (lastMatch === -1) return { ok: false, reason: "not_found" };

  const boundedTailLines = Math.max(0, Math.floor(tailLines));
  const tailStart = Math.max(0, freshLines.length - boundedTailLines);
  const matchEnd = lastMatch + expectedLines.length - 1;
  if (matchEnd < tailStart) return { ok: false, reason: "not_in_tail" };
  return { ok: true };
}
