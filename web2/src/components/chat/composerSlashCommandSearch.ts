// Adapted from T3 Code apps/web/src/components/chat/composerSlashCommandSearch.ts @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: one item kind, the harness's slash catalog (`commandsFor` from v1's agent-commands, with the
// operator's commands.toml rows). No provider commands or skills, so no prompt-position filter. The
// scoring and ranking are T3's: a prefix match ranks before a word-boundary, substring or fuzzy one.
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandMenu";

/** The command's own name, lowercase, without its leading `/`. */
function commandName(item: ComposerCommandItem): string {
  return item.command.command.replace(/^\/+/, "").toLowerCase();
}

function scoreSlashCommandItem(item: ComposerCommandItem, query: string): number | null {
  const primaryValue = commandName(item);
  const description = item.description.toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: primaryValue,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/", ":"],
    }),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

export function searchSlashCommandItems(items: ReadonlyArray<ComposerCommandItem>, query: string): ComposerCommandItem[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{
    item: ComposerCommandItem;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker: `0\u0000${commandName(item)}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return ranked.map((entry) => entry.item);
}
