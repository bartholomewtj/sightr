import { type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { liftRegion } from "../scan";
import { detectPromptSelectRegion } from "./prompt-select";
import { extractInputDraft, extractStatusLines, hasInputBox, stripChrome } from "./chrome";

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
};

export const antigravityAdapter: HarnessAdapter = {
  agent: "antigravity",
  buildBlocks: agyBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady: hasInputBox,
};
