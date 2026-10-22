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

import { parseLines, type StyledLine } from "./blocks";
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

// ── Compaction status ──────────────────────────────────────────────────────────────────────────
//
// A harness that compacts its context on its own (no user message: Claude's auto-compact, Pi's
// auto-compaction) cancels the compaction on the interrupt key a steer presses. The bridge reads a
// working thread's screen for the harness's own status row and queues instead of steering
// (bridge/threads/compaction-watch.ts). Only the rows below are read, near the tail, so a transcript
// line quoting the words far above does not count.

/** How many rows from the bottom of a read the status row may sit in. */
const COMPACTING_TAIL_ROWS = 20;

/**
 * Claude's spinner row while it compacts, manual `/compact` or auto: one spinner glyph (`·✢✳✶✻✽*`,
 * it cycles), then "Compacting conversation…" and the elapsed time (live 2026-10-18, Claude Code
 * 2.1.302: `✻ Compacting conversation… (2s · ↓ 133 tokens)`).
 */
const CLAUDE_COMPACTING = /^\s*\S\s+Compacting conversation…/;
/**
 * Pi's compaction status indicator (pi-coding-agent `CompactionStatusIndicator`): "Compacting
 * context... (esc to cancel)" for `/compact`, "Auto-compacting... (esc to cancel)" (optionally after
 * "Context overflow detected, ") when Pi compacts on its own. It sits in the editor slot or in the
 * editor's top border, so it is matched anywhere on the row. From Pi's source; not captured live
 * (a session too small to compact shows only "Nothing to compact").
 */
const PI_COMPACTING = /(?:Compacting context|Auto-compacting)\.\.\. \(/;

const COMPACTING: Record<string, RegExp> = {
  claude: CLAUDE_COMPACTING,
  pi: PI_COMPACTING,
};

/** True when `agent` has a compaction status row this file knows. */
export function detectsCompaction(agent: string): boolean {
  return Object.hasOwn(COMPACTING, agent);
}

/**
 * True when `text` (a pane read, plain or ANSI) shows `agent`'s compaction status row near its tail.
 * Any other agent, or empty text, is false.
 */
export function isCompactingScreen(agent: string, text: string): boolean {
  if (!Object.hasOwn(COMPACTING, agent) || text.length === 0) return false;
  const re = COMPACTING[agent]!;
  const rows = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/);
  let end = rows.length - 1;
  while (end >= 0 && rows[end]!.trim() === "") end--;
  for (let i = end; i >= 0 && end - i < COMPACTING_TAIL_ROWS; i--) if (re.test(rows[i]!)) return true;
  return false;
}

const WAITING_BACKGROUND: Record<string, RegExp> = {
  // The row starts with Claude's spinner glyph (it cycles); a transcript line that only quotes the phrase does not.
  claude: /^\s*[·✢✳✶✻✽*]\s*Waiting for [1-9]\d* background agents? to finish/i,
};

/** True when `agent` has a background-agents status row this file knows. */
export function detectsBackgroundAgents(agent: string): boolean {
  return Object.hasOwn(WAITING_BACKGROUND, agent);
}

/**
 * True when `text` (a pane read, plain or ANSI) shows `agent`'s waiting-for-background-agents row near
 * its tail. Only the last rows count, like `isCompactingScreen`: transcript text above that quotes the
 * phrase is not the status row, and a false match would let a message go in while the agent works.
 */
export function isWaitingBackgroundScreen(agent: string, text: string): boolean {
  if (!Object.hasOwn(WAITING_BACKGROUND, agent) || text.length === 0) return false;
  const re = WAITING_BACKGROUND[agent]!;
  const rows = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/);
  let end = rows.length - 1;
  while (end >= 0 && rows[end]!.trim() === "") end--;
  for (let i = end; i >= 0 && end - i < COMPACTING_TAIL_ROWS; i--) if (re.test(rows[i]!)) return true;
  return false;
}
