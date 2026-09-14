import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

// Uploaded attachments (pane-write-routes.ts uploadPane → `<stateDir>/uploads/`) are referenced by path in a
// message and then never needed again, so nothing deletes them. This sweep prunes anything older
// than the TTL. The decision — which names are stale — is a pure, tested function; the runner that
// stats the dir and unlinks takes an injectable fs surface so it too can be exercised without disk.

/** Uploads older than this are swept (Herdr already read them by path; they're single-use). */
export const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000; // 48 h
/** How often the runner re-sweeps after the startup pass. */
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

/**
 * How many leading bytes {@link imageExtFromBytes} needs. The longest signature we check is WebP's,
 * which is "RIFF" at 0 plus "WEBP" at 8 — twelve bytes.
 */
export const SNIFF_BYTES = 12;

/**
 * The upload allow-list, keyed by what the file IS rather than by what the client SAID it is.
 *
 * This used to be `IMAGE_EXT[file.type]` in pane-write-routes.ts — a bare-object lookup on the multipart part's
 * Content-Type, which the client writes. `IMAGE_EXT["__proto__"]` is Object.prototype and
 * `IMAGE_EXT["constructor"]` is Object; both are truthy, so both passed the check and stringified
 * into the saved filename (issue #9). Sniffing removes the lookup entirely, so there is no key left
 * to poison — that is why there is no `Object.hasOwn` guard here to go with the fix.
 *
 * The declared Content-Type is deliberately not consulted, not even to cross-check: once the bytes
 * have answered, a disagreement tells us only that the client's MIME detection is sloppy (phone
 * galleries are), and rejecting on it would refuse honest uploads.
 *
 * SVG is absent on purpose and must stay absent — it is script-bearing markup, not a raster image.
 */
const SIGNATURES: { ext: string; bytes: number[]; at: number }[] = [
  { ext: "png", at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }, // \x89PNG\r\n\x1a\n
  { ext: "jpg", at: 0, bytes: [0xff, 0xd8, 0xff] }, //                               SOI + first marker
  { ext: "gif", at: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, //                         "GIF8" (87a/89a)
  { ext: "webp", at: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, //                        "RIFF" …
  { ext: "webp", at: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, //                        … then "WEBP"
];

function matchesAt(head: Uint8Array, at: number, bytes: number[]): boolean {
  if (head.length < at + bytes.length) return false;
  return bytes.every((b, i) => head[at + i] === b);
}

/**
 * The file extension implied by a file's leading bytes, or null if they are not one of the four
 * image formats Sightr accepts. Pure — the whole decision, unit-tested.
 *
 * `head` should be the first {@link SNIFF_BYTES} bytes; a shorter buffer simply matches nothing.
 */
export function imageExtFromBytes(head: Uint8Array): string | null {
  // WebP needs both of its rows to match, so require every row carrying a given ext to hold.
  for (const ext of ["png", "jpg", "gif", "webp"]) {
    const rows = SIGNATURES.filter((s) => s.ext === ext);
    if (rows.every((r) => matchesAt(head, r.at, r.bytes))) return ext;
  }
  return null;
}

// ── Text attachments ─────────────────────────────────────────────────────────────────────────
//
// An image is identified by its BYTES, because every format Sightr takes has a signature and a lie
// about the type is a lie about the file. A text file has no signature at all, so the decision
// splits in two: the NAME says which text format it claims to be, and the BYTES only have to agree
// that it is text rather than a binary someone renamed. That is weaker than the image path on
// purpose, and it is enough — nothing here executes the file. It is saved on the host and the agent
// reads it as text by path, exactly as it already does with an image.
//
// The list is what a coding agent actually reads off a path: prose, config, data and source.

/** The text formats Sightr takes, as bare lowercase extensions. */
export const TEXT_EXTS: readonly string[] = [
  "md", "markdown", "txt", "json", "jsonl", "yaml", "yml", "toml", "csv", "tsv", "log",
  "xml", "html", "htm", "css", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "go", "rs",
  "sh", "bash", "ps1", "sql", "diff", "patch",
];

/**
 * How many leading bytes {@link looksLikeText} reads. A binary that survives four kilobytes without
 * one stray control byte is not a file this check was ever going to catch, and reading more buys
 * nothing for a decision the extension has already made.
 */
export const TEXT_SNIFF_BYTES = 4096;

// Control bytes a real text file DOES carry: tab, the three line/page breaks, and ESC — a `.log`
// with ANSI colour in it is still a log. Everything else below 0x20, plus DEL, means binary.
const TEXT_CONTROLS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b]);

/**
 * Whether a head of bytes is plausibly text rather than a binary wearing a `.md` name. Pure — the
 * whole decision, unit-tested. An empty file passes: nothing in it disagrees.
 */
export function looksLikeText(head: Uint8Array): boolean {
  for (const byte of head) {
    if (byte === 0x7f) return false;
    if (byte < 0x20 && !TEXT_CONTROLS.has(byte)) return false;
  }
  return true;
}

/**
 * The bare lowercase extension a filename claims, or null when it claims none. Pure. The last dot
 * wins, a leading dot is not an extension (`.gitignore` claims nothing), and anything that is not
 * plain alphanumerics is refused before it can reach a path — the saved filename is built from this
 * string, so it is a path boundary, not a formatting nicety.
 */
export function extFromName(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : null;
}

/**
 * THE WHOLE ACCEPT DECISION in one pure function: the extension to save this upload under, or null
 * to refuse it. Bytes first (an image is what its signature says, whatever it is called), then the
 * name against the text allow-list with the bytes holding a veto.
 */
export function uploadExt(name: string, head: Uint8Array): string | null {
  const image = imageExtFromBytes(head.subarray(0, SNIFF_BYTES));
  if (image !== null) return image;
  const claimed = extFromName(name);
  if (claimed === null || !TEXT_EXTS.includes(claimed)) return null;
  return looksLikeText(head) ? claimed : null;
}

/** Names whose mtime is older than `ttlMs` before `now`. Pure — the whole decision, unit-tested. */
export function filesToPrune(
  entries: { name: string; mtimeMs: number }[],
  now: number,
  ttlMs: number,
): string[] {
  return entries.filter((e) => now - e.mtimeMs > ttlMs).map((e) => e.name);
}

/** The slice of node:fs the sweep needs — injectable so the runner is testable with a fake. */
export interface UploadFs {
  readdir(dir: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  unlink(path: string): Promise<void>;
}

const realFs: UploadFs = { readdir, stat: (p) => stat(p), unlink };

/**
 * Ceiling on the total size of `<stateDir>/uploads`. Per-file is capped at 10 MB in pane-write-routes.ts, but
 * nothing bounded the sum: ~360 max-size uploads between two TTL sweeps filled the disk that the
 * bridge, Herdr and every agent share (issue #9).
 *
 * Deliberately a constant and not a SIGHTR_* env var — a config key is a new operator surface to
 * document, test and support, for a number that 20 max-size images already comfortably clears.
 */
export const MAX_UPLOADS_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Which existing uploads must go for `incomingBytes` to fit under `capBytes`, oldest first.
 *
 * Eviction rather than rejection: uploads are single-use and already TTL-swept, so "the oldest one
 * goes" is the semantics this directory already has. Refusing the upload instead would break the
 * operator's next image for up to 48 h with no visible cause. Pure — unit-tested.
 */
export function filesToEvict(
  entries: { name: string; mtimeMs: number; size: number }[],
  incomingBytes: number,
  capBytes: number,
): string[] {
  let total = entries.reduce((sum, e) => sum + e.size, 0) + incomingBytes;
  if (total <= capBytes) return [];
  const evict: string[] = [];
  for (const e of [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= capBytes) break;
    evict.push(e.name);
    total -= e.size;
  }
  return evict;
}

/**
 * Evict oldest uploads until `incomingBytes` fits under the cap. Returns whether it now fits — false
 * means every eviction failed (a permissions problem), and the caller should refuse the upload
 * rather than blow through the cap. Best-effort like sweepUploads: a missing dir is "empty", and a
 * file that vanishes or won't unlink is skipped.
 */
export async function makeRoomForUpload(
  dir: string,
  incomingBytes: number,
  capBytes: number = MAX_UPLOADS_TOTAL_BYTES,
  fs: UploadFs = realFs,
): Promise<boolean> {
  if (incomingBytes > capBytes) return false;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return true; // dir doesn't exist yet — nothing stored, so it fits
  }
  const entries: { name: string; mtimeMs: number; size: number }[] = [];
  for (const name of names) {
    try {
      const s = await fs.stat(join(dir, name));
      entries.push({ name, mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      /* vanished between readdir and stat — skip */
    }
  }
  let freed = 0;
  const wanted = filesToEvict(entries, incomingBytes, capBytes);
  for (const name of wanted) {
    const size = entries.find((e) => e.name === name)?.size ?? 0;
    try {
      await fs.unlink(join(dir, name));
      freed += size;
    } catch {
      /* already gone / unlink failed — it still counts against the cap */
    }
  }
  const stored = entries.reduce((sum, e) => sum + e.size, 0) - freed;
  return stored + incomingBytes <= capBytes;
}

/**
 * Stat `dir`, prune every file past the TTL, and return the names actually removed. Best-effort
 * throughout: a missing uploads dir (nothing uploaded yet) is not an error, and a file that vanishes
 * between readdir and stat/unlink (or a stat/unlink that fails) is skipped rather than aborting the
 * sweep. `now` and `fs` are injected for tests; the bridge calls it with the defaults.
 */
export async function sweepUploads(
  dir: string,
  ttlMs: number = UPLOAD_TTL_MS,
  now: number = Date.now(),
  fs: UploadFs = realFs,
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // uploads dir doesn't exist yet — nothing to sweep
  }
  const entries: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    try {
      const s = await fs.stat(join(dir, name));
      entries.push({ name, mtimeMs: s.mtimeMs });
    } catch {
      /* vanished between readdir and stat — skip */
    }
  }
  const removed: string[] = [];
  for (const name of filesToPrune(entries, now, ttlMs)) {
    try {
      await fs.unlink(join(dir, name));
      removed.push(name);
    } catch {
      /* already gone / unlink failed — skip */
    }
  }
  return removed;
}
