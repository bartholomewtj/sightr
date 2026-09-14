// Cursor CLI command-approval dialog. Live-probed 2026-09-12 on pane wC0:p1 (probe-cursor):
//
//   Run this command?
//   Not in allowlist: echo
//    → Run (once) (y)
//      Add Shell(echo) to allowlist? (tab)
//      Run Everything (shift+tab)
//      Skip & tell the agent what to do instead (esc or n)
//
//   …right-aligned…  ctrl+r to review changed files   ← optional trailing chrome
//
// `y` confirms Run (once) even when the pointer sits on another row. `n` (or Esc) skips.
// Tab / shift+tab are persistent allow / mode-change — never buttons. See PERMISSION_NOTES.md.

import type { StyledLine } from "../../blocks";
import type { PromptModel } from "../prompt-model";
import { lastNonBlankIndex, regionSignature, rstrip } from "../scan";
import { APPROVAL_OPTION, lineText } from "./markers";

export interface PermissionRegion {
  model: PromptModel;
  startLine: number;
}

const QUESTION = /Run this command\?/i;
const RUN_ONCE = /Run \(once\)/i;
const SKIP = /Skip\b/i;
/** Right-aligned footer Cursor paints under the card when the session has dirty files. */
const REVIEW_HINT = /ctrl\+r to review changed files/i;
const MAX_LOOKBACK = 16;

/** Command-approval card at the buffer tail, or null. */
export function detectPermissionRegion(lines: StyledLine[]): PermissionRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const end = lastNonBlankIndex(texts);
  if (end < 0) return null;

  // Options sit at the tail. Skip blank / review-hint chrome under the card.
  const options: { index: number; key: string; label: string }[] = [];
  let i = end;
  while (i >= 0 && options.length < 6) {
    const m = APPROVAL_OPTION.exec(texts[i]!);
    if (m === null) {
      if (options.length > 0 && isIgnorableTail(texts[i]!)) {
        i--;
        continue;
      }
      if (options.length === 0 && isIgnorableTail(texts[i]!)) {
        i--;
        continue;
      }
      break;
    }
    options.unshift({ index: i, key: m[2]!.toLowerCase(), label: m[1]!.trim() });
    i--;
  }
  if (options.length < 2) return null;

  const yes = options.find((o) => o.key === "y" && RUN_ONCE.test(o.label));
  const no = options.find((o) => o.key === "esc or n" && SKIP.test(o.label));
  if (!yes || !no) return null;

  // Every other named key must be a known persistent control — refuse unknowns.
  for (const o of options) {
    if (o === yes || o === no) continue;
    if (o.key !== "tab" && o.key !== "shift+tab") return null;
  }

  // Question must sit above the first option within a bounded lookback.
  const firstOpt = options[0]!.index;
  let question = "";
  let questionAt = firstOpt;
  const from = Math.max(0, firstOpt - MAX_LOOKBACK);
  for (let j = firstOpt - 1; j >= from; j--) {
    if (QUESTION.test(texts[j]!)) {
      question = texts[j]!.trim();
      questionAt = j;
      break;
    }
  }
  if (question === "") return null;

  // Fail closed if ordinary transcript sits between the last option and EOF
  // (blanks + the optional ctrl+r review hint alone are fine).
  const lastOpt = options[options.length - 1]!.index;
  for (let j = lastOpt + 1; j <= end; j++) {
    if (!isIgnorableTail(texts[j]!)) return null;
  }

  const start = Math.min(questionAt, firstOpt);
  const signature = regionSignature(texts, start, end + 1);
  if (signature === "") return null;

  return {
    startLine: firstOpt,
    model: {
      question,
      options: [
        { label: "Run (once)", keys: ["y"] },
        // Face is "Skip"; the rest of the row is how to type a reason after rejecting.
        { label: "Skip", keys: ["n"] },
      ],
      family: "permission",
      coreSignature: question,
      signature,
    },
  };
}

function isBlankish(text: string): boolean {
  return text.trim().length === 0;
}

function isIgnorableTail(text: string): boolean {
  return isBlankish(text) || REVIEW_HINT.test(text);
}
