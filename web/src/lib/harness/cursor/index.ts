// The Cursor CLI adapter. Chrome/status/draft are Tier 1. Interactive kinds with dated captures
// and notes: command-approval (`prompt-select` — only Run once / Skip; never allowlist or
// Run Everything), workspace trust (`prompt-select` with letter keys a/q), and single-select
// ask-question cards (`prompt-select` with pointer arrow-walk + Enter, source-verified with live
// probe pending; `Other:` locks the buttons; multi-select stays raw). Plan mode asks clarifying
// questions as ordinary transcript. Write-file approval was not seen on the live probe (Auto
// allowed edits); do not synthesise it.
//
// Rules this file exists to keep:
//
//   1. TIER 2 ONLY WHERE PROBED. Emitting prompt-select is Tier 2: dated fixtures, notes with
//      the verified recipe, describeAdapterConformance, live verification.
//   2. EXACT AGENT STRING. Register `agent: "cursor"` only. Prefix-matching in adapterFor was
//      the collie#99 reject. Herdr reports `agent: "cursor"`.

import { type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { liftRegion } from "../scan";
import {
  composerPrompt,
  composerReady,
  extractInputDraft,
  extractStatusLines,
  stripChrome,
} from "./chrome";
import { detectAskRegion } from "./ask";
import { detectPermissionRegion } from "./permission";
import { detectTrustRegion } from "./trust";

export function cursorBuildBlocks(lines: StyledLine[]): Block[] {
  const permission = detectPermissionRegion(lines);
  if (permission) {
    return liftRegion(lines, permission, {
      kind: "prompt-select",
      prompt: permission.model,
      lines: lines.slice(permission.startLine),
    });
  }

  const trust = detectTrustRegion(lines);
  if (trust) {
    return liftRegion(lines, trust, {
      kind: "prompt-select",
      prompt: trust.model,
      lines: lines.slice(trust.startLine),
    });
  }

  const ask = detectAskRegion(lines);
  if (ask) {
    return liftRegion(lines, ask, {
      kind: "prompt-select",
      prompt: ask.model,
      lines: lines.slice(ask.startLine),
    });
  }

  return [{ kind: "raw", lines: stripChrome(lines) }];
}

export { extractStatusLines, extractInputDraft };

export const cursorAdapter: HarnessAdapter = {
  agent: "cursor",
  buildBlocks: cursorBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady,
  composerPrompt,
  // Windows ConPTY: Cursor CLI treats a paste burst as still open and either rewrites the next
  // Enter into a newline or buffers it until a later input event (forum 166674). A Right arrow
  // after the typed text flushes that burst without submitting; Enter then submits on its own
  // write. Grok cannot use this — its footer binds → to accept a ghost suggestion.
  submitKeys: ["Right", "Enter"],
};
