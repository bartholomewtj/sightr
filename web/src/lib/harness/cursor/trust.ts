// Cursor CLI workspace-trust dialog. Live-probed 2026-09-12 on pane wC0:p1:
//
//   ⚠ Workspace Trust Required
//   …
//   Do you trust the contents of this directory?
//     C:\…
//    ▶ [a] Trust this workspace
//      [q] Quit
//   Use arrow keys to navigate, Enter to select, or press the key shown
//
// Letter keys `a` / `q` confirm immediately (also Enter on the highlighted row). See TRUST_NOTES.md.

import type { StyledLine } from "../../blocks";
import type { PromptModel } from "../prompt-model";
import { lastNonBlankIndex, regionSignature, rstrip } from "../scan";
import { lineText } from "./markers";

export interface TrustRegion {
  model: PromptModel;
  startLine: number;
}

const TITLE = /Workspace Trust Required/i;
const QUESTION = /Do you trust the contents of this directory\?/i;
const FOOTER = /Use arrow keys to navigate/i;
/** Box gutter + optional pointer + [a]/[q] label. */
const TRUST_OPTION = /^\s*(?:[│┃]\s*)?(?:▶\s+)?\[([aq])\]\s+(.+?)\s*$/i;
const BOX_EDGE = /^\s*[╭╰│┃─]/;
const MAX_LOOKBACK = 24;
const MAX_BELOW_FOOTER = 4;

/** Workspace-trust card at the buffer tail, or null. */
export function detectTrustRegion(lines: StyledLine[]): TrustRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const end = lastNonBlankIndex(texts);
  if (end < 0) return null;

  // Find the footer near the tail — a bottom box border may sit under it.
  let footer = -1;
  for (let i = end, below = 0; i >= 0 && below <= MAX_BELOW_FOOTER; i--) {
    if (FOOTER.test(texts[i]!)) {
      footer = i;
      break;
    }
    if (!isBlankish(texts[i]!) && !BOX_EDGE.test(texts[i]!)) break;
    below++;
  }
  if (footer < 0) return null;

  const options: { index: number; key: string; label: string }[] = [];
  for (let i = footer - 1; i >= Math.max(0, footer - MAX_LOOKBACK); i--) {
    const m = TRUST_OPTION.exec(texts[i]!);
    if (m === null) {
      if (options.length > 0) {
        if (isBlankish(texts[i]!) || BOX_EDGE.test(texts[i]!)) continue;
        break;
      }
      continue;
    }
    options.unshift({
      index: i,
      key: m[1]!.toLowerCase(),
      label: m[2]!.replace(/\s*[│┃].*$/, "").trim(),
    });
  }
  if (options.length !== 2) return null;
  const trust = options.find((o) => o.key === "a" && /^Trust\b/i.test(o.label));
  const quit = options.find((o) => o.key === "q" && /^Quit$/i.test(o.label));
  if (!trust || !quit) return null;

  const firstOpt = options[0]!.index;
  let question = "";
  let questionAt = firstOpt;
  const from = Math.max(0, firstOpt - MAX_LOOKBACK);
  for (let j = firstOpt - 1; j >= from; j--) {
    if (QUESTION.test(texts[j]!)) {
      question = stripGutter(texts[j]!).replace(/^[⚠\s]+/, "");
      questionAt = j;
      break;
    }
  }
  if (question === "") {
    for (let j = firstOpt - 1; j >= from; j--) {
      if (TITLE.test(texts[j]!)) {
        question = stripGutter(texts[j]!).replace(/^[⚠\s]+/, "");
        questionAt = j;
        break;
      }
    }
  }
  if (question === "") return null;

  const titled = texts.slice(from, footer + 1).some((t) => TITLE.test(t));
  if (!titled) return null;

  const start = Math.min(questionAt, firstOpt);
  const signature = regionSignature(texts, start, end + 1);
  if (signature === "") return null;

  return {
    startLine: firstOpt,
    model: {
      question,
      options: [
        { label: trust.label, keys: ["a"] },
        { label: quit.label, keys: ["q"] },
      ],
      family: "trust",
      coreSignature: question,
      signature,
    },
  };
}

function isBlankish(text: string): boolean {
  return text.trim().length === 0;
}

function stripGutter(text: string): string {
  return text.replace(/^\s*[│┃]\s*/, "").trim();
}
