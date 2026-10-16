import { NO_CAPABILITIES, type ThreadCapabilities } from "../../shared/v2/contracts.ts";
import { adapterFor } from "../journal/registry.ts";
import type { JournalAdapter } from "../journal/types.ts";

// Interim capability table for the herd ingest (T02). Only two flags are known yet: whether the
// harness has a journal Sightr can tail, and whether a queued message can be drained into it (any
// agent; a bare shell has no idle prompt to drain into). T06 adds the interrupt rows; T08 moves the
// table into `shared/agents.ts` and this file becomes a re-export.

/** The harness name a bare shell pane gets. */
export const SHELL_HARNESS = "shell";

export function capabilitiesFor(
  harness: string,
  journals: Record<string, JournalAdapter> | null,
): ThreadCapabilities {
  return {
    ...NO_CAPABILITIES,
    hasJournal: harness !== SHELL_HARNESS && adapterFor(journals ?? {}, harness) !== undefined,
    canQueueDrain: harness !== SHELL_HARNESS,
  };
}
