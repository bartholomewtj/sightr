// Sightr code (T29). The pending line comments of each thread: what the operator wrote on a diff and has not sent.
// Saving a comment puts it here and never touches the composer's draft; "Add to message" does that (see
// state/composer.ts `requestInsert`). The list is the basket, the draft is the user's words.
//
// Persisted like drafts (lib/drafts.ts): localStorage under `sightr:v2:line-comments:<threadId>`, every access in a
// try/catch with the store itself as the memory fallback, entries older than 48 h pruned on first use. The draft
// store keeps only 8 KiB on disk, which is why the comments hold a copy of their own.
//
// A comment is removed only by Delete, Discard, or a confirmed send of its exact block (`consumeSent`). Never by a
// diff change: a comment whose lines changed becomes `outdated` and stays.
import { create } from "zustand";

import type { DiffSide } from "@/components/diffs/DiffCodeView";
import { locateComment } from "@/components/diffs/lineSelection";
import type { ParsedPatchFile } from "@/components/diffs/parsePatch";
import {
  blockHash,
  blockKey,
  cutQuoteLine,
  isInMessage,
  MAX_NOTE_CHARS,
  MAX_QUOTE_LINES,
  reviewBlocksIn,
} from "@/lib/reviewCommentContext";

export const MAX_PENDING_COMMENTS = 30;
const PREFIX = "sightr:v2:line-comments:";
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** `pending`: the lines are where they were. `moved`: the same lines were found elsewhere in the file. `outdated`: they changed or the file left the scope. */
export type CommentState = "pending" | "moved" | "outdated";
/** What the list shows: the stored state, or `in message` when the draft holds the comment's block. */
export type CommentView = CommentState | "in message";

export interface LineComment {
  id: string;
  /** Repo-relative, forward slashes. */
  path: string;
  side: DiffSide;
  start: number;
  end: number;
  /** FNV-1a over the full quoted lines (prefixes included); the anchor. */
  hash: string;
  /** The quoted lines as the block shows them: `+`, `-` or a space first, each cut to 160 characters. */
  quote: string[];
  note: string;
  createdAt: number;
  state: CommentState;
}

export type CommentInput = {
  path: string;
  side: DiffSide;
  start: number;
  end: number;
  /** The full quoted lines, prefixes included. */
  quote: readonly string[];
  note: string;
};

export type AddResult = { ok: true; comment: LineComment } | { ok: false; reason: "full" | "empty" | "note-too-long" | "range" };

export const ADD_REFUSAL: Record<Exclude<AddResult, { ok: true }>["reason"], string> = {
  full: "Pending list is full (30). Send or discard some first.",
  empty: "Write a note first.",
  "note-too-long": `A note can be ${MAX_NOTE_CHARS} characters at most.`,
  range: `A comment quotes ${MAX_QUOTE_LINES} lines at most.`,
};

const EMPTY: readonly LineComment[] = Object.freeze([]);

interface Entry {
  comments: readonly LineComment[];
  at: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function parseEntry(raw: string | null): Entry | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<Entry> | null;
    if (!v || typeof v !== "object" || typeof v.at !== "number" || !Array.isArray(v.comments)) return null;
    const comments = v.comments.filter(isComment);
    return { comments, at: v.at };
  } catch {
    return null;
  }
}

function isComment(c: unknown): c is LineComment {
  const x = c as Partial<LineComment> | null;
  return (
    !!x &&
    typeof x.id === "string" &&
    typeof x.path === "string" &&
    (x.side === "old" || x.side === "new") &&
    typeof x.start === "number" &&
    typeof x.end === "number" &&
    typeof x.hash === "string" &&
    Array.isArray(x.quote) &&
    x.quote.every((q) => typeof q === "string") &&
    typeof x.note === "string" &&
    typeof x.createdAt === "number" &&
    (x.state === "pending" || x.state === "moved" || x.state === "outdated")
  );
}

let pruned = false;

/** Drop other threads' expired entries. Once per page load, on the first access. */
export function pruneLineComments(now: number = Date.now()): void {
  const store = storage();
  if (!store) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key === null || !key.startsWith(PREFIX)) continue;
      const entry = parseEntry(store.getItem(key));
      if (entry === null || now - entry.at > MAX_AGE_MS) stale.push(key);
    }
    for (const key of stale) store.removeItem(key);
  } catch {
    // enumeration can throw in locked-down storage; leave the entries be
  }
}

/** What each thread held when first read: stable, so a selector on it does not re-render. */
const seeded = new Map<string, readonly LineComment[]>();

function seed(threadId: string): readonly LineComment[] {
  const have = seeded.get(threadId);
  if (have) return have;
  if (!pruned) {
    pruned = true;
    pruneLineComments();
  }
  let comments: readonly LineComment[] = EMPTY;
  const store = storage();
  if (store) {
    try {
      const entry = parseEntry(store.getItem(PREFIX + threadId));
      if (entry && Date.now() - entry.at <= MAX_AGE_MS) comments = entry.comments;
      else if (entry) store.removeItem(PREFIX + threadId);
    } catch {
      // unreadable: start empty
    }
  }
  seeded.set(threadId, comments);
  return comments;
}

const useStore = create<{ byThread: Record<string, readonly LineComment[]> }>(() => ({ byThread: {} }));

function persist(threadId: string, comments: readonly LineComment[]): void {
  const store = storage();
  if (!store) return;
  try {
    if (comments.length === 0) store.removeItem(PREFIX + threadId);
    else store.setItem(PREFIX + threadId, JSON.stringify({ comments, at: Date.now() } satisfies Entry));
  } catch {
    // quota or private mode: the list in memory is still right
  }
}

/** A thread's pending comments. */
export function getLineComments(threadId: string): readonly LineComment[] {
  return useStore.getState().byThread[threadId] ?? seed(threadId);
}

export function useLineComments(threadId: string): readonly LineComment[] {
  return useStore((s) => s.byThread[threadId] ?? seed(threadId));
}

function write(threadId: string, next: readonly LineComment[]): void {
  useStore.setState((s) => ({ byThread: { ...s.byThread, [threadId]: next } }));
  persist(threadId, next);
}

let counter = 0;
const newId = () => `lc${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Quote lines for storage (cut for display) and their hash (over the full lines). */
function anchorOf(quote: readonly string[]): { hash: string; quote: string[] } {
  return { hash: blockHash(quote), quote: quote.map(cutQuoteLine) };
}

export function addLineComment(threadId: string, input: CommentInput): AddResult {
  const note = input.note.trim();
  if (note === "") return { ok: false, reason: "empty" };
  if (note.length > MAX_NOTE_CHARS) return { ok: false, reason: "note-too-long" };
  if (input.quote.length === 0 || input.quote.length > MAX_QUOTE_LINES) return { ok: false, reason: "range" };
  const list = getLineComments(threadId);
  if (list.length >= MAX_PENDING_COMMENTS) return { ok: false, reason: "full" };
  const comment: LineComment = {
    id: newId(),
    path: input.path,
    side: input.side,
    start: input.start,
    end: input.end,
    ...anchorOf(input.quote),
    note,
    createdAt: Date.now(),
    state: "pending",
  };
  write(threadId, [...list, comment]);
  return { ok: true, comment };
}

/** Change a saved comment's note, and its range when `range` is given (then it is anchored afresh). */
export function editLineComment(threadId: string, id: string, edit: { note: string; range?: { start: number; end: number; quote: readonly string[] } }): AddResult {
  const note = edit.note.trim();
  if (note === "") return { ok: false, reason: "empty" };
  if (note.length > MAX_NOTE_CHARS) return { ok: false, reason: "note-too-long" };
  if (edit.range && (edit.range.quote.length === 0 || edit.range.quote.length > MAX_QUOTE_LINES)) return { ok: false, reason: "range" };
  const list = getLineComments(threadId);
  const old = list.find((c) => c.id === id);
  if (!old) return { ok: false, reason: "range" };
  const comment: LineComment = edit.range
    ? { ...old, note, start: edit.range.start, end: edit.range.end, ...anchorOf(edit.range.quote), state: "pending" }
    : { ...old, note };
  write(threadId, list.map((c) => (c.id === id ? comment : c)));
  return { ok: true, comment };
}

export function removeLineComment(threadId: string, id: string): { comment: LineComment; index: number } | null {
  const list = getLineComments(threadId);
  const index = list.findIndex((c) => c.id === id);
  const comment = list[index];
  if (!comment) return null;
  write(threadId, list.filter((c) => c.id !== id));
  return { comment, index };
}

/** Put a removed comment back where it was (Undo). */
export function restoreLineComment(threadId: string, comment: LineComment, index: number): void {
  const list = getLineComments(threadId);
  if (list.some((c) => c.id === comment.id)) return;
  const next = [...list];
  next.splice(Math.min(index, next.length), 0, comment);
  write(threadId, next);
}

export function clearLineComments(threadId: string): void {
  if (getLineComments(threadId).length > 0) write(threadId, []);
}

/** Re-anchor one file's comments against its (re)loaded patch: same place, found elsewhere (`moved`), or `outdated`. */
export function reanchorFile(threadId: string, path: string, file: ParsedPatchFile): void {
  const list = getLineComments(threadId);
  let changed = false;
  const next = list.map((c) => {
    if (c.path !== path) return c;
    const found = locateComment(file, c);
    let updated: LineComment = c;
    if (found.state === "anchored") updated = c.state === "outdated" ? { ...c, state: "pending" } : c;
    else if (found.state === "moved") updated = c.start === found.start && c.end === found.end && c.state === "moved" ? c : { ...c, start: found.start, end: found.end, state: "moved" };
    else updated = c.state === "outdated" ? c : { ...c, state: "outdated" };
    if (updated !== c) changed = true;
    return updated;
  });
  if (changed) write(threadId, next);
}

/** A file that is not in the current scope's list: its comments are `outdated` (they come back when it does). */
export function markMissingFiles(threadId: string, present: ReadonlySet<string>): void {
  const list = getLineComments(threadId);
  if (!list.some((c) => !present.has(c.path) && c.state !== "outdated")) return;
  write(threadId, list.map((c) => (present.has(c.path) || c.state === "outdated" ? c : { ...c, state: "outdated" as const })));
}

/** A confirmed send: delete the comments whose block is in the sent text (matched by path, side, quote and note). */
export function consumeSent(threadId: string, text: string): void {
  const list = getLineComments(threadId);
  if (list.length === 0 || !text.includes("[review]")) return;
  const sent = new Set(reviewBlocksIn(text).map((f) => blockKey(f.block)));
  if (sent.size === 0) return;
  const kept = list.filter((c) => !sent.has(blockKey(c)));
  if (kept.length !== list.length) write(threadId, kept);
}

/** What the list shows for a comment against the draft: `in message` is derived each time, never stored. */
export function commentView(comment: LineComment, draft: string): CommentView {
  return isInMessage(comment, draft) ? "in message" : comment.state;
}

/** Test seam: forget what was read from storage and what was written. */
export function __resetLineComments(): void {
  seeded.clear();
  pruned = false;
  useStore.setState({ byThread: {} });
}
