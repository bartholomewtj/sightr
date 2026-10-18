// The bytes behind an item's attachments: `GET /api/v2/thread/:threadId/item/:itemId/attachment/:index`.
//
// The event store holds only references (turn-items.ts): a journal image is `j_<log>_<offset>_<n>_<row>`,
// a phone upload `u_<name>`. This route turns one back into bytes, and nothing else:
//  - the client names an ITEM and an INDEX, never a path or an offset. The reference is read from the
//    store, so only references the ingest itself wrote can be followed;
//  - a journal image is read from the thread's own log, or a `.jsonl` sibling of it (a /clear or /new
//    session in the same session directory), each contained by that directory after symlinks; the row
//    at the offset must parse and carry the id the reference names;
//  - an upload is a bridge-named file inside `<stateDir>/uploads`, contained after symlinks;
//  - rows and images are size-capped, and the served type is sniffed from the bytes (PNG, JPEG, GIF,
//    WebP only, never SVG), whatever the log or the name claimed;
//  - the response is `nosniff` with a CSP that allows nothing, so a navigated-to image is inert.

import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ChatAttachment, TurnItem } from "../../shared/v2/contracts.ts";
import { containedRealpath } from "../containment.ts";
import { base64Bytes, rowImages } from "../journal/images.ts";
import { secure, text } from "../responses.ts";
import { imageExtFromBytes, SNIFF_BYTES } from "../uploads.ts";
import type { ThreadStore } from "./store.ts";
import { logTag, parseJournalAttachmentId, shortHash, UPLOAD_NAME, uploadNameOf } from "./turn-items.ts";

export const ATTACHMENT_ROUTE = /^\/api\/v2\/thread\/([^/]+)\/item\/([^/]+)\/attachment\/(\d{1,4})$/;
/** The largest image served (decoded). T3's per-image cap. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** The longest log row read back to find an image in it. */
export const MAX_ROW_BYTES = 24 * 1024 * 1024;
/** Decoded journal images kept in memory, by total bytes (a phone scrolling back re-asks often). */
export const CACHE_BYTES = 32 * 1024 * 1024;
/** Nothing may load or run inside a served image; `sandbox` makes a navigated-to one an opaque origin. */
export const ATTACHMENT_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";

const IMAGE_TYPES: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export interface AttachmentDeps {
  store: Pick<ThreadStore, "getThread" | "getTurnItem" | "offsets">;
  /** `<stateDir>/uploads`, or null when uploads are not served. */
  uploadsDir: string | null;
  /** Caps (tests shrink them). */
  maxBytes?: number;
  maxRowBytes?: number;
  cacheBytes?: number;
}

export type AttachmentResult =
  | { ok: true; bytes: Uint8Array; contentType: string; immutable: boolean }
  | { ok: false; status: 404 | 413 | 415; reason: string };

const missing = (reason: string): AttachmentResult => ({ ok: false, status: 404, reason });

/** The attachments an item carries (a message's, a tool's output images). */
export function itemAttachments(item: TurnItem): readonly ChatAttachment[] {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "dynamic_tool":
      return item.attachments ?? [];
    default:
      return [];
  }
}

/** The served type of `bytes`, from their signature, or null when they are not an image Sightr serves. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const ext = imageExtFromBytes(bytes.subarray(0, SNIFF_BYTES));
  return ext === null ? null : (IMAGE_TYPES[ext] ?? null);
}

/** The log a journal attachment's tag names: the thread's own, or a `.jsonl` beside it. */
async function journalLog(deps: AttachmentDeps, threadId: string, tag: string): Promise<string | null> {
  const current = deps.store.offsets.get(threadId)?.path;
  if (!current) return null;
  if (logTag(current) === tag) return current;
  const dir = dirname(current);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".jsonl")) continue;
    const candidate = join(dir, name);
    if (logTag(candidate) !== tag) continue;
    return containedRealpath(candidate, dir);
  }
  return null;
}

/** The log line that starts at byte `at`, or why not. */
async function readRow(path: string, at: number, maxRowBytes: number): Promise<string | "too-large" | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  if (at >= size) return null;
  const start = at > 0 ? at - 1 : 0; // the byte before must end a line
  const end = Math.min(size, at + maxRowBytes);
  const bytes = new Uint8Array(await Bun.file(path).slice(start, end).arrayBuffer());
  const body = at > 0 ? bytes.subarray(1) : bytes;
  if (at > 0 && bytes[0] !== 0x0a) return null;
  const nl = body.indexOf(0x0a);
  if (nl === -1 && end < size) return "too-large";
  return new TextDecoder().decode(nl === -1 ? body : body.subarray(0, nl));
}

/** Decoded journal images, least recently used first. */
class ImageCache {
  private readonly map = new Map<string, Uint8Array>();
  private bytes = 0;
  constructor(private readonly cap: number) {}
  get(key: string): Uint8Array | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }
  set(key: string, value: Uint8Array): void {
    if (value.byteLength > this.cap) return;
    this.map.set(key, value);
    this.bytes += value.byteLength;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.cap) break;
      this.map.delete(k);
      this.bytes -= v.byteLength;
    }
  }
}

async function journalImage(deps: AttachmentDeps, cache: ImageCache, threadId: string, id: string): Promise<AttachmentResult> {
  const ref = parseJournalAttachmentId(id);
  if (ref === null) return missing("bad-reference");
  const path = await journalLog(deps, threadId, ref.tag);
  if (path === null) return missing("log-gone");
  const key = `${path}\0${ref.at}\0${ref.n}`;
  let bytes = cache.get(key);
  if (bytes === undefined) {
    const line = await readRow(path, ref.at, deps.maxRowBytes ?? MAX_ROW_BYTES);
    if (line === "too-large") return { ok: false, status: 413, reason: "row-too-large" };
    if (line === null) return missing("row-gone");
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return missing("row-gone");
    }
    const rowId = typeof row.uuid === "string" ? row.uuid : typeof row.id === "string" ? row.id : "";
    if (shortHash(rowId) !== ref.rowTag) return missing("row-changed");
    const image = rowImages(row)[ref.n];
    if (image === undefined) return missing("no-such-image");
    if (base64Bytes(image.data) > (deps.maxBytes ?? MAX_ATTACHMENT_BYTES)) return { ok: false, status: 413, reason: "image-too-large" };
    bytes = new Uint8Array(Buffer.from(image.data, "base64"));
    cache.set(key, bytes);
  }
  const contentType = sniffImageType(bytes);
  if (contentType === null) return { ok: false, status: 415, reason: "not-an-image" };
  return { ok: true, bytes, contentType, immutable: true };
}

async function uploadImage(deps: AttachmentDeps, attachment: ChatAttachment): Promise<AttachmentResult> {
  if (deps.uploadsDir === null) return missing("uploads-off");
  const name = attachment.id?.startsWith("u_") ? attachment.id.slice(2) : uploadNameOf(attachment.path);
  if (name === null || !UPLOAD_NAME.test(name)) return missing("not-an-upload");
  const real = await containedRealpath(join(deps.uploadsDir, name), deps.uploadsDir);
  if (real === null) return missing("upload-gone");
  let size: number;
  try {
    size = (await stat(real)).size;
  } catch {
    return missing("upload-gone");
  }
  if (size > (deps.maxBytes ?? MAX_ATTACHMENT_BYTES)) return { ok: false, status: 413, reason: "image-too-large" };
  const bytes = new Uint8Array(await Bun.file(real).arrayBuffer());
  const contentType = sniffImageType(bytes);
  if (contentType === null) return { ok: false, status: 415, reason: "not-an-image" };
  return { ok: true, bytes, contentType, immutable: false };
}

export interface AttachmentReader {
  load(threadId: string, itemId: string, index: number): Promise<AttachmentResult>;
}

export function createAttachmentReader(deps: AttachmentDeps): AttachmentReader {
  const cache = new ImageCache(deps.cacheBytes ?? CACHE_BYTES);
  return {
    async load(threadId, itemId, index) {
      if (deps.store.getThread(threadId) === null) return missing("no-such-thread");
      const item = deps.store.getTurnItem(itemId);
      if (item === null || item.threadId !== threadId) return missing("no-such-item");
      const attachment = itemAttachments(item)[index];
      if (attachment === undefined) return missing("no-such-attachment");
      if (attachment.id?.startsWith("j_")) return journalImage(deps, cache, threadId, attachment.id);
      return uploadImage(deps, attachment);
    },
  };
}

/** The HTTP answer for a load: the image with hardening headers, or a plain-text refusal. */
export function attachmentResponse(result: AttachmentResult): Response {
  if (!result.ok) return text(result.reason, result.status);
  const ext = Object.entries(IMAGE_TYPES).find(([, type]) => type === result.contentType)?.[0] ?? "img";
  return secure(
    new Response(result.bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        "content-type": result.contentType,
        "content-length": String(result.bytes.byteLength),
        // A journal row never changes (logs are append-only); an upload is swept after 48 h.
        "cache-control": result.immutable ? "private, max-age=31536000, immutable" : "private, max-age=3600",
        "content-disposition": `inline; filename="attachment.${ext}"`,
        "content-security-policy": ATTACHMENT_CSP,
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      },
    }),
  );
}
