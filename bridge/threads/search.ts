import type { Database } from "bun:sqlite";

import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_EXCERPT_CHARS,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_QUERY_CHARS,
  SEARCH_MIN_CHARS,
  type SearchRole,
  type ThreadSearchMatch,
  type ThreadSearchResponse,
} from "../../shared/v2/contracts.ts";

// Message search over the v2 store (`GET /api/v2/search`).
//
// One FTS5 table, `item_search`, holds the text of three kinds of turn item: user messages, assistant
// messages and command inputs (never tool output, reasoning or diffs). It is kept current by triggers on
// `turn_items`, the one table every projection write and every `prune` goes through, so an item that is
// appended, streamed into, pruned or cascaded away with its thread is indexed, re-indexed or dropped
// with no help from `applyEvent`. The FTS rowid is the item's own rowid; `item_id` rides along so a
// rowid that ever drifted (a VACUUM) matches nothing rather than the wrong item.

/** Longest text kept per item in the index (a pasted log is not worth more). */
export const INDEX_TEXT_CHARS = 20_000;
/** The migration rebuilds the index from this many of the newest existing items, no more. */
export const REBUILD_ITEMS = 20_000;
/** Per thread, so one chatty thread cannot fill the list. */
export const MAX_PER_THREAD = 3;
const MAX_TOKENS = 6;
const MAX_TOKEN_CHARS = 64;
const OVERFETCH = 4;
const FETCH_CAP = 400;

const SEARCHABLE_TYPES = `'user_message', 'assistant_message', 'command_execution'`;

const textOf = (row: string): string =>
  `substr(coalesce(CASE ${row}.type WHEN 'command_execution' THEN json_extract(${row}.body_json, '$.input') ELSE json_extract(${row}.body_json, '$.text') END, ''), 1, ${INDEX_TEXT_CHARS})`;

/** Migration 6: the index, its triggers, and a bounded rebuild from the rows already there. */
export function createSearchIndex(db: Database): void {
  db.run(`CREATE VIRTUAL TABLE item_search USING fts5(text, item_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2')`);
  db.run(`CREATE TRIGGER item_search_ai AFTER INSERT ON turn_items WHEN new.type IN (${SEARCHABLE_TYPES}) BEGIN
    INSERT INTO item_search (rowid, text, item_id) VALUES (new.rowid, ${textOf("new")}, new.id);
  END`);
  db.run(`CREATE TRIGGER item_search_au AFTER UPDATE ON turn_items WHEN old.body_json IS NOT new.body_json OR old.type IS NOT new.type BEGIN
    DELETE FROM item_search WHERE rowid = old.rowid;
    INSERT INTO item_search (rowid, text, item_id) SELECT new.rowid, ${textOf("new")}, new.id WHERE new.type IN (${SEARCHABLE_TYPES});
  END`);
  db.run(`CREATE TRIGGER item_search_ad AFTER DELETE ON turn_items BEGIN
    DELETE FROM item_search WHERE rowid = old.rowid;
  END`);
  db.run(
    `INSERT INTO item_search (rowid, text, item_id)
     SELECT rowid, ${textOf("turn_items")}, id FROM turn_items
     WHERE type IN (${SEARCHABLE_TYPES}) ORDER BY updated_sequence DESC LIMIT ${REBUILD_ITEMS}`,
  );
}

// ── Query ─────────────────────────────────────────────────────────────────────────────────────────

/** The words of a query: letters and digits, the way the index's tokenizer splits, at most six. */
export function queryTokens(q: string): string[] {
  const words = q.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.slice(0, MAX_TOKENS).map((w) => w.slice(0, MAX_TOKEN_CHARS));
}

/** FTS5 MATCH text: every word as a quoted prefix term, all required. Null when nothing searchable. */
export function matchExpression(tokens: readonly string[]): string | null {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(" AND ");
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Up to `SEARCH_EXCERPT_CHARS` of `text` around its first hit, with the hit ranges inside it. */
export function excerptFor(text: string, tokens: readonly string[]): { excerpt: string; ranges: { start: number; end: number }[] } {
  const flat = text.replace(/\s+/g, " ").trim();
  const re = tokens.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...tokens].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`, "giu")
    : null;
  const first = re ? re.exec(flat) : null;
  const hit = first?.index ?? 0;
  const lead = 40;
  let start = Math.max(0, hit - lead);
  // Begin on a word edge when the window starts mid-text.
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space !== -1 && space < hit) start = space + 1;
  }
  const prefix = start > 0 ? "…" : "";
  let end = Math.min(flat.length, start + SEARCH_EXCERPT_CHARS - prefix.length);
  let suffix = "";
  if (end < flat.length) {
    suffix = "…";
    end = Math.min(flat.length, start + SEARCH_EXCERPT_CHARS - prefix.length - suffix.length);
  }
  const body = flat.slice(start, end);
  const ranges: { start: number; end: number }[] = [];
  if (re) {
    const inner = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = inner.exec(body)) !== null) {
      if (m[0].length === 0) break;
      ranges.push({ start: prefix.length + m.index, end: prefix.length + m.index + m[0].length });
    }
  }
  return { excerpt: prefix + body + suffix, ranges };
}

export interface SearchOptions {
  q: string;
  limit?: number;
  includeArchived?: boolean;
}

interface HitRow {
  item_id: string;
  thread_id: string;
  type: string;
  text: string;
  at: number | null;
  title: string;
  project_id: string;
  project_label: string | null;
  shelf: string;
}

const ROLE: Record<string, SearchRole> = { user_message: "user", assistant_message: "assistant", command_execution: "tool" };

/** Clamp a caller's limit into 1..SEARCH_MAX_LIMIT (default SEARCH_DEFAULT_LIMIT). */
export function clampSearchLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isInteger(raw) || raw <= 0) return SEARCH_DEFAULT_LIMIT;
  return Math.min(raw, SEARCH_MAX_LIMIT);
}

export function searchItems(db: Database, opts: SearchOptions): ThreadSearchResponse {
  const q = opts.q.trim().slice(0, SEARCH_MAX_QUERY_CHARS);
  const empty: ThreadSearchResponse = { query: q, results: [], truncated: false };
  if (q.length < SEARCH_MIN_CHARS) return empty;
  const tokens = queryTokens(q);
  const match = matchExpression(tokens);
  if (match === null) return empty;
  const limit = clampSearchLimit(opts.limit);
  const fetch = Math.min(limit * OVERFETCH + 1, FETCH_CAP);
  let rows: HitRow[];
  try {
    rows = db
      .query<HitRow, [string, number, number]>(
        `SELECT i.id AS item_id, i.thread_id, i.type, s.text, json_extract(i.body_json, '$.createdAt') AS at,
                t.title, t.project_id, p.label AS project_label, t.shelf
         FROM item_search s
           JOIN turn_items i ON i.rowid = s.rowid AND i.id = s.item_id
           JOIN threads t ON t.id = i.thread_id
           LEFT JOIN projects p ON p.id = t.project_id
         WHERE item_search MATCH ?1 AND (t.shelf != 'archived' OR ?2 = 1)
         ORDER BY i.updated_sequence DESC
         LIMIT ?3`,
      )
      .all(match, opts.includeArchived ? 1 : 0, fetch);
  } catch {
    // An expression FTS5 refuses is a query with no answer, not a server error.
    return empty;
  }
  const perThread = new Map<string, number>();
  const results: ThreadSearchMatch[] = [];
  let truncated = rows.length >= fetch;
  for (const row of rows) {
    const used = perThread.get(row.thread_id) ?? 0;
    if (used >= MAX_PER_THREAD) {
      truncated = true;
      continue;
    }
    if (results.length >= limit) {
      truncated = true;
      break;
    }
    perThread.set(row.thread_id, used + 1);
    const { excerpt, ranges } = excerptFor(row.text, tokens);
    results.push({
      threadId: row.thread_id,
      threadTitle: row.title,
      projectId: row.project_id,
      projectLabel: row.project_label ?? "",
      archived: row.shelf === "archived",
      itemId: row.item_id,
      role: ROLE[row.type] ?? "assistant",
      excerpt,
      ranges,
      at: row.at ?? 0,
    });
  }
  return { query: q, results, truncated };
}
