import { type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { liftRegion } from "../scan";
import { detectPiPromptRegion, detectPiWizardRegion } from "./ask";

export function piBuildBlocks(lines: StyledLine[]): Block[] {
  const wizard = detectPiWizardRegion(lines);
  if (wizard) {
    return liftRegion(lines, wizard, {
      kind: "wizard",
      wizard: wizard.model,
      lines: lines.slice(wizard.startLine),
    });
  }
  const prompt = detectPiPromptRegion(lines);
  if (prompt) {
    return liftRegion(lines, prompt, {
      kind: "prompt-select",
      prompt: prompt.model,
      lines: lines.slice(prompt.startLine),
    });
  }
  return [{ kind: "raw", lines }];
}

export const piAdapter: HarnessAdapter = {
  agent: "pi",
  buildBlocks: piBuildBlocks,
  extractStatusLines: () => [],
  extractInputDraft: () => null,
  replyOneShot: true,
};
