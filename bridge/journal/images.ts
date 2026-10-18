// Images in a harness log, kept as REFERENCES, never as bytes.
//
// What exists (surveyed 18 Oct 2026, structure only): Claude writes base64 `image` blocks inside a
// `tool_result` (a Read of a PNG, a chrome screenshot, beside text blocks) and, rarely, at the top of
// a user row next to a "[Image #1]" text block (a paste). Pi writes `{type:"image", data, mimeType}`
// in a `toolResult` row's content (its `read` of an image) and can in a user message. Median 44 KB of
// base64, the largest seen ~1 MB, ~300 in one chrome-heavy session.
//
// Copying that into the event store would multiply it by every re-read, so the parser keeps only
// where the bytes are (the row's byte offset in the log, its id and the image's ordinal) and the v2
// attachment route (threads/attachments.ts) reads the one row back when a client asks. Both sides
// walk a row with {@link rowImages}, so the ordinal means the same thing to each.

import type { TranscriptImage } from "../../shared/wire.ts";

export interface RawImage {
  mimeType: string;
  /** Base64, as the harness wrote it. */
  data: string;
}

/** A content block's image, or null when it is not a base64 `image` block (which then takes no ordinal). */
export function blockImage(block: Record<string, unknown>): RawImage | null {
  if (block.type !== "image") return null;
  // Claude: { type: "image", source: { type: "base64", media_type, data } }
  const source = block.source as Record<string, unknown> | null | undefined;
  if (source && typeof source === "object") {
    if (source.type !== "base64" || typeof source.data !== "string") return null;
    return { mimeType: typeof source.media_type === "string" ? source.media_type : "", data: source.data };
  }
  // pi: { type: "image", data, mimeType }
  if (typeof block.data === "string") return { mimeType: typeof block.mimeType === "string" ? block.mimeType : "", data: block.data };
  return null;
}

/**
 * Every base64 image block in a log row, in order: the row's `message.content` blocks, descending one
 * level into a Claude `tool_result`'s content. A block that is not base64 (a URL source) is skipped
 * without taking an ordinal.
 */
export function rowImages(row: unknown): RawImage[] {
  if (row === null || typeof row !== "object") return [];
  const content = ((row as { message?: unknown }).message as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const out: RawImage[] = [];
  const visit = (blocks: unknown[], depth: number) => {
    for (const b of blocks) {
      if (b === null || typeof b !== "object") continue;
      const block = b as Record<string, unknown>;
      if (block.type === "image") {
        const img = blockImage(block);
        if (img) out.push(img);
      } else if (depth === 0 && block.type === "tool_result" && Array.isArray(block.content)) {
        visit(block.content, 1);
      }
    }
  };
  visit(content, 0);
  return out;
}

/** Decoded bytes of a base64 string of this length (padding counted out). */
export function base64Bytes(data: string): number {
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad);
}

/** The reference a parser keeps for the `n`th image of a row. */
export function imageRef(img: RawImage, ref: { at: number | undefined; row: string; n: number; name: string }): TranscriptImage {
  return {
    mimeType: img.mimeType,
    sizeBytes: base64Bytes(img.data),
    name: ref.name,
    ...(ref.at !== undefined ? { at: ref.at } : {}),
    row: ref.row,
    n: ref.n,
  };
}

/** The last segment of a path, for an image's label. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** A tool output image's label: the file the call read (`shot.png`), else "Image"; numbered when there are several. */
export function toolImageName(input: unknown, index: number, count: number): string {
  const o = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const path = typeof o.file_path === "string" ? o.file_path : typeof o.path === "string" ? o.path : "";
  const base = path.trim() !== "" ? baseName(path) : "Image";
  return count > 1 ? `${base} (${index + 1})` : base;
}

/**
 * A log's lines with each one's byte offset (`at`), when the text's own offset in the log is known.
 * The v2 ingest passes it (journal/store.ts `readSince`); without it every `at` is undefined.
 */
export function logLines(text: string, byteOffset: number | undefined): { line: string; at: number | undefined }[] {
  const lines = text.split("\n");
  if (byteOffset === undefined) return lines.map((line) => ({ line, at: undefined }));
  let at = byteOffset;
  return lines.map((line) => {
    const here = at;
    at += Buffer.byteLength(line, "utf8") + 1;
    return { line, at: here };
  });
}
