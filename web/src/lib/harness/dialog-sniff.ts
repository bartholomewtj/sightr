// Does a resting pane's screen hold a dialog that is waiting on the operator? The BRIDGE asks this.
//
// Herdr's detector reports Cursor CLI and Antigravity (agy) as `done` / `idle` while a permission,
// trust, ask or prompt-select card sits on screen, so the herd list, the transition toast and the
// push all said "done" until someone opened the pane (the only place the browser parses text). The
// bridge reads the visible viewport of those panes and publishes `blocked` when this says yes
// (bridge/state-engine.ts → sniffDialogs).
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

/** The agents whose resting status this can overturn, by exact Herdr agent string. */
const SNIFFERS: Record<string, (lines: StyledLine[]) => boolean> = {
  cursor: cursorDialog,
  agy: agyDialog,
  antigravity: agyDialog,
};

/** True when `agent` has a dialog sniffer. The bridge uses this to decide which panes to read. */
export function sniffsDialogs(agent: string): boolean {
  return Object.hasOwn(SNIFFERS, agent);
}

/**
 * True when `text` (a pane read, plain or ANSI) ends in a dialog `agent`'s adapter would lift.
 * Any other agent, or empty text, is false.
 */
export function hasBlockingDialog(agent: string, text: string): boolean {
  if (!Object.hasOwn(SNIFFERS, agent) || text.length === 0) return false;
  return SNIFFERS[agent]!(parseLines(text));
}
