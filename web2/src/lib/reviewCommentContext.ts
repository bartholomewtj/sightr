// Pattern from T3 Code apps/web/src/reviewCommentContext.ts @ 3a4d118a518a (MIT, see THIRD_PARTY.md). T3 turns a diff
// comment into context for a Tiptap composer (a node in the editor with the quoted lines beside it). Sightr's
// composer is a plain textarea and the agent only ever reads the text typed into its pane, so a comment becomes
// plain, readable text in the draft: a header line, the quoted lines as a diff excerpt, and the note quoted
// with `> `. Only that idea is taken: no composer-store, editor, Effect or Pierre code.
//
// One block per comment, blocks separated by one blank line:
//
//   [review] src/lib/foo.ts:12-14 (new)
//   ```diff
//   +const a = 1;
//    const b = 2;
//   +const c = 3;
//   ```
//   > Rename `a` to say what it counts.
//
// It starts with `[`, never `/`, `!` or `#`, so it cannot open the slash menu or a harness mode on its first
// character. The same text renders as a code block in the timeline with no change.

export type ReviewSide = "old" | "new";

/** What the text of a block holds. The hash is not in the text. */
export interface ReviewBlock {
  path: string;
  start: number;
  end: number;
  side: ReviewSide;
  outdated: boolean;
  /** Diff excerpt lines, each prefixed `+`, `-` or a space; a line over 160 characters is cut with `…`. */
  quote: string[];
  note: string;
}

/** Per message. Counted by parsing the draft, so a block typed or pasted by hand counts too. */
export const MAX_COMMENTS_PER_MESSAGE = 10;
export const MAX_BLOCK_CHARS_PER_MESSAGE = 12_000;
/** Per comment. */
export const MAX_QUOTE_LINES = 12;
export const MAX_QUOTE_LINE_CHARS = 160;
export const MAX_NOTE_CHARS = 1_000;

const ELLIPSIS = "…";

/** FNV-1a (32 bit) as 8 hex digits: the hash a comment is anchored by. Over the full quoted lines, prefixes included. */
export function blockHash(lines: readonly string[]): string {
  let h = 0x811c9dc5;
  const text = lines.join("\n");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** A quoted line as the block shows it: the prefix kept, the text cut to 160 characters with `…`. */
export function cutQuoteLine(line: string): string {
  const prefix = line.slice(0, 1);
  const text = line.slice(1);
  return text.length > MAX_QUOTE_LINE_CHARS ? prefix + text.slice(0, MAX_QUOTE_LINE_CHARS - 1) + ELLIPSIS : line;
}

function fenceFor(quote: readonly string[]): string {
  let longest = 0;
  for (const line of quote) for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** The text one comment adds to a draft. Deterministic; no trailing newline. */
export function formatReviewBlock(block: Pick<ReviewBlock, "path" | "start" | "end" | "side" | "quote" | "note"> & { outdated?: boolean }): string {
  const range = block.end > block.start ? `${block.start}-${block.end}` : `${block.start}`;
  const header = `[review] ${block.path}:${range} (${block.side}${block.outdated ? ", outdated" : ""})`;
  const quote = block.quote.map(cutQuoteLine);
  const fence = fenceFor(quote);
  const note = block.note.replace(/\r\n?/g, "\n").split("\n").map((l) => (l === "" ? ">" : `> ${l}`));
  return [header, `${fence}diff`, ...quote, fence, ...note].join("\n");
}

const HEADER = /^\[review\] (.+):(\d+)(?:-(\d+))? \((old|new)(, outdated)?\)$/;
const OPEN_FENCE = /^(`{3,})diff$/;
const QUOTE_LINE = /^[+\- ]|^$/;

export type ReviewSegment = { type: "text"; text: string } | { type: "review"; block: ReviewBlock; raw: string };

/**
 * Split a message into the user's own text and the review blocks `formatReviewBlock` wrote. Tolerates `\r\n`; needs
 * the header at a line start, then the fence, then the `>` run. Anything else, a header with no fence, a fence
 * never closed, a block with no note, stays the user's text. Segments joined with newlines give the text back
 * (modulo `\r`), and a `raw` is the block's own lines.
 */
export function parseReviewBlocks(text: string): ReviewSegment[] {
  const lines = text.split(/\r?\n/);
  const out: ReviewSegment[] = [];
  let plain: string[] = [];
  const flush = () => {
    if (plain.length > 0) out.push({ type: "text", text: plain.join("\n") });
    plain = [];
  };
  let i = 0;
  while (i < lines.length) {
    const found = blockAt(lines, i);
    if (!found) {
      plain.push(lines[i] as string);
      i++;
      continue;
    }
    flush();
    out.push({ type: "review", block: found.block, raw: lines.slice(i, found.next).join("\n") });
    i = found.next;
  }
  flush();
  return out;
}

function blockAt(lines: string[], i: number): { block: ReviewBlock; next: number } | null {
  const header = HEADER.exec(lines[i] as string);
  if (!header) return null;
  const fence = OPEN_FENCE.exec(lines[i + 1] ?? "")?.[1];
  if (!fence) return null;
  let close = -1;
  for (let j = i + 2; j < lines.length; j++) {
    if (lines[j] === fence) {
      close = j;
      break;
    }
  }
  if (close < 0) return null;
  const quote = lines.slice(i + 2, close);
  if (quote.length === 0 || !quote.every((l) => QUOTE_LINE.test(l))) return null;
  let next = close + 1;
  const note: string[] = [];
  while (next < lines.length && (lines[next] === ">" || (lines[next] as string).startsWith("> "))) {
    note.push(lines[next] === ">" ? "" : (lines[next] as string).slice(2));
    next++;
  }
  if (note.length === 0) return null;
  const start = Number(header[2]);
  const end = header[3] === undefined ? start : Number(header[3]);
  if (end < start) return null;
  return {
    block: { path: header[1] as string, start, end, side: header[4] as ReviewSide, outdated: header[5] !== undefined, quote, note: note.join("\n") },
    next,
  };
}

/** The blocks in a message, in order. */
export function reviewBlocksIn(text: string): { block: ReviewBlock; raw: string }[] {
  return parseReviewBlocks(text).flatMap((s) => (s.type === "review" ? [{ block: s.block, raw: s.raw }] : []));
}

/** What identifies a comment inside a block: the range may have moved since it was written, and `outdated` is a flag. */
export function blockKey(b: Pick<ReviewBlock, "path" | "side" | "quote" | "note">): string {
  return [b.path, b.side, b.quote.map(cutQuoteLine).join("\n"), b.note].join("\u0000");
}

/** How much of a draft the review blocks take. */
export function reviewUsage(text: string): { count: number; chars: number } {
  const found = reviewBlocksIn(text);
  return { count: found.length, chars: found.reduce((n, f) => n + f.raw.length, 0) };
}

/** Whether the comment's block is in the draft already (derived each time, never stored). */
export function isInMessage(comment: Pick<ReviewBlock, "path" | "side" | "quote" | "note">, text: string): boolean {
  if (!text.includes("[review]")) return false;
  const key = blockKey(comment);
  return reviewBlocksIn(text).some((f) => blockKey(f.block) === key);
}

/**
 * Append blocks to a draft, one blank line between. Stops before a per-message limit (10 blocks, 12,000
 * characters of blocks). Returns the new text and how many went in; the rest wait in the basket.
 */
export function appendReviewBlocks(draft: string, blocks: readonly string[]): { text: string; added: number } {
  const used = reviewUsage(draft);
  let count = used.count;
  let chars = used.chars;
  let text = draft;
  let added = 0;
  for (const block of blocks) {
    if (count + 1 > MAX_COMMENTS_PER_MESSAGE || chars + block.length > MAX_BLOCK_CHARS_PER_MESSAGE) break;
    text = text.trim() === "" ? block : `${text.replace(/\s+$/, "")}\n\n${block}`;
    count++;
    chars += block.length;
    added++;
  }
  return { text, added };
}
