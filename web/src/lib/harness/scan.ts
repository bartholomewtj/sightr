import { isBlank, lineText, trimTrailingBlank, type Block, type StyledLine } from "../blocks";

/** Remove terminal padding without losing meaningful leading indentation. */
export function rstrip(text: string): string {
  return text.replace(/\s+$/, "");
}

export function lastNonBlankIndex(texts: string[]): number {
  let i = texts.length - 1;
  while (i >= 0 && isBlank(texts[i]!)) i--;
  return i;
}

/** Find the nearest non-blank row, rejecting a gap larger than the caller's measured budget. */
export function skipBlanksUp(texts: string[], i: number, maxBlankRun: number): number {
  let gap = 0;
  while (i >= 0 && isBlank(texts[i]!)) {
    if (++gap > maxBlankRun) return -1;
    i--;
  }
  return i;
}

/** Join the half-open row range, with a negative start clamped to the buffer. */
export function regionSignature(texts: string[], from: number, to: number): string {
  return texts.slice(Math.max(0, from), to).join("\n");
}

export interface TailBox {
  top: number;
  firstInner: number;
  prompt: number;
  bottom: number;
  belowEnd: number;
}

export interface TailBoxSpec {
  end?: number;
  bottom: (text: string) => boolean;
  top: (text: string) => boolean;
  below?: (text: string) => boolean;
  maxBelow?: number;
  inner?: (text: string) => boolean;
  maxInner?: number;
  prompt?: (text: string) => boolean;
  maxBlankRun?: number;
}

/** Locate a complete box from its bottom edge, so unrelated text can only make it fail closed. */
export function findTailBox(texts: string[], spec: TailBoxSpec): TailBox | null {
  const end = spec.end ?? lastNonBlankIndex(texts) + 1;
  if (end <= 0) return null;
  const maxBelow = spec.maxBelow ?? 0;
  let bottom = end - 1;
  let below = 0;
  while (bottom >= 0 && !spec.bottom(texts[bottom]!)) {
    if (below >= maxBelow || spec.below?.(texts[bottom]!) !== true) return null;
    below++;
    bottom--;
  }
  if (bottom < 0) return null;

  const inner = spec.inner ?? (() => true);
  const maxInner = spec.maxInner ?? 0;
  const maxBlankRun = spec.maxBlankRun ?? maxInner;
  let row = bottom - 1;
  let innerCount = 0;
  let prompt = -1;
  if (spec.prompt) {
    while (row >= 0 && !spec.prompt(texts[row]!)) {
      if (isBlank(texts[row]!)) {
        if (++innerCount > maxInner || innerCount > maxBlankRun) return null;
        row--;
        continue;
      }
      if (!inner(texts[row]!) || ++innerCount > maxInner) return null;
      row--;
    }
    if (row < 0) return null;
    prompt = row;
    row--;
    while (row >= 0 && isBlank(texts[row]!)) {
      if (++innerCount > maxInner || innerCount > maxBlankRun) return null;
      row--;
    }
  } else {
    while (row >= 0 && inner(texts[row]!)) {
      if (++innerCount > maxInner) return null;
      row--;
    }
  }
  if (row < 0 || !spec.top(texts[row]!)) return null;
  return { top: row, firstInner: row + 1, prompt: prompt < 0 ? row + 1 : prompt, bottom, belowEnd: end };
}

/** Keep the raw prefix and replace the detected region with its typed block. */
export function liftRegion(lines: StyledLine[], region: { startLine: number }, block: Block): Block[] {
  const before = trimTrailingBlank(lines.slice(0, region.startLine));
  return before.length > 0 ? [{ kind: "raw", lines: before }, block] : [block];
}

export { isBlank, lineText };
