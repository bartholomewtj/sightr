/**
 * Normalize a rendered prompt region for comparison across terminal redraws.
 *
 * A terminal redraw can append trailing padding or change blank-line layout without changing the
 * question, so trailing whitespace and blank lines are ignored. Leading indentation and internal
 * alignment must survive because they can be semantic content in a displayed diff or command.
 */
const SGR_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*m/g;

export function normalizePromptRegion(text: string): string[] {
  return text
    .replace(SGR_SEQUENCE, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
}

import { PROMPT_TAIL_LINES } from "../shared/limits.ts";

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
