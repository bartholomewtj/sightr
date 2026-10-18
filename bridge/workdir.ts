// Work-directory browser (reads plus delete/save of an editable text file). It is opt-in via SIGHTR_WORK_ROOT;
// every path is contained after symlink resolution and the client never sees an absolute path.
// Dot names are refused deliberately: a simple fail-closed rule is safer than an allow-list.
import { readdir, realpath, stat, lstat, unlink, open } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import type { AuditLog } from "./audit.ts";
import { containedRealpath } from "./containment.ts";
import type * as Wire from "../shared/wire.ts";
// The bridge's file naming predates the shared contract; retain those import paths for callers.
type WorkdirEntry = Wire.FileEntry;
type WorkdirSearchResult = Wire.FileSearchResult;
type WorkdirListing = Extract<Wire.FilesResponse, { kind: "dir" }>;
type WorkdirFile = Extract<Wire.FilesResponse, { kind: "file" }>;
import { planZip, zipStream, zipName } from "./workdir-zip.ts";
import { createFolderGit, MAX_PANE_IDS } from "./workdir-git.ts";
import { createFolderReview, type FileQuery } from "./workdir-review.ts";
import { notModified } from "./http-cache.ts";
import { REVIEW_PATHS } from "../shared/v2/review.ts";
import type { RunReview } from "./threads/checkpoints.ts";

export const MAX_ENTRIES = 2000;
export const PREVIEW_CAP_BYTES = 512 * 1024;
export const DOWNLOAD_CAP_BYTES = 100 * 1024 * 1024;
export const SEARCH_MAX_DEPTH = 8;
export const SEARCH_MAX_RESULTS = 200;
export const SEARCH_MAX_DIRS = 5000;
/** Stop walking after this long and return what was found (truncated), so a wide work root answers
 *  well inside the client's 10 s GET timeout instead of being aborted with nothing to show. */
export const SEARCH_BUDGET_MS = 6000;
export const BINARY_SNIFF_BYTES = 8192;

/**
 * MIME types Chrome on a phone will display rather than download. `/api/files/open` uses this
 * map and nothing else — never `h.contentTypes`, which includes text/html for the static UI.
 * HTML and SVG are allowed only with `BROWSER_HTML_CSP` (unique origin). Scripts may run so a
 * page can load sibling `.js`; the page is not Sightr's origin. Never add `allow-same-origin`.
 * SVG as `<img>` does not run scripts; the CSP is for Open in browser on the SVG itself.
 * Open URLs are `/api/files/open/<rel>` so a page's relative images and scripts resolve as siblings.
 * `?path=` on the exact `/api/files/open` route still works.
 */
const BROWSER_OPEN_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpe": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

/** Unique origin. Scripts may run. Never add `allow-same-origin`. */
export const BROWSER_HTML_CSP =
  "sandbox allow-scripts; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function browserOpenCsp(type: string): string | undefined {
  return type.startsWith("text/html") || type.startsWith("image/svg+xml") ? BROWSER_HTML_CSP : undefined;
}

export function browserOpenType(name: string): string | null {
  return BROWSER_OPEN_TYPES[extname(name).toLowerCase()] ?? null;
}

/** In-app player for image/audio/video. PDF and text stay out — PDF is flaky in an iOS iframe. */
export function browserEmbedKind(name: string): "image" | "video" | "audio" | undefined {
  const type = browserOpenType(name);
  if (!type) return undefined;
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return undefined;
}

export function isRefusedName(name: string): boolean {
  if (name.startsWith(".")) return true;
  const lower = name.toLowerCase();
  if (["node_modules", "config", "__pycache__", "venv", "target", "vendor", "adws", "thumbs.db", "desktop.ini"].includes(lower)) return true;
  return /\.(pem|key|pfx|p12|kdbx|keystore|jks)$/i.test(name) || /^id_(rsa|ecdsa|ed25519)/i.test(name);
}

export function parseRelPath(raw: string): string[] | null {
  if (raw.length > 1024 || /[\u0000-\u001f\\]/.test(raw) || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  if (raw === "") return [];
  const parts = raw.split("/");
  if (parts.length > 32 || parts.some((p) => !p || p === "." || p === ".." || p.includes(":") || isRefusedName(p))) return null;
  return parts;
}

const FILES_OPEN = "/api/files/open";
const FILES_OPEN_PREFIX = "/api/files/open/";

export function isFilesOpenPath(pathname: string): boolean {
  return pathname === FILES_OPEN || pathname.startsWith(FILES_OPEN_PREFIX);
}

/** Rel segments for an open URL, or null if the path is refused or empty. */
export function parseFilesOpenRel(url: URL): string[] | null {
  let raw: string | null;
  if (url.pathname.startsWith(FILES_OPEN_PREFIX)) {
    try { raw = decodeURIComponent(url.pathname.slice(FILES_OPEN_PREFIX.length)); }
    catch { return null; }
  } else if (url.pathname === FILES_OPEN) {
    raw = url.searchParams.get("path") ?? "";
  } else {
    return null;
  }
  const segs = parseRelPath(raw);
  return segs && segs.length > 0 ? segs : null;
}

/** `abs` as a Files rel path (`""` is the root), or null when it is outside the root or refused. */
export async function relInRoot(root: string, abs: string): Promise<string | null> {
  const real = await containedRealpath(abs, root);
  const realRoot = await realpath(root).catch(() => null);
  if (real === null || realRoot === null) return null;
  const rel = relative(realRoot, real).split(sep).join("/");
  return parseRelPath(rel) === null ? null : rel;
}

export async function resolveInRoot(root: string, segs: string[]): Promise<string | null> {
  return containedRealpath(join(root, ...segs), root);
}

export const RESOLVE_MAX_CHARS = 4096;

function lexicallyInside(path: string, root: string): boolean {
  const a = resolve(path), b = resolve(root);
  if (process.platform === "win32") { const al = a.toLowerCase(), bl = b.toLowerCase(); return al === bl || al.startsWith(bl.endsWith(sep) ? bl : bl + sep); }
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * `/api/files/resolve`: a path as an agent printed it (absolute, git-bash `/c/...` on Windows, or
 * relative to the pane's folder) as a Files rel path. Outside the root and hidden names are refused
 * on the string alone, before the filesystem is touched, so a refusal never says whether something
 * outside exists; inside the root, absent and symlinked-out are the same "not-found" (containment.ts).
 */
export async function resolveFilePath(workRoot: string, raw: string, cwd: string | null): Promise<Wire.FileResolveResponse> {
  let p = raw.trim();
  if (!p || p.length > RESOLVE_MAX_CHARS || /[\u0000-\u001f]/.test(p) || /^[A-Za-z]:(?![\\/])/.test(p)) return { path: null, reason: "bad-path" };
  if (process.platform === "win32") { const m = /^\/([A-Za-z])(\/.*)?$/.exec(p); if (m) p = `${m[1]!.toUpperCase()}:${m[2] ?? "/"}`; }
  let abs: string;
  if (isAbsolute(p)) abs = resolve(p);
  else if (cwd === null) return { path: null, reason: "no-folder" };
  else abs = resolve(cwd, p);
  const realRoot = await realpath(workRoot).catch(() => null);
  const via = [resolve(workRoot), ...(realRoot ? [realRoot] : [])].find((r) => lexicallyInside(abs, r));
  if (!via) return { path: null, reason: "outside-root" };
  const lexical = relative(via, abs).split(sep).filter(Boolean);
  if (lexical.some((seg) => isRefusedName(seg))) return { path: null, reason: "hidden" };
  const rel = await relInRoot(workRoot, abs);
  if (rel === null) return { path: null, reason: "not-found" };
  const real = await resolveInRoot(workRoot, rel === "" ? [] : rel.split("/"));
  const info = real ? await stat(real).catch(() => null) : null;
  if (!info || (!info.isFile() && !info.isDirectory())) return { path: null, reason: "not-found" };
  return { path: rel, kind: info.isDirectory() ? "dir" : "file" };
}

export interface WorkdirHelpers {
  guard: (req: Request, cfg: Config, level: "read" | "write") => Response | null;
  json: (data: unknown, encoding: string | null, status?: number) => Response;
  text: (body: string, status: number) => Response;
  failureText: (context: string, err: unknown) => string;
  secure: (res: Response) => Response;
  contentTypes: Record<string, string>;
  paneCwd: (paneId: string) => string | null;
  /** T30's run scope on the review patch and contents routes; absent (v2 off) they answer 501. */
  runReview?: RunReview | null;
  requireJsonBody: (req: Request) => Response | null;
  auditFor: (req: Request) => AuditLog;
  unlink?: (path: string) => Promise<void>;
  lstat?: (path: string) => Promise<import("node:fs").Stats>;
  writeNamed?: (path: string, data: string) => Promise<void>;
}

const notFound = (h: WorkdirHelpers) => h.json({ error: "not found" }, null, 404);

export type EditableTarget = { namedPath: string; rel: string; name: string; size: number; mtimeMs: number };

export async function sniffBinary(absPath: string, size: number): Promise<boolean> {
  const sniff = new Uint8Array(await Bun.file(absPath).slice(0, Math.min(size, BINARY_SNIFF_BYTES)).arrayBuffer());
  if (sniff.includes(0)) return true;
  try { new TextDecoder("utf-8", { fatal: true }).decode(sniff); } catch { return true; }
  return false;
}

export async function resolveEditableFile(root: string, segs: string[], io?: { lstat?: (path: string) => Promise<import("node:fs").Stats> }): Promise<EditableTarget | null> {
  const namedPath = join(root, ...segs);
  let info;
  try { info = await (io?.lstat ?? lstat)(namedPath); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!info.isFile()) return null;
  if (!await containedRealpath(namedPath, root)) return null;
  if (await sniffBinary(namedPath, info.size)) return null;
  return { namedPath, rel: relPath(segs), name: segs[segs.length - 1]!, size: info.size, mtimeMs: info.mtimeMs };
}

export function isBusyUnlinkCode(code: string | undefined): boolean { return code === "EPERM" || code === "EBUSY" || code === "EACCES"; }

async function writeNamedNoFollow(path: string, data: string): Promise<void> {
  const fh = process.platform === "win32"
    ? await open(path, "r+")
    : await open(path, constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0));
  try {
    if (process.platform === "win32") await fh.truncate(0);
    await fh.writeFile(data, { encoding: "utf8" });
  } finally { await fh.close(); }
}

async function saveEditableFile(cfg: Config, h: WorkdirHelpers, req: Request): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  const bad = h.requireJsonBody(req); if (bad) return bad;
  let body: unknown;
  try { body = await req.json(); } catch { return h.text("bad body", 400); }
  if (!body || typeof body !== "object") return h.text("bad body", 400);
  const rec = body as { path?: unknown; text?: unknown; mtimeMs?: unknown };
  if (typeof rec.path !== "string") return h.text("path required", 400);
  if (typeof rec.text !== "string") return h.text("text required", 400);
  if (typeof rec.mtimeMs !== "number" || !Number.isFinite(rec.mtimeMs)) return h.text("mtimeMs required", 400);
  const segs = parseRelPath(rec.path); if (!segs) return notFound(h);
  try {
    const target = await resolveEditableFile(cfg.workRoot, segs, h);
    if (!target) return notFound(h);
    if (target.size > PREVIEW_CAP_BYTES || Buffer.byteLength(rec.text, "utf8") > PREVIEW_CAP_BYTES) return h.json({ error: "file too large" }, ae, 413);
    if (target.mtimeMs !== rec.mtimeMs) return h.json({ ok: false, error: "file changed" }, ae, 409);
    try { await (h.writeNamed ?? writeNamedNoFollow)(target.namedPath, rec.text); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "ENOENT") return notFound(h);
      if (isBusyUnlinkCode(code)) return h.json({ ok: false, error: "file is in use" }, ae, 409);
      return h.text(h.failureText("files", err), 500);
    }
    let info;
    try { info = await (h.lstat ?? lstat)(target.namedPath); } catch (err) { return h.text(h.failureText("files", err), 500); }
    h.auditFor(req).record({
      action: "files.save",
      detail: { path: target.rel, name: target.name, size: info.size },
    });
    return h.json({ ok: true, mtimeMs: info.mtimeMs, size: info.size }, ae);
  } catch (err) { return h.text(h.failureText("files", err), 500); }
}

function relPath(segs: string[]): string { return segs.join("/"); }

async function inspect(root: string, segs: string[]): Promise<WorkdirListing | WorkdirFile | null> {
  const real = await resolveInRoot(root, segs);
  if (!real) return null;
  const info = await stat(real).catch(() => null);
  if (!info) return null;
  const path = relPath(segs);
  if (info.isDirectory()) {
    const raw = await readdir(real, { withFileTypes: true });
    const eligible = raw.filter((e) => !isRefusedName(e.name) && (e.isDirectory() || e.isFile()));
    const truncated = eligible.length > MAX_ENTRIES;
    eligible.sort((a, b) => Number(!a.isDirectory()) - Number(!b.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    const entries: WorkdirEntry[] = [];
    for (const e of eligible.slice(0, MAX_ENTRIES)) {
      const s = await stat(join(real, e.name)).catch(() => null);
      if (!s) continue;
      // `.git` itself is a refused name and never listed; this flag is the only way the tree learns a folder is a checkout.
      if (e.isDirectory()) { const repo = await stat(join(real, e.name, ".git")).then(() => true, () => false); entries.push({ name: e.name, kind: "dir", mtimeMs: s.mtimeMs, ...(repo ? { repo: true } : {}) }); } else entries.push({ name: e.name, kind: "file", size: s.size, mtimeMs: s.mtimeMs });
    }
    return { kind: "dir", path, entries, truncated };
  }
  if (!info.isFile()) return null;
  const name = basename(real);
  const openInBrowser = browserOpenType(name) !== null;
  const embed = browserEmbedKind(name);
  const file = Bun.file(real);
  const binary = await sniffBinary(real, info.size);
  const media = { openInBrowser, ...(embed ? { embed } : {}) };
  if (binary) return { kind: "file", path, name, size: info.size, mtimeMs: info.mtimeMs, binary: true, ...media };
  return { kind: "file", path, name, size: info.size, mtimeMs: info.mtimeMs, text: await file.slice(0, PREVIEW_CAP_BYTES).text(), truncated: info.size > PREVIEW_CAP_BYTES, binary: false, ...media };
}

function fileBytes(h: WorkdirHelpers, real: string, size: number, type: string, disposition: "attachment" | "inline"): Response {
  const name = basename(real);
  const fallback = name.replace(/[^\x20-\x7e]|["\\\u0000-\u001f]/g, "_");
  const headers: Record<string, string> = {
    "content-type": type,
    "content-disposition": `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "content-length": String(size),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  const csp = disposition === "inline" ? browserOpenCsp(type) : undefined;
  if (csp) headers["content-security-policy"] = csp;
  return h.secure(new Response(Bun.file(real), { headers }));
}

export async function search(root: string, q: string, budgetMs = SEARCH_BUDGET_MS, now: () => number = Date.now): Promise<{ q: string; results: WorkdirSearchResult[]; truncated: boolean }> {
  const results: WorkdirSearchResult[] = []; let truncated = false; let dirs = 0;
  const queue: { path: string[]; depth: number }[] = [{ path: [], depth: 0 }];
  const deadline = now() + budgetMs;
  while (queue.length && !truncated) {
    const current = queue.shift()!; dirs++; if (dirs > SEARCH_MAX_DIRS || now() > deadline) { truncated = true; break; }
    const real = await resolveInRoot(root, current.path); if (!real) continue;
    const entries = await readdir(real, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (isRefusedName(e.name) || (!e.isDirectory() && !e.isFile())) continue;
      const path = [...current.path, e.name];
      if (e.name.toLowerCase().includes(q.toLowerCase())) { results.push({ path: relPath(path), name: e.name, kind: e.isDirectory() ? "dir" : "file" }); if (results.length >= SEARCH_MAX_RESULTS) { truncated = true; break; } }
      if (e.isDirectory() && current.depth < SEARCH_MAX_DEPTH) queue.push({ path, depth: current.depth + 1 });
    }
  }
  return { q, results, truncated };
}

export function createWorkdir(cfg: Config, h: WorkdirHelpers) {
  const enabled = cfg.workRoot !== "";
  const folderGit = createFolderGit(cfg.workRoot);
  const folderReview = createFolderReview(cfg.workRoot);
  /** A review answer: `diffHash` doubles as the ETag, and a matching If-None-Match gets an empty 304. */
  const reviewReply = (req: Request, data: { available?: boolean; diffHash?: string; notModified?: true }): Response => {
    // Only an answer that carries a hash is tagged: the branches route has none, and must not send `ETag: "undefined"`.
    const etag = typeof data.diffHash === "string" && (data.notModified === true || data.available === true) ? `"${data.diffHash}"` : null;
    if (etag !== null && (data.notModified === true || notModified(req.headers.get("if-none-match"), etag))) return h.secure(new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } }));
    const res = h.json(data, req.headers.get("accept-encoding"));
    res.headers.set("cache-control", "no-store"); if (etag !== null) res.headers.set("etag", etag);
    return res;
  };
  const owns = (pathname: string) => enabled && (pathname === "/api/files" || pathname.startsWith("/api/files/"));
  async function handle(req: Request, url: URL): Promise<Response> {
    if (url.pathname === "/api/files/delete") {
      if (req.method !== "POST") return h.text("method not allowed", 405);
      const gate = h.guard(req, cfg, "write"); if (gate) return gate;
      const badJson = h.requireJsonBody(req); if (badJson) return badJson;
      let body: unknown;
      try { body = await req.json(); } catch { return h.text("bad body", 400); }
      if (!body || typeof body !== "object" || typeof (body as { path?: unknown }).path !== "string") return h.text("path required", 400);
      const segs = parseRelPath((body as { path: string }).path);
      if (!segs) return notFound(h);
      try {
        const target = await resolveEditableFile(cfg.workRoot, segs, h);
        if (!target) return notFound(h);
        try { await (h.unlink ?? unlink)(target.namedPath); } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (isBusyUnlinkCode(code)) return h.json({ ok: false, error: "file is in use" }, req.headers.get("accept-encoding"), 409);
          if (code === "ENOENT") return notFound(h);
          return h.text(h.failureText("files", err), 500);
        }
        h.auditFor(req).record({
          action: "files.delete",
          detail: { path: target.rel, name: target.name },
        });
        return h.json({ ok: true }, req.headers.get("accept-encoding"));
      } catch (err) { return h.text(h.failureText("files", err), 500); }
    }
    if (url.pathname === "/api/files/save") {
      if (req.method !== "POST") return h.text("method not allowed", 405);
      const gate = h.guard(req, cfg, "write"); if (gate) return gate;
      return saveEditableFile(cfg, h, req);
    }
    const gate = h.guard(req, cfg, "read"); if (gate) return gate;
    if (req.method !== "GET" && req.method !== "HEAD") return h.text("method not allowed", 405);
    try {
      if (url.pathname === "/api/files/git") {
        const segs = parseRelPath(url.searchParams.get("path") ?? "");
        if (!segs) return notFound(h);
        const real = await resolveInRoot(cfg.workRoot, segs);
        if (!real) return notFound(h);
        const info = await stat(real).catch(() => null);
        if (!info?.isDirectory()) return notFound(h);
        const panes = url.searchParams.getAll("pane").slice(0, MAX_PANE_IDS).map((paneId) => ({ paneId, cwd: h.paneCwd(paneId) })).filter((p): p is { paneId: string; cwd: string } => p.cwd !== null);
        const res = h.json(await folderGit.inspect(real, panes), req.headers.get("accept-encoding"));
        res.headers.set("cache-control", "no-store");
        return res;
      }
      if (url.pathname === "/api/files/git/diff") {
        // Read-only history diffs for the repo around a Files folder: one commit, or the branch range.
        const segs = parseRelPath(url.searchParams.get("path") ?? "");
        if (!segs) return notFound(h);
        const real = await resolveInRoot(cfg.workRoot, segs);
        if (!real || !(await stat(real).catch(() => null))?.isDirectory()) return notFound(h);
        const scope = url.searchParams.get("scope");
        if (scope !== "commit" && scope !== "branch") return h.text("scope must be commit or branch", 400);
        const q = scope === "commit" ? { scope, sha: url.searchParams.get("sha") ?? "" } as const : { scope } as const;
        const res = h.json(await folderGit.diff(real, q), req.headers.get("accept-encoding"));
        res.headers.set("cache-control", "no-store");
        return res;
      }
      if ((url.pathname === REVIEW_PATHS.list || url.pathname === REVIEW_PATHS.patch || url.pathname === REVIEW_PATHS.contents) && url.searchParams.get("scope") === "run") {
        // A thread run's checkpoint range (T30). No `path`: the checkpoint row names the repo, so an archived
        // thread's run works with its pane gone. The file list is `Run.checkpoint.files` on the thread stream.
        if (!h.runReview) return h.json({ error: "run scope not available" }, req.headers.get("accept-encoding"), 501);
        if (url.pathname === REVIEW_PATHS.list) return h.text("the run's file list is on the thread stream (Run.checkpoint)", 400);
        const threadId = url.searchParams.get("threadId") ?? "", runId = url.searchParams.get("runId") ?? "";
        if (!/^[\w.:-]{1,128}$/.test(threadId) || !/^[\w.:-]{1,128}$/.test(runId)) return h.text("threadId and runId required", 400);
        const fileSegs = parseRelPath(url.searchParams.get("file") ?? "");
        if (!fileSegs?.length) return notFound(h);
        const w = url.searchParams.get("w") ?? url.searchParams.get("ignoreWhitespace") ?? "0";
        if (w !== "0" && w !== "1") return h.text("w must be 0 or 1", 400);
        const file = fileSegs.join("/");
        return reviewReply(req, url.pathname === REVIEW_PATHS.patch ? await h.runReview.patch({ threadId, runId, file, w: w === "1" }) : await h.runReview.contents({ threadId, runId, file }));
      }
      if (url.pathname === REVIEW_PATHS.list || url.pathname === REVIEW_PATHS.patch || url.pathname === REVIEW_PATHS.contents || url.pathname === REVIEW_PATHS.branches) {
        // Read-only review data for the repo around a Files folder (T26): a file list, one patch, one file's
        // whole contents, the branches for the base picker. Same folder rule as the Git tab; `file`/`oldFile`
        // are repo-root-relative and get the Files refusal list per segment (a hidden name is a 404).
        const segs = parseRelPath(url.searchParams.get("path") ?? "");
        if (!segs) return notFound(h);
        const real = await resolveInRoot(cfg.workRoot, segs);
        if (!real || !(await stat(real).catch(() => null))?.isDirectory()) return notFound(h);
        if (url.pathname === REVIEW_PATHS.branches) return reviewReply(req, await folderReview.branches(real));
        const scope = url.searchParams.get("scope");
        if (scope !== "working-tree" && scope !== "branch") return h.text("scope must be working-tree, branch or run", 400);
        const ignoreWhitespace = url.searchParams.get("ignoreWhitespace") === "1";
        if (url.pathname === REVIEW_PATHS.list) {
          const base = url.searchParams.get("base");
          return reviewReply(req, await folderReview.list(real, { scope, ...(base === null ? {} : { base }), ignoreWhitespace, ifNoneMatch: req.headers.get("if-none-match") }));
        }
        const file = url.searchParams.get("file"), oldFile = url.searchParams.get("oldFile");
        const fileSegs = file === null ? null : parseRelPath(file), oldSegs = oldFile === null ? [] : parseRelPath(oldFile);
        if (!fileSegs?.length || !oldSegs) return notFound(h);
        const q: FileQuery = { scope, file: fileSegs.join("/"), ...(oldFile === null ? {} : { oldFile: oldSegs.join("/") }), from: url.searchParams.get("from") ?? "", to: url.searchParams.get("to") ?? "", ignoreWhitespace };
        return reviewReply(req, url.pathname === REVIEW_PATHS.patch ? await folderReview.patch(real, q) : await folderReview.contents(real, q));
      }
      if (url.pathname === "/api/files/resolve") {
        // A path an agent printed (absolute, or relative to the pane's folder) as a Files rel path, so
        // any file mentioned anywhere can open in Files. Containment is relInRoot's; the client still
        // never sees an absolute path, and refusals are decided before the filesystem is touched.
        const res = h.json(await resolveFilePath(cfg.workRoot, url.searchParams.get("path") ?? "", h.paneCwd(url.searchParams.get("pane") ?? "")), req.headers.get("accept-encoding"));
        res.headers.set("cache-control", "no-store");
        return res;
      }
      if (url.pathname === "/api/files/pane-folder") {
        // The v2 Files and Git tabs start at the thread's folder (T13). The client never sees the
        // absolute cwd: the bridge answers with the contained rel path, or null when it is outside.
        const cwd = h.paneCwd(url.searchParams.get("pane") ?? "");
        const res = h.json({ path: cwd === null ? null : await relInRoot(cfg.workRoot, cwd) }, req.headers.get("accept-encoding"));
        res.headers.set("cache-control", "no-store");
        return res;
      }
      if (url.pathname === "/api/files/search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        return h.json(q.length < 2 ? { q, results: [], truncated: false } : await search(cfg.workRoot, q), req.headers.get("accept-encoding"));
      }
      if (url.pathname === "/api/files/download" || isFilesOpenPath(url.pathname)) {
        const segs = isFilesOpenPath(url.pathname) ? parseFilesOpenRel(url) : parseRelPath(url.searchParams.get("path") ?? "");
        if (!segs || segs.length === 0) return notFound(h);
        const real = await resolveInRoot(cfg.workRoot, segs);
        if (!real) return notFound(h); const s = await stat(real).catch(() => null);
        if (!s) return notFound(h);
        if (isFilesOpenPath(url.pathname)) {
          if (!s.isFile()) return notFound(h); if (s.size > DOWNLOAD_CAP_BYTES) return h.text("file too large", 413);
          const type = browserOpenType(basename(real));
          if (!type) return notFound(h);
          return fileBytes(h, real, s.size, type, "inline");
        }
        if (s.isDirectory()) {
          const plan = await planZip(real, cfg.workRoot, isRefusedName, MAX_ENTRIES, SEARCH_MAX_DEPTH, DOWNLOAD_CAP_BYTES);
          if (plan === "too-many") return h.text("folder has too many files", 413);
          if (plan === "too-large") return h.text("folder too large", 413);
          const name = zipName(real); const fallback = name.replace(/[^\x20-\x7e]|["\\\u0000-\u001f]/g, "_"); const headers = { "content-type": "application/zip", "content-disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,  "content-length": String(plan.size), "cache-control": "no-store", "x-content-type-options": "nosniff" };
          return h.secure(new Response(zipStream(plan), { headers }));
        }
        if (!s.isFile()) return notFound(h); if (s.size > DOWNLOAD_CAP_BYTES) return h.text("file too large", 413);
        return fileBytes(h, real, s.size, h.contentTypes[extname(real).toLowerCase()] ?? "application/octet-stream", "attachment");
      }
      const segs = parseRelPath(url.searchParams.get("path") ?? ""); if (!segs) return notFound(h);
      const result = await inspect(cfg.workRoot, segs); return result ? h.json(result, req.headers.get("accept-encoding")) : notFound(h);
    } catch (err) { return h.text(h.failureText("files", err), 500); }
  }
  return { enabled, owns, handle };
}
