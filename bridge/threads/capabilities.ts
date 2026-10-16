import { NO_CAPABILITIES, type ThreadCapabilities } from "../../shared/v2/contracts.ts";
import { adapterFor } from "../journal/registry.ts";
import type { JournalAdapter } from "../journal/types.ts";

// Interim capability table for the herd ingest (T02) and dispatch (T06). Known flags: whether the
// harness has a journal Sightr can tail, whether a queued message can be drained into it (any agent;
// a bare shell has no idle prompt to drain into), and how a run is interrupted. T08 moves the table
// into `shared/agents.ts` and this file becomes a re-export.

/** The harness name a bare shell pane gets. */
export const SHELL_HARNESS = "shell";

/**
 * The key that stops a run, per harness, sent once (`run.interrupt`, steer). `verified` is true only
 * for a harness whose key passed a live check through Sightr's send path; only those get
 * `canInterrupt`. The rest keep their key here so the check is one flag flip.
 */
export const INTERRUPT_TABLE: Readonly<Record<string, { keys: string[]; verified: boolean }>> = {
  // Live 16 Oct 2026 (Claude Code 2.1.301, scratch workspace): one Escape stops the turn. A second
  // Escape while it stops opens the rewind menu, so dispatch never repeats it (dispatch.ts).
  claude: { keys: ["Escape"], verified: true },
  pi: { keys: ["Escape"], verified: false },
  // `ctrl+c` may quit Grok, so Escape is the candidate.
  grok: { keys: ["Escape"], verified: false },
  // Its composer shows "ctrl+c to stop"; a second press may exit, so it is sent once.
  cursor: { keys: ["ctrl+c"], verified: false },
  agy: { keys: ["Escape"], verified: false },
  codex: { keys: ["Escape"], verified: false },
};

export function capabilitiesFor(
  harness: string,
  journals: Record<string, JournalAdapter> | null,
): ThreadCapabilities {
  const interrupt = Object.hasOwn(INTERRUPT_TABLE, harness) ? INTERRUPT_TABLE[harness] : undefined;
  return {
    ...NO_CAPABILITIES,
    hasJournal: harness !== SHELL_HARNESS && adapterFor(journals ?? {}, harness) !== undefined,
    canQueueDrain: harness !== SHELL_HARNESS,
    canInterrupt: interrupt?.verified === true,
    ...(interrupt?.verified ? { interruptKeys: [...interrupt.keys] } : {}),
  };
}
