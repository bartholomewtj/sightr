// Pre-generated slash-command catalogs, keyed by Herdr's detected agent type (`pane.agent`).
// Sourced from each agent's official docs (Claude Code: code.claude.com/docs; pi: pi.dev/docs) and
// curated for one-tap use from a phone. A slash command is just text:
// the UI sends `/command` (+ submit key) for no-arg commands, or inserts `/command ` into the
// composer for the user to complete when the command takes an argument.
//
// To regenerate: re-run the per-agent doc-fetch agents (see CHANGELOG) and replace the arrays.

import { canonicalAgent, rowsFor } from "@/lib/operator-scope";
import type { OperatorCommand } from "@/lib/types";

import { AGENTS } from "@shared/agents";
export type { AgentCommand } from "@shared/agents";
import type { AgentCommand } from "@shared/agents";

export const CATALOG: Record<string, readonly AgentCommand[]> = Object.fromEntries(
  AGENTS.map((agent) => [agent.id, agent.catalog ?? []]),
);

/** The agent names the shipped catalog is filed under — pinned against AGENT_FAMILIES in tests. */
export const CATALOG_AGENTS: readonly string[] = Object.keys(CATALOG);

/**
 * Commands for a Herdr-detected agent (`pane.agent`, e.g. "claude" / "pi") — the operator's own
 * `commands.toml` rows if any of them address this pane, otherwise the shipped catalog. Returns
 * [] when neither has anything, and the UI hides the command button.
 *
 * `Object.hasOwn`, not a truthy index: `CATALOG` is a plain object, so an agent string that spells
 * an inherited `Object.prototype` member ("constructor", "toString", "valueOf", …) indexes to that
 * member — a FUNCTION — which is truthy and would be handed back as if it were a command array.
 * command-palette.tsx then calls `.filter` on it and throws, taking the palette down. Same hardening
 * adapterFor() to the registry.
 *
 * Four rules:
 *
 * 1. YOUR LIST IS THE PALETTE. A pane addressed by even one of your rows shows your rows for that
 *    pane and nothing else. This surface is a handful of one-thumb shortcuts, and the value of the
 *    shipped catalog is that someone chose those ten; a list half-chosen by you and half-guessed
 *    for you is worse than either. Discovery is not lost by this — the agent's own `/` completion
 *    renders in the mirrored pane, complete and live, which no copy here could stay.
 * 2. A PANE YOU DID NOT ADDRESS KEEPS ITS CATALOG. Scoping rows to `pi:` says nothing about your
 *    claude panes, so they are left alone. Declaring nothing at all leaves every pane as shipped.
 * 3. DANGER IS INHERITED, NOT RESET. A row naming a shipped command keeps that row's `dangerous`
 *    classification, so re-describing a session wipe cannot turn a two-tap command into a one-tap
 *    one. A row that names nothing shipped is not dangerous — nothing out here knows otherwise.
 * 4. THE MORE SPECIFIC SCOPE WINS, and one `/name` is one row. Exact (`claude-code:` on a
 *    claude-code pane) beats family (`claude:` on the same pane) beats unscoped;
 *    `/deploy=Global,pi:/deploy=On pi` is the obvious way to write "this everywhere, except
 *    here" and must not render as two identically named buttons (which also collide on the
 *    palette's `key={c.command}`). Declaration order decides only between rows of equal
 *    specificity, where the later one wins — the same rule the parser uses for exact duplicates.
 *    A family scope is only ever the catalog's own name for the family: `claude:` reaches a
 *    "claude-code" pane because CLAUDE's shipped rows do; `claude-local:` does NOT, even though
 *    the catalog lookup would fold it onto CLAUDE. Folding an arbitrary operator string through
 *    that ladder turns a scope written to be narrow into a family-wide one.
 */
export function commandsFor(
  agent: string | undefined | null,
  mine: readonly OperatorCommand[] = [],
): readonly AgentCommand[] {
  const shipped = catalogFor(agent);
  const aimed = rowsFor(mine, agent, (row) => row.command);
  // Rule 2: nothing of yours points here, so this pane was never part of what you were choosing.
  if (aimed.length === 0) return shipped;
  const byName = new Map(shipped.map((c) => [c.command, c] as const));
  return aimed.map((row) => ({
    command: row.command,
    description: row.description,
    takesArg: row.takesArg,
    argHint: row.argHint,
    // A row you typed into your own config is by definition one you want on the first screen.
    common: true,
    // Inheriting is a FLOOR, never a default: `confirm = false` on a row that names a shipped
    // dangerous command still confirms, so the only direction this field moves is up.
    dangerous: (byName.get(row.command)?.dangerous ?? false) || row.confirm === true,
  }));
}

function catalogFor(agent: string | undefined | null): readonly AgentCommand[] {
  if (!agent) return [];
  const key = canonicalAgent(agent.toLowerCase().trim());
  return Object.hasOwn(CATALOG, key) ? CATALOG[key] : [];
}
