// Does a pane's screen hold a dialog that is waiting on the operator? The BRIDGE asks this.
//
// Herdr's detector reports Cursor CLI and Antigravity (agy) as `done` / `idle` while a permission,
// trust, ask or prompt-select card sits on screen, so the herd list, the transition toast and the
// push all said "done" until someone opened the pane (the only place the browser parses text). The
// bridge reads the visible viewport of those panes and publishes `blocked` when this says yes
// (bridge/state-engine.ts → sniffDialogs).
//
// Pi is the other way round. Herdr's Pi integration (`~/.pi/agent/extensions/herdr-agent-state.ts`)
// reports `working` for the whole tool call, and Pi's `askuserquestion` IS a tool call, so a Pi pane
// showing its ask frame stays `working`: the thread never went to Needs you and the v2 bridge never
// read the screen for a request (live 2026-10-18, "Pick an animal"). Pi is therefore sniffed while
// `working`, and only then. Each agent names the raw Herdr statuses its sniff may overturn.
//
// Rules this file exists to keep:
//
//   1. LEAF IMPORTS ONLY. The bridge's root typecheck has no `paths` and runs before `web/` installs
//      its packages, so nothing reachable from here may import `@shared/...`, `react`, or any other
//      package. That is why this calls the leaf detectors directly instead of the adapters
//      (cursor/index.ts pulls chrome.ts, which pulls `@shared`).
//   2. EXACT AGENT STRING. `cursor`, `agy`, `antigravity` — never a prefix (the collie#99 reject).
//   3. SAME DETECTORS AS THE ADAPTERS. A pane is blocked here exactly when its adapter would lift a
//      dialog block from the same lines; dialog-sniff.test.ts pins that against every fixture.

import { parseLines, type StyledLine } from "../blocks";
import { detectPromptSelectRegion } from "./agy/prompt-select";
import { detectAskRegion, detectMultiAskRegion } from "./cursor/ask";
import { detectPermissionRegion } from "./cursor/permission";
import { detectTrustRegion } from "./cursor/trust";
import { detectPiPromptRegion, detectPiReviewRegion, detectPiWizardRegion } from "./pi/ask";

function cursorDialog(lines: StyledLine[]): boolean {
  return (
    detectPermissionRegion(lines) !== null ||
    detectTrustRegion(lines) !== null ||
    detectMultiAskRegion(lines) !== null ||
    detectAskRegion(lines) !== null
  );
}

function agyDialog(lines: StyledLine[]): boolean {
  return detectPromptSelectRegion(lines) !== null;
}

/** The same three detectors, in the same order, as `piBuildBlocks` (pi/index.ts). */
function piDialog(lines: StyledLine[]): boolean {
  return (
    detectPiWizardRegion(lines) !== null ||
    detectPiReviewRegion(lines) !== null ||
    detectPiPromptRegion(lines) !== null
  );
}

/** Herdr's resting statuses: Cursor and Antigravity hold a dialog while Herdr calls them one of these. */
const AT_REST: ReadonlySet<string> = new Set(["idle", "done", "unknown"]);
/** Pi's ask is a tool call, so Herdr calls the pane `working` while the frame waits. */
const WHILE_WORKING: ReadonlySet<string> = new Set(["working"]);

interface Sniffer {
  detect: (lines: StyledLine[]) => boolean;
  /** The raw Herdr statuses this sniff may overturn to `blocked`. */
  at: ReadonlySet<string>;
}

/** The agents whose raw status this can overturn, by exact Herdr agent string. */
const SNIFFERS: Record<string, Sniffer> = {
  cursor: { detect: cursorDialog, at: AT_REST },
  agy: { detect: agyDialog, at: AT_REST },
  antigravity: { detect: agyDialog, at: AT_REST },
  pi: { detect: piDialog, at: WHILE_WORKING },
};

/** True when `agent` has a dialog sniffer. */
export function sniffsDialogs(agent: string): boolean {
  return Object.hasOwn(SNIFFERS, agent);
}

/**
 * True when a pane of `agent` at raw Herdr status `status` should be read for a dialog. The bridge
 * uses this to decide which panes to read.
 */
export function sniffsDialogsAt(agent: string, status: string): boolean {
  return Object.hasOwn(SNIFFERS, agent) && SNIFFERS[agent]!.at.has(status);
}

/**
 * True when `text` (a pane read, plain or ANSI) ends in a dialog `agent`'s adapter would lift.
 * Any other agent, or empty text, is false.
 */
export function hasBlockingDialog(agent: string, text: string): boolean {
  if (!Object.hasOwn(SNIFFERS, agent) || text.length === 0) return false;
  return SNIFFERS[agent]!.detect(parseLines(text));
}
