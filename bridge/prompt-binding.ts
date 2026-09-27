// The matcher lives in shared/ so the web conformance suite tests the same function (spec 06).
export {
  DEFAULT_PROMPT_TAIL_LINES,
  normalizePromptRegion,
  verifyExpectedPrompt,
  type PromptBindingResult,
} from "../shared/prompt-binding.ts";
