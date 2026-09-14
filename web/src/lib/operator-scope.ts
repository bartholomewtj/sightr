// How an operator-declared row says WHICH panes it addresses — shared verbatim by `commands.toml`
// (agent-commands.ts) and `keys.toml` (operator-keys.ts), so the two files can never grow two
// different answers to "does this row apply here?".
//
// The rule and its reasoning are ADR 0018's; this module is only where it is computed.

import { AGENT_FAMILIES, canonicalAgent } from "@shared/agents";

export { AGENT_FAMILIES, canonicalAgent };

const FAMILIES: ReadonlySet<string> = new Set<string>(AGENT_FAMILIES);

/** Anything an operator row can be aimed with — the one field the resolution rule reads. */
interface ScopedRow {
  /** Herdr agent name this row applies to, lowercased. Omitted = every agent. */
  agent?: string;
}

const MISSES = 0;
const UNSCOPED = 1;
const FAMILY = 2;
const EXACT = 3;

/** How narrowly one row was aimed at this pane — see rule 4 on {@link rowsFor}. */
function specificity(row: ScopedRow, paneKey: string, paneFamily: string): number {
  // An unscoped row applies everywhere, including to an agent with no catalog at all (and to a
  // pane with no agent, where the surface would otherwise never appear).
  if (row.agent === undefined) return UNSCOPED;
  if (paneKey === "") return MISSES;
  const scope = row.agent.toLowerCase().trim();
  if (scope === paneKey) return EXACT;
  // A family scope is only ever the catalog's own name for the family: `claude:` reaches a
  // "claude-code" pane because CLAUDE's shipped rows do; `claude-local:` does NOT, even though the
  // catalog lookup would fold it onto CLAUDE. Folding an arbitrary operator string through that
  // ladder turns a scope written to be narrow into a family-wide one.
  return FAMILIES.has(scope) && scope === paneFamily ? FAMILY : MISSES;
}

/**
 * The operator's rows that address this pane, narrowest first-wins, one row per `keyOf` name.
 *
 * Empty means "nothing of yours points here", which every caller reads as "keep what ships" —
 * rule 2 below.
 *
 * 1. YOUR LIST IS THE LIST. A pane addressed by even one of your rows shows your rows for that
 *    pane and nothing else (ADR 0018).
 * 2. A PANE YOU DID NOT ADDRESS KEEPS WHAT SHIPS. Scoping rows to `pi` says nothing about your
 *    claude panes. Declaring nothing at all leaves every pane as shipped.
 * 3. THE MORE SPECIFIC SCOPE WINS, and one name is one row. Exact (`claude-code` on a claude-code
 *    pane) beats family (`claude` on the same pane) beats unscoped, so "this everywhere, except
 *    here" is spellable and must not render as two identically named buttons. Declaration order
 *    decides only between rows of equal specificity, where the later one wins.
 */
export function rowsFor<T extends ScopedRow>(
  rows: readonly T[],
  agent: string | undefined | null,
  keyOf: (row: T) => string,
): T[] {
  if (rows.length === 0) return [];
  const paneKey = agent?.toLowerCase().trim() ?? "";
  const paneFamily = canonicalAgent(paneKey);
  // One entry per name, keyed by how specifically it was aimed. Insertion order is declaration
  // order and Map.set on an existing key keeps that position, so a scoped row correcting a global
  // one lands where the global one was.
  const aimed = new Map<string, { row: T; aim: number }>();
  for (const row of rows) {
    const aim = specificity(row, paneKey, paneFamily);
    if (aim === MISSES) continue;
    const name = keyOf(row);
    const prev = aimed.get(name);
    if (prev !== undefined && prev.aim > aim) continue;
    aimed.set(name, { row, aim });
  }
  return [...aimed.values()].map((entry) => entry.row);
}
