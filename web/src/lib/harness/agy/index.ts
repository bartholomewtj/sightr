import { type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { liftRegion } from "../scan";
import { detectPromptSelectRegion } from "./prompt-select";
import {
  extractInputDraft,
  extractStatusLines,
  hasInputBox,
  isScrolledDraft,
  scrolledDraftCarriesSend,
  stripChrome,
} from "./chrome";

export function agyBuildBlocks(lines: StyledLine[]): Block[] {
  const region = detectPromptSelectRegion(lines);
  if (region) {
    return liftRegion(lines, region, { kind: "prompt-select", prompt: region.model, lines: lines.slice(region.startLine) });
  }

  return [{ kind: "raw", lines: stripChrome(lines) }];
}

export { extractStatusLines, extractInputDraft };

export const agyAdapter: HarnessAdapter = {
  agent: "agy",
  buildBlocks: agyBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady: hasInputBox,
  // A long draft scrolls to `↑ N more lines` + its tail, which the literal match cannot see.
  draftCarriesSend: scrolledDraftCarriesSend,
  draftIsOpaque: isScrolledDraft,
  // A bare newline in a long raw send can submit the first line and queue the rest (#47).
  bracketedPaste: true,
};

export const antigravityAdapter: HarnessAdapter = {
  agent: "antigravity",
  buildBlocks: agyBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady: hasInputBox,
  // A long draft scrolls to `↑ N more lines` + its tail, which the literal match cannot see.
  draftCarriesSend: scrolledDraftCarriesSend,
  draftIsOpaque: isScrolledDraft,
  // A bare newline in a long raw send can submit the first line and queue the rest (#47).
  bracketedPaste: true,
};
