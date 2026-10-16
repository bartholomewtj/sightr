// Each harness's input-box functions, the ones the reply guard (lib/guarded-send.ts) runs on. The
// BRIDGE imports this to run the guard next to Herdr (spec 24), so it keeps dialog-sniff.ts's rules:
//
//   1. LEAF IMPORTS ONLY. Nothing reachable from here may import `@shared/...`, `react`, or any other
//      package: the bridge's root typecheck has no `paths` and runs before `web/` installs. That is
//      why this imports each adapter's chrome / paste / chips files rather than its index.ts, and
//      why the shared/ files they reach are imported by relative path.
//   2. SAME FUNCTIONS AS THE ADAPTERS. composer-kit.test.ts holds every field here `===` the
//      adapter's own, so the bridge and the browser cannot judge one screen two ways.

import type { StyledLine } from "../blocks";
import { extractInputDraft as agyDraft, hasInputBox as agyReady, scrolledDraftCarriesSend } from "./agy/chrome";
import {
  extractInputDraft as claudeDraft,
  hasInputBox as claudeReady,
  permissionModeOf as claudeMode,
} from "./claude/chrome";
import { pasteCarriesSend as claudePaste } from "./claude/paste";
import {
  composerPrompt as cursorPrompt,
  composerReady as cursorReady,
  extractInputDraft as cursorDraft,
  permissionModeOf as cursorMode,
  unbindableComposer as cursorUnbindable,
} from "./cursor/chrome";
import { pasteCarriesSend as cursorPaste } from "./cursor/paste";
import {
  composerPrompt as grokPrompt,
  composerReady as grokReady,
  extractInputDraft as grokDraft,
  permissionModeOf as grokMode,
} from "./grok/chrome";
import { chipCarriesSend } from "./grok/chips";

/** The slice of a HarnessAdapter the reply guard uses. Same names and meanings (harness/types.ts). */
export interface ComposerKit {
  composerReady?(lines: StyledLine[]): boolean;
  extractInputDraft(lines: StyledLine[]): string | null;
  composerPrompt?(lines: StyledLine[]): string | null;
  unbindableComposer?(lines: StyledLine[]): string | null;
  draftCarriesSend?(sent: string, draft: string): boolean;
  submitKeys?: string[];
  bracketedPaste?: boolean;
  replyOneShot?: boolean;
  /** The footer's permission mode (T08); see harness/types.ts. */
  permissionModeOf?(lines: StyledLine[]): string | null;
  defaultModeId?: string;
}

/** Pi's input box is not captured (replyOneShot); the adapter uses this too, so the two are one. */
export const noInputDraft = (): null => null;

const AGY: ComposerKit = {
  extractInputDraft: agyDraft,
  composerReady: agyReady,
  draftCarriesSend: scrolledDraftCarriesSend,
  bracketedPaste: true,
};

const KITS: Record<string, ComposerKit> = {
  claude: {
    extractInputDraft: claudeDraft,
    composerReady: claudeReady,
    draftCarriesSend: claudePaste,
    permissionModeOf: claudeMode,
  },
  grok: {
    extractInputDraft: grokDraft,
    composerReady: grokReady,
    composerPrompt: grokPrompt,
    draftCarriesSend: chipCarriesSend,
    permissionModeOf: grokMode,
  },
  agy: AGY,
  antigravity: AGY,
  cursor: {
    extractInputDraft: cursorDraft,
    composerReady: cursorReady,
    composerPrompt: cursorPrompt,
    unbindableComposer: cursorUnbindable,
    draftCarriesSend: cursorPaste,
    submitKeys: ["Right", "Enter"],
    permissionModeOf: cursorMode,
  },
  pi: { extractInputDraft: noInputDraft, replyOneShot: true },
};

/** The agents this file knows, for the parity test. */
export const KIT_AGENTS: readonly string[] = Object.keys(KITS);

/** Exact agent string, like adapterFor: never a prefix (the collie#99 reject). */
export function composerFor(agent: string | undefined | null): ComposerKit | undefined {
  return typeof agent === "string" && Object.hasOwn(KITS, agent) ? KITS[agent] : undefined;
}
