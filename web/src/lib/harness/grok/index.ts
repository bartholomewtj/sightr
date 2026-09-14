// The Grok Build adapter. Chrome/status/draft are Tier 1. Interactive kinds with dated captures
// and notes: permission (`prompt-select` — cards are CLASSIFIED by row, not layout-pinned: the
// bottom Yes/No pair becomes the buttons, persistent rows never do; see permission.ts),
// ask_user_question radio cards (`prompt-select`, digit N submits; `z` is free-text — parsed to
// lock buttons, not typed from the phone), and plan approval (`menu` of footer-named keys,
// including the Tab-into-composer
// footer). Checkbox asks, including `[n/m]` wizard steps (stepper chips, Left/Right nav, Enter
// submits), lift as `multi-select` (`tab-space-enter`: Tab/Space toggle, Enter submit; a digit
// still submits — never emit one). Esc-park still lifts; the first Tab re-enters. Multi-question
// radio asks (`[n/m]`, m ≥ 2) lift as `wizard` (digit answers the current step; Left/Right change
// step).
// The chrome probes sit on the REPLY path: registering any
// adapter switches core off one-shot send, after which `extractInputDraft` is what the submit key
// waits on and `composerReady` decides whether a byte is typed. Two Grok rewrites of that draft
// are documented in CHROME_NOTES.md: `[Image #N]` chips (chips.ts) and italic ghost completions.
//
// The review bar is collie#99 (agy). That PR went hot on day one by emitting `prompt-select` (whose
// keystroke recipe is already live in core) and by prefix-matching inside `adapterFor`. Two rules
// this file exists to keep:
//
//   1. TIER 2 ONLY WHERE PROBED. Emitting `prompt-select` / `wizard` / `menu` is automatically
//      Tier 2 (HARNESS_CONTRIBUTING.md): dated fixture corpus, a notes file with the verified
//      recipe, `describeAdapterConformance`, and maintainer live-verification. Permission, ask,
//      and plan review clear that bar. A later lift must not start by synthesising digits from
//      numbered rows — ADR 0009 — unless a live probe of THAT screen says the digit is safe.
//   2. EXACT AGENT STRING. Register `agent: "grok"` only. Prefix-matching in `adapterFor` was the
//      other collie#99 reject: it widened claude to any string with its prefixes. Catalog variant
//      folding (`grok-build` → grok slash palette) lives in `canonicalAgent`, never here.
//      Herdr reports `agent: "grok"` — live-checked 2026-08-23 against `herdr agent` kinds and
//      every Grok Build pane on the capture host (kind list, pane.agent, agent_session.agent).
//
// Permission and ask cards REPLACE the composer. Plan approval LEAVES a composer; composerReady
// is false because detectPlanMenu claims the screen. Option 1 on a permission card is
// always-approve and is never a button.

import { type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { liftRegion } from "../scan";
import {
  composerPrompt,
  composerReady,
  extractInputDraft,
  extractStatusLines,
  stripCanvasBackground,
  stripChrome,
} from "./chrome";
import { checkboxAskPresent, detectAskRegion, detectAskWizardRegion, detectCheckboxAskRegion } from "./ask";
import { chipCarriesSend, isImageChipOnly } from "./chips";
import { detectPermissionRegion } from "./permission";
import { detectPlanMenuRegion } from "./plan-menu";

export function grokBuildBlocks(lines: StyledLine[]): Block[] {
  // Drop Grok's full-screen theme-canvas paint before any block is built, so every rendered
  // surface (raw mirror and dialog blocks alike) sits on the mirror's own ground — see
  // stripCanvasBackground. Detection is text-based and unaffected.
  lines = stripCanvasBackground(lines);
  const permission = detectPermissionRegion(lines);
  if (permission) {
    return liftRegion(lines, permission, {
      kind: "prompt-select",
      prompt: permission.model,
      lines: lines.slice(permission.startLine),
    });
  }

  const checkbox = detectCheckboxAskRegion(lines);
  if (checkbox) {
    return liftRegion(lines, checkbox, {
      kind: "multi-select",
      multi: checkbox.model,
      lines: lines.slice(checkbox.startLine),
    });
  }

  const askWizard = detectAskWizardRegion(lines);
  if (askWizard) {
    return liftRegion(lines, askWizard, { kind: "wizard", wizard: askWizard.model, lines: lines.slice(askWizard.startLine) });
  }

  const ask = detectAskRegion(lines);
  if (ask) {
    return liftRegion(lines, ask, { kind: "prompt-select", prompt: ask.model, lines: lines.slice(ask.startLine) });
  }

  const plan = detectPlanMenuRegion(lines);
  if (plan) {
    return liftRegion(lines, plan, { kind: "menu", menu: plan.model, lines: lines.slice(plan.startLine) });
  }

  return [{ kind: "raw", lines: stripChrome(lines) }];
}

export { extractStatusLines, extractInputDraft };

export const grokAdapter: HarnessAdapter = {
  agent: "grok",
  buildBlocks: grokBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady,
  composerPrompt,
  // Only true for a checkbox ask card that is present on screen but could not be lifted.
  needsDump: (lines) => checkboxAskPresent(lines) && detectCheckboxAskRegion(lines) === null,
  // Image paths never appear in the box as themselves — Grok rewrites them into `[Image #N]` —
  // so the reply guard's literal match can't verify them and the send stalls. These two read that
  // token: as send evidence when it's consistent with what we typed, and as "this isn't the user's
  // text" for the stranded-draft preview's Take over. Italic ghost completions are stripped in
  // extractInputDraft instead.
  draftCarriesSend: chipCarriesSend,
  draftIsOpaque: isImageChipOnly,
};
