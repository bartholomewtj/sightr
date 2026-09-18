// Partition mirror text into ASCII runs (the mono face's own advance) and locked cells.
//
// A terminal paints a column grid. The mirror is HTML, so a glyph whose advance isn't the face's
// `0` width — box-drawing, ✓, Nerd Font icons, CJK — shifts every column to its right. Worse on
// a phone, where Consolas isn't installed and the fallback face disagrees with those glyphs even
// more. ADR 0008 refuses a terminal emulator; locking the cluster to `Nch` (the `0` of the SAME
// stack) is the HTML equivalent of a cell, still a React text node.

import { displayCells } from "./text-width";

export type MirrorRun =
  | { kind: "text"; text: string }
  | { kind: "cell"; glyph: string; cols: number };

/** Glyphs whose native advance disagrees with the mono `0` on a phone (box-drawing, TUI
 *  marks, Nerd Font PUA, CJK/emoji). Everything else — including `❯` / curly quotes in
 *  agent prose — stays a text run so a 600-line scrollback is not a span per character. */
function shouldLock(glyph: string, cols: number): boolean {
  if (cols >= 2) return true;
  if (cols <= 0) return false;
  const cp = glyph.codePointAt(0);
  if (cp === undefined) return false;
  if (cp >= 0x2500 && cp <= 0x259f) return true; // box drawing + block elements
  if (cp >= 0x25a0 && cp <= 0x25ff) return true; // geometric shapes (● ○ ◐)
  if (cp >= 0x2800 && cp <= 0x28ff) return true; // braille
  if (cp >= 0xe000 && cp <= 0xf8ff) return true; // BMP PUA / Nerd Font
  if (cp >= 0xf0000 && cp <= 0xf1aff) return true;
  if (cp === 0x2713 || cp === 0x2717) return true; // ✓ ✗
  return false;
}

function isAsciiPrintable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 0x09 && (c < 0x20 || c > 0x7e)) return false;
  }
  return true;
}

/** Split `text` into ASCII runs and per-grapheme cells. Empty input yields no runs. */
export function partitionMirrorRuns(text: string): MirrorRun[] {
  if (text.length === 0) return [];
  if (isAsciiPrintable(text)) return [{ kind: "text", text }];

  const runs: MirrorRun[] = [];
  let ascii = "";
  const flushAscii = () => {
    if (!ascii) return;
    runs.push({ kind: "text", text: ascii });
    ascii = "";
  };

  for (const { glyph, cols } of displayCells(text)) {
    if (cols <= 0) {
      if (ascii) {
        ascii += glyph;
      } else {
        const last = runs[runs.length - 1];
        if (last?.kind === "cell") {
          runs[runs.length - 1] = { kind: "cell", glyph: last.glyph + glyph, cols: last.cols };
        } else {
          ascii += glyph;
        }
      }
      continue;
    }
    if (!shouldLock(glyph, cols)) {
      ascii += glyph;
    } else {
      flushAscii();
      runs.push({ kind: "cell", glyph, cols });
    }
  }
  flushAscii();
  return runs;
}
