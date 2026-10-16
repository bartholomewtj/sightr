import { AGENTS, capabilitiesFor as agentCapabilities, SHELL_CAPABILITIES } from "../../shared/agents.ts";
import type { ThreadCapabilities } from "../../shared/v2/contracts.ts";
import { adapterFor } from "../journal/registry.ts";
import type { JournalAdapter } from "../journal/types.ts";

// The capability table lives in `shared/agents.ts` (T08). This file adds the two facts only the
// running bridge knows: whether this bridge actually tails a journal for the harness (a registry
// built from its roots, or none when transcripts are off), and that a harness Sightr has no
// descriptor for still has a prompt a queued message can drain into.

/** The harness name a bare shell pane gets. */
export const SHELL_HARNESS = "shell";

/**
 * The interrupt key per harness and whether it passed a live check, read from the descriptors (the
 * rows T06 kept here). Only verified rows give `canInterrupt` and `interruptKeys`.
 */
export const INTERRUPT_TABLE: Readonly<Record<string, { keys: string[]; verified: boolean }>> = Object.fromEntries(
  AGENTS.map((agent) => [
    agent.id,
    { keys: [...(agent.capabilities.interruptKeys ?? [])], verified: agent.capabilities.canInterrupt },
  ]),
);

/** What a thread of `harness` can do on this bridge. */
export function capabilitiesFor(harness: string, journals: Record<string, JournalAdapter> | null): ThreadCapabilities {
  if (harness === SHELL_HARNESS) return { ...SHELL_CAPABILITIES };
  const caps = agentCapabilities(harness);
  return {
    ...caps,
    hasJournal: caps.hasJournal && adapterFor(journals ?? {}, harness) !== undefined,
    // An agent the table does not know is still an agent at a prompt (T06).
    canQueueDrain: caps.canQueueDrain || AGENTS.every((agent) => agent.id !== harness),
  };
}
