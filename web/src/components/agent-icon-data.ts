// Per-agent brand marks for AgentIcon. Each `d` is a 24×24 single-path glyph in the agent's
// official logo, paired with the brand's tile color. Sources (all verified against each project's
// own favicon/site): Claude via Simple Icons (CC0); pi via Simple Icons / pi.dev favicon (#09090b tile).
// To refresh: re-run the fetch in CHANGELOG and replace the `d` strings.

// Existing marks verified against Simple Icons and each project's favicon/site. Refresh by updating
// the corresponding brand in shared/agents.ts.
import { AGENTS, type BrandIcon } from "@shared/agents";

export type AgentBrand = BrandIcon;

/** Brand marks are owned by the shared agent descriptors. */
export const AGENT_BRANDS: Record<string, AgentBrand> = Object.fromEntries(
  AGENTS.flatMap((agent) => ("brand" in agent ? [[agent.id, agent.brand] as const] : [])),
);
