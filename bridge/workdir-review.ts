// The diff review API behind /api/files/git/review* and /api/files/git/branches (spec T26): a file list,
// then one patch or one whole file at a time, for the working tree or a branch. READ-ONLY like
// workdir-git.ts, whose hardened runner, repo discovery and base resolution it reuses: every git call is
// `[...prefix, --no-optional-locks, <allowlisted subcommand>, ...]`, a client string only ever reaches git
// as a literal pathspec, a `refs/heads|remotes/` suffix, a full hex oid or the tail of `<oid>:<path>`, and
// a path the Files refusal list hides is counted in `hidden` and never listed, diffed or read.
// Pattern of T3 Code apps/server/src/checkpointing/Diffs.ts (the `-z` numstat parse), extended for renames
// and status letters; the response shapes are shared/v2/review.ts.
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { containedRealpath } from "./containment.ts";
import { parseRelPath } from "./workdir.ts";
import {
  FULL_SHA, hardenedInvoke, isHiddenPath, openRepo, parseStatusV2, readEffectiveAutocrlf, resolveBase, spawnGit,
  type GitRun, type GitRunner, type ParsedStatus,
} from "./workdir-git.ts";
import type { ReviewBranch, ReviewBranches, ReviewDiffFileContents, ReviewDiffFilePatch, ReviewDiffPreview, ReviewFileKind, ReviewFileStat, ReviewSide, ReviewUnavailable } from "../shared/v2/review.ts";
import { quoteGitPatchPath, unquoteGitPatchPath } from "../shared/v2/gitPatchPath.ts";

/** Per-file patch cap: T3's per-file limit. The Git tab keeps its 256 KB aggregate cap. */
export const FILE_PATCH_CAP_BYTES = 1024 * 1024;
export const FILE_CONTENTS_CAP_BYTES = 1024 * 1024;
/** The Git tab's MAX_STATUS_ENTRIES, as a literal: workdir-git, workdir and this module import each other, so nothing may read an import while loading. */
export const MAX_REVIEW_FILES = 500;
export const MAX_REVIEW_BRANCHES = 200;
export const UNTRACKED_READ_BUDGET = 8 * 1024 * 1024;
/** Bound on the text of any list-shaped git output (numstat, name-status, ls-files, for-each-ref). */
export const LIST_OUTPUT_CAP_BYTES = 8 * 1024 * 1024;
export const BRANCH_SCAN_COUNT = 1000;
/** At most this many git processes at once across the bridge, and per repository. Tune after measuring on the real box. */
export const REVIEW_MAX_GIT = 4;
export const REVIEW_MAX_PER_REPO = 2;
/** Processes waiting for a slot; one more is answered `busy`. */
export const REVIEW_QUEUE_MAX = 32;
/** One request's whole budget (each process also has the 10 s {@link GIT_TIMEOUT_MS}). */
export const REVIEW_DEADLINE_MS = 25_000;
export const SNIFF_BYTES = 8192;
/** The only git subcommands this module runs; asserted on every call. */
export const REVIEW_SUBCOMMANDS: readonly string[] = ["rev-parse", "merge-base", "for-each-ref", "diff", "ls-files", "cat-file", "status"];
/** Flags on every patch and list call: no external diff, no textconv, no colour, no submodule walk, fixed `a/` `b/` prefixes, renames on. */
const DIFF_FLAGS = ["-M", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all", "--src-prefix=a/", "--dst-prefix=b/"];

// ── Parsers ──────────────────────────────────────────────────────────────────────────────────────────

export interface NumstatRow { path: string; oldPath?: string; added: number; removed: number; binary: boolean }
/** `diff -z --numstat -M`: `added\tremoved\tpath\0`, or for a rename `added\tremoved\t\0old\0new\0`. `-` counts mean binary. */
export function parseNumstatZ(stdout: string): NumstatRow[] {
  const records = stdout.split("\0"); const out: NumstatRow[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!; const m = /^(\d+|-)\t(\d+|-)\t/.exec(record); if (!m) continue;
    let path = record.slice(m[0].length); let oldPath: string | undefined;
    if (path === "") { oldPath = records[i + 1]; path = records[i + 2] ?? ""; i += 2; }
    if (!path || oldPath === "") continue;
    const binary = m[1] === "-" || m[2] === "-";
    out.push({ path, ...(oldPath === undefined ? {} : { oldPath }), added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary });
  }
  return out;
}

export interface NameStatusRow { status: string; path: string; oldPath?: string }
/** `diff -z --name-status -M`: `M\0path\0`, or `R100\0old\0new\0`. */
export function parseNameStatusZ(stdout: string): NameStatusRow[] {
  const records = stdout.split("\0"); const out: NameStatusRow[] = [];
  for (let i = 0; i < records.length; i++) {
    const status = records[i]!; if (!/^[A-Z]\d*$/.test(status)) continue;
    if (status[0] === "R" || status[0] === "C") { const oldPath = records[i + 1], path = records[i + 2]; i += 2; if (oldPath && path) out.push({ status, path, oldPath }); }
    else { const path = records[i + 1]; i += 1; if (path) out.push({ status, path }); }
  }
  return out;
}

const KIND_BY_LETTER: Record<string, ReviewFileKind> = { A: "added", D: "deleted", R: "renamed" };

// ── Small pure helpers ───────────────────────────────────────────────────────────────────────────────

const sha = (...parts: Array<string | number>): string => createHash("sha256").update(parts.join("\0")).digest("hex");
/** NUL in the first 8 KB of the bytes. */
export function hasNul(bytes: Uint8Array): boolean { return bytes.subarray(0, SNIFF_BYTES).includes(0); }
const hasNulText = (text: string): boolean => hasNul(new TextEncoder().encode(text.slice(0, SNIFF_BYTES)));
const foldCrlf = (text: string): string => text.replace(/\r\n/g, "\n");
const unavailable = (reason: ReviewUnavailable): { available: false; reason: ReviewUnavailable } => ({ available: false, reason });
/** A repo-root-relative path the client may name: the Files refusal list per segment, no traversal, not empty. */
const validFile = (p: string | undefined): p is string => p !== undefined && (parseRelPath(p)?.length ?? 0) > 0;
const samePath = (a: string, b: string): boolean => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const literal = (p: string): string => `:(literal,top)${p}`;

/**
 * A `base` the client may name: a short branch name, nothing git could read as an option, a revision
 * expression or a range. It only ever becomes `refs/heads/<base>` or `refs/remotes/<base>`.
 */
export function validBase(base: string): boolean {
  if (!/^[\p{L}\p{N}._\-/+@]{1,200}$/u.test(base)) return false;
  if (base.startsWith("-") || base.startsWith("/") || base.endsWith("/") || base.includes("..") || base.includes("//") || base.includes("@{") || /\.lock(\/|$)/.test(base)) return false;
  if (/^(?:HEAD|@)$/i.test(base)) return false;
  return !isHiddenPath(base);
}

/**
 * Cut a patch to `cap` bytes at the last place a reader can stop cleanly: just before a later hunk or
 * file of the same patch, after at least one whole hunk. One hunk bigger than the cap gives "".
 */
export function cutPatchAtHunk(patch: string, cap = FILE_PATCH_CAP_BYTES): { patch: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(patch);
  if (bytes.length <= cap) return { patch, truncated: false };
  return { patch: keepWholeHunks(new TextDecoder().decode(bytes.subarray(0, cap)).replace(/�$/, "")), truncated: true };
}
/** `cut` is a patch that was stopped part-way: keep it up to the last clean boundary, "" when not even one hunk is whole. */
export function keepWholeHunks(cut: string): string {
  let hunksInFile = 0, keep = -1, at = 0;
  for (const line of cut.split("\n")) {
    if (at > 0 && line.startsWith("diff --git ") && hunksInFile > 0) { keep = at; hunksInFile = 0; }
    else if (at > 0 && line.startsWith("@@ ") && hunksInFile > 0) keep = at;
    if (line.startsWith("diff --git ")) hunksInFile = 0;
    if (line.startsWith("@@ ")) hunksInFile++;
    at += line.length + 1;
  }
  return keep > 0 ? cut.slice(0, keep) : "";
}

/** The patch git would print for a new file holding `text` (no `index` line, so no object ids are made up). */
export function synthesizeAddedPatch(path: string, text: string): string {
  const a = quoteGitPatchPath(`a/${path}`), b = quoteGitPatchPath(`b/${path}`);
  const head = `diff --git ${a} ${b}\nnew file mode 100644\n`;
  if (text === "") return head;
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  return `${head}--- /dev/null\n+++ ${b}\n@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@\n${lines.map((l) => `+${l}`).join("\n")}\n${endsWithNewline ? "" : "\\ No newline at end of file\n"}`;
}
const synthesizeBinaryPatch = (path: string): string => { const a = quoteGitPatchPath(`a/${path}`), b = quoteGitPatchPath(`b/${path}`); return `diff --git ${a} ${b}\nnew file mode 100644\nBinary files /dev/null and ${b} differ\n`; };

function quotedEnd(s: string, start: number): number {
  for (let i = start + 1; i < s.length; i++) { if (s[i] === "\\") { i++; continue; } if (s[i] === '"') return i; }
  return -1;
}
/** Does a `diff --git` line's remainder name exactly one of the allowed `[old, new]` pairs (quoted or not)? */
export function headerNamesAllowed(rest: string, allowed: ReadonlyArray<readonly [string, string]>): boolean {
  for (const [o, n] of allowed) {
    const a = `a/${o}`, b = `b/${n}`; let at: number;
    if (rest.startsWith('"')) { const end = quotedEnd(rest, 0); if (end < 0 || unquoteGitPatchPath(rest.slice(0, end + 1)) !== a) continue; at = end + 1; }
    else { if (!rest.startsWith(`${a} `)) continue; at = a.length; }
    if (rest[at] !== " ") continue;
    const second = rest.slice(at + 1);
    const name = second.startsWith('"') ? (quotedEnd(second, 0) === second.length - 1 ? unquoteGitPatchPath(second) : null) : second;
    if (name === b) return true;
  }
  return false;
}
/** Every `diff --git` header in a patch names only the requested file and its old name. */
export function patchHeadersMatch(patch: string, file: string, oldFile?: string): boolean {
  const allowed: Array<[string, string]> = [[file, file]]; if (oldFile && oldFile !== file) allowed.push([oldFile, oldFile], [oldFile, file]);
  for (const line of patch.split("\n")) if (line.startsWith("diff --git ") && !headerNamesAllowed(line.slice(11), allowed)) return false;
  return true;
}

// ── Concurrency: a bounded, FIFO process gate ────────────────────────────────────────────────────────

interface Waiter { repo: string; start: () => void; cancel: () => void }
export function createGate(maxGit: number, maxPerRepo: number, maxQueue: number) {
  let running = 0; const perRepo = new Map<string, number>(); const queue: Waiter[] = [];
  const pump = () => {
    for (let i = 0; i < queue.length && running < maxGit;) {
      const w = queue[i]!;
      if ((perRepo.get(w.repo) ?? 0) >= maxPerRepo) { i++; continue; }
      queue.splice(i, 1); w.start();
    }
  };
  return {
    get running() { return running; },
    get queued() { return queue.length; },
    /** Run `task` when a slot is free: "busy" when the queue is full, "timeout" when `deadline` passes while waiting. */
    schedule<T>(repo: string, deadline: number, task: () => Promise<T>): Promise<T | "busy" | "timeout"> {
      const remaining = deadline - Date.now(); if (remaining <= 0) return Promise.resolve("timeout");
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const start = () => {
          if (timer) clearTimeout(timer);
          running++; perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
          task().finally(() => { running--; const n = (perRepo.get(repo) ?? 1) - 1; if (n <= 0) perRepo.delete(repo); else perRepo.set(repo, n); pump(); }).then(resolve, reject);
        };
        if (running < maxGit && (perRepo.get(repo) ?? 0) < maxPerRepo) { start(); return; }
        if (queue.length >= maxQueue) { resolve("busy"); return; }
        const waiter: Waiter = { repo, start, cancel: () => resolve("timeout") };
        timer = setTimeout(() => { const i = queue.indexOf(waiter); if (i >= 0) queue.splice(i, 1); waiter.cancel(); }, remaining);
        queue.push(waiter);
      });
    },
  };
}

class ReviewStop extends Error { constructor(readonly reason: ReviewUnavailable) { super(reason); } }
const TIMED_OUT: GitRun = { code: -1, stdout: "", stderr: "", timedOut: true, failed: false };

export interface ReviewOptions {
  maxGit?: number; maxPerRepo?: number; queueMax?: number; deadlineMs?: number;
  /** The `-c core.autocrlf=…` pair the runner passes (default: the operator's effective setting). */
  autocrlf?: () => Promise<string[]>;
}
export type ReviewNotModified = { notModified: true; diffHash: string };
export interface ListQuery { scope: "working-tree" | "branch"; base?: string; ignoreWhitespace?: boolean; ifNoneMatch?: string | null }
export interface FileQuery { scope: "working-tree" | "branch"; file: string; oldFile?: string; from?: string; to?: string; ignoreWhitespace?: boolean }

export function createFolderReview(workRoot: string, run: GitRunner = spawnGit, opts: ReviewOptions = {}) {
  const invoke = hardenedInvoke(run);
  const gate = createGate(opts.maxGit ?? REVIEW_MAX_GIT, opts.maxPerRepo ?? REVIEW_MAX_PER_REPO, opts.queueMax ?? REVIEW_QUEUE_MAX);
  const deadlineMs = opts.deadlineMs ?? REVIEW_DEADLINE_MS;
  const autocrlf = opts.autocrlf ?? readEffectiveAutocrlf;
  const flights = new Map<string, Promise<unknown>>();

  /** Single-flight per key; every flight has the request deadline. */
  function serve<T>(key: string, compute: (inv: GitRunner) => Promise<T>): Promise<T | { available: false; reason: ReviewUnavailable }> {
    const live = flights.get(key); if (live) return live as Promise<T | { available: false; reason: ReviewUnavailable }>;
    const deadline = Date.now() + deadlineMs;
    const inv: GitRunner = async (args, cwd, limits) => {
      const sub = args[0];
      if (sub === undefined || !REVIEW_SUBCOMMANDS.includes(sub)) throw new Error(`review: git ${sub} is not allowed`);
      if (Date.now() >= deadline) return TIMED_OUT;
      const r = await gate.schedule(cwd, deadline, () => invoke(["--no-optional-locks", ...args], cwd, limits));
      if (r === "busy") throw new ReviewStop("busy");
      return r === "timeout" ? TIMED_OUT : r;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<{ available: false; reason: ReviewUnavailable }>((r) => { timer = setTimeout(() => r(unavailable("timeout")), deadlineMs); });
    const work = compute(inv).catch((err): { available: false; reason: ReviewUnavailable } => { if (err instanceof ReviewStop) return unavailable(err.reason); throw err; });
    const flight = Promise.race([work, expiry]).finally(() => { clearTimeout(timer); flights.delete(key); });
    // A request that lost the race to its deadline must not surface its late rejection as unhandled.
    work.catch(() => {});
    flights.set(key, flight);
    return flight;
  }

  /** One git call that must work: spawn failure and timeout stop the request. */
  async function git(inv: GitRunner, args: string[], cwd: string, limits?: { maxStdoutBytes: number }): Promise<GitRun> {
    const r = await inv(args, cwd, limits);
    if (r.failed) throw new ReviewStop("git-unavailable");
    if (r.timedOut) throw new ReviewStop("timeout");
    return r;
  }
  /** A list-shaped output, dropping a record cut by the byte cap. */
  const listOut = (r: GitRun): { text: string; truncated: boolean } => r.overflow ? { text: r.stdout.slice(0, r.stdout.lastIndexOf("\0") + 1), truncated: true } : { text: r.stdout, truncated: false };

  async function headOid(inv: GitRunner, root: string): Promise<string | null> {
    const r = await git(inv, ["rev-parse", "--verify", "--quiet", "HEAD"], root);
    const oid = r.code === 0 ? r.stdout.trim() : ""; return FULL_SHA.test(oid) ? oid : null;
  }
  async function statusOf(inv: GitRunner, root: string): Promise<ParsedStatus> {
    const r = await git(inv, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"], root);
    return parseStatusV2(r.stdout.split("\0").filter(Boolean));
  }
  async function pickBase(inv: GitRunner, root: string, base: string): Promise<string | null> {
    for (const full of [`refs/heads/${base}`, `refs/remotes/${base}`]) {
      const r = await git(inv, ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", full], root);
      if (r.code === 0 && r.stdout.trim() === full) return full;
    }
    return null;
  }
  async function foldsCrlf(): Promise<boolean> { const a = await autocrlf(); return a.includes("core.autocrlf=true") || a.includes("core.autocrlf=input"); }

  // ── File list ──────────────────────────────────────────────────────────────────────────────────────

  /** Counts and kinds for `range` (`HEAD`, or `from to`), joined on the new path. */
  async function trackedRows(inv: GitRunner, root: string, range: string[], ignoreWhitespace: boolean): Promise<{ rows: Array<{ s: NameStatusRow; n: NumstatRow | undefined }>; truncated: boolean }> {
    const flags = ["diff", "-z", ...DIFF_FLAGS, ...(ignoreWhitespace ? ["-w"] : [])];
    const limits = { maxStdoutBytes: LIST_OUTPUT_CAP_BYTES };
    const [num, names] = await Promise.all([git(inv, [...flags, "--numstat", ...range, "--"], root, limits), git(inv, [...flags, "--name-status", ...range, "--"], root, limits)]);
    if (num.code !== 0 && !num.overflow) throw new ReviewStop("bad-commit");
    if (names.code !== 0 && !names.overflow) throw new ReviewStop("bad-commit");
    const a = listOut(num), b = listOut(names);
    const counts = new Map(parseNumstatZ(a.text).map((r) => [r.path, r] as const));
    return { rows: parseNameStatusZ(b.text).map((s) => ({ s, n: counts.get(s.path) })), truncated: a.truncated || b.truncated };
  }

  function statOf(s: NameStatusRow, n: NumstatRow | undefined, ignoreWhitespace: boolean): Omit<ReviewFileStat, "rev"> {
    const kind = KIND_BY_LETTER[s.status[0]!] ?? "modified"; const binary = n?.binary === true;
    const added = n?.added ?? 0, removed = n?.removed ?? 0;
    return { path: s.path, ...(s.oldPath === undefined ? {} : { oldPath: s.oldPath }), kind, added, removed, ...(binary ? { binary: true as const } : {}), ...(ignoreWhitespace && kind === "modified" && !binary && added === 0 && removed === 0 ? { whitespaceOnly: true as const } : {}) };
  }
  const rowRev = (f: Omit<ReviewFileStat, "rev">, extra: string): string => sha(f.kind, f.added, f.removed, f.path, f.oldPath ?? "", f.binary ? "b" : "", f.whitespaceOnly ? "w" : "", extra).slice(0, 16);

  async function untrackedStats(inv: GitRunner, root: string, room: number): Promise<{ files: ReviewFileStat[]; hidden: number; truncated: boolean }> {
    const r = await git(inv, ["ls-files", "--others", "--exclude-standard", "-z"], root, { maxStdoutBytes: LIST_OUTPUT_CAP_BYTES });
    const { text, truncated: cutOut } = listOut(r); let hidden = 0; const paths: string[] = [];
    for (const p of text.split("\0")) { if (!p || p.endsWith("/")) continue; if (isHiddenPath(p)) hidden++; else paths.push(p); }
    const files: ReviewFileStat[] = []; let budget = UNTRACKED_READ_BUDGET; let truncated = cutOut;
    const fold = await foldsCrlf();
    for (const path of paths) {
      if (files.length >= room) { truncated = true; break; }
      const info = await lstat(join(root, ...path.split("/"))).catch(() => null);
      if (!info) continue;
      const base = { path, kind: "untracked" as const, added: 0, removed: 0 };
      if (!info.isFile()) { files.push({ ...base, binary: true, rev: rowRev({ ...base, binary: true }, `link:${info.mtimeMs}`) }); continue; }
      if (info.size > FILE_CONTENTS_CAP_BYTES || info.size > budget) { files.push({ ...base, tooLarge: true, rev: rowRev({ ...base }, `big:${info.size}:${info.mtimeMs}`) }); continue; }
      const read = await readDisk(root, path, info.size);
      if (read === null) continue;
      budget -= read.length;
      const digest = createHash("sha256").update(read).update(fold ? "f" : "").digest("hex");
      if (hasNul(read)) { files.push({ ...base, binary: true, rev: rowRev({ ...base, binary: true }, digest) }); continue; }
      const added = countLines(new TextDecoder().decode(read));
      files.push({ ...base, added, rev: rowRev({ ...base, added }, digest) });
    }
    return { files, hidden, truncated };
  }

  /** The bytes of a regular, contained file under the repo root, at most `size` of them; null when it is not one. */
  async function readDisk(root: string, file: string, size: number): Promise<Uint8Array | null> {
    const abs = join(root, ...file.split("/"));
    const real = await containedRealpath(abs, root); if (!real) return null;
    // Git never tracks a path through a link, so a file reached through one is not a repo file: refuse it
    // even when the link stays inside the root (a folder link to `.git` would otherwise slip past the
    // hidden-name check, which only sees the names that were asked for).
    if (!samePath(real, abs)) return null;
    return new Uint8Array(await Bun.file(real).slice(0, Math.min(size, FILE_CONTENTS_CAP_BYTES + 1)).arrayBuffer());
  }
  const countLines = (text: string): number => { if (text === "") return 0; let n = 0; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return text.endsWith("\n") ? n : n + 1; };

  async function list(dir: string, q: ListQuery): Promise<ReviewDiffPreview | ReviewNotModified> {
    const w = q.ignoreWhitespace === true;
    if (q.scope === "branch" && q.base !== undefined && !validBase(q.base)) return unavailable("bad-base");
    const key = ["list", dir, q.scope, q.base ?? "", w ? "1" : "0", q.scope === "branch" ? q.ifNoneMatch ?? "" : ""].join("\0");
    return serve<ReviewDiffPreview | ReviewNotModified>(key, async (inv) => {
      const repo = await openRepo(workRoot, inv, dir); if (!repo.ok) return unavailable(repo.reason);
      const { root } = repo;
      const head = await headOid(inv, root); if (!head) return unavailable("no-commits");

      if (q.scope === "branch") {
        let ref: string, name: string, isDefault = false;
        if (q.base !== undefined) { const picked = await pickBase(inv, root, q.base); if (!picked) return unavailable("bad-base"); ref = picked; name = q.base; }
        else { const rb = await resolveBase(inv, root, await statusOf(inv, root)); if (!rb) return unavailable("no-base"); ref = rb.ref; name = rb.name; isDefault = true; }
        const mb = await git(inv, ["merge-base", ref, "HEAD"], root);
        const from = mb.code === 0 ? mb.stdout.trim() : ""; if (!FULL_SHA.test(from)) return unavailable("no-base");
        // The scope is immutable, so its hash is known before any diff runs.
        const diffHash = sha("branch", w ? "w" : "", name, isDefault ? "d" : "", from, head).slice(0, 32);
        if (q.ifNoneMatch === `"${diffHash}"`) return { notModified: true, diffHash };
        const { rows, truncated } = await trackedRows(inv, root, [from, head], w);
        let hidden = 0; const files: ReviewFileStat[] = [];
        for (const { s, n } of rows) {
          if (isHiddenPath(s.path) || (s.oldPath !== undefined && isHiddenPath(s.oldPath))) { hidden++; continue; }
          const stat = statOf(s, n, w); files.push({ ...stat, rev: rowRev(stat, "") });
        }
        const capped = files.slice(0, MAX_REVIEW_FILES);
        return { available: true, scope: "branch", base: name, ...(isDefault ? { baseIsDefault: true } : {}), from, to: head, files: capped, hidden, truncated: truncated || files.length > capped.length, diffHash };
      }

      const { rows, truncated } = await trackedRows(inv, root, ["HEAD"], w);
      let hidden = 0; const tracked: Array<Omit<ReviewFileStat, "rev">> = [];
      for (const { s, n } of rows) {
        if (isHiddenPath(s.path) || (s.oldPath !== undefined && isHiddenPath(s.oldPath))) { hidden++; continue; }
        tracked.push(statOf(s, n, w));
      }
      const keptTracked = tracked.slice(0, MAX_REVIEW_FILES);
      const files: ReviewFileStat[] = await Promise.all(keptTracked.map(async (f) => {
        const info = f.kind === "deleted" ? null : await lstat(join(root, ...f.path.split("/"))).catch(() => null);
        return { ...f, rev: rowRev(f, info ? `${info.size}:${info.mtimeMs}` : "gone") };
      }));
      const more = await untrackedStats(inv, root, MAX_REVIEW_FILES - files.length);
      files.push(...more.files); hidden += more.hidden;
      const listTruncated = truncated || tracked.length > keptTracked.length || more.truncated;
      const diffHash = sha("working-tree", w ? "w" : "", head, hidden, listTruncated ? "t" : "", ...files.map((f) => f.rev)).slice(0, 32);
      return { available: true, scope: "working-tree", files, hidden, truncated: listTruncated, diffHash };
    });
  }

  // ── One file's patch ───────────────────────────────────────────────────────────────────────────────

  async function patch(dir: string, q: FileQuery): Promise<ReviewDiffFilePatch> {
    if (!validFile(q.file) || (q.oldFile !== undefined && !validFile(q.oldFile))) return unavailable("bad-file");
    if (q.scope === "branch" && (!FULL_SHA.test(q.from ?? "") || !FULL_SHA.test(q.to ?? ""))) return unavailable("bad-commit");
    const w = q.ignoreWhitespace === true;
    const key = ["patch", dir, q.scope, q.from ?? "", q.to ?? "", w ? "1" : "0", q.file, q.oldFile ?? ""].join("\0");
    return serve<ReviewDiffFilePatch>(key, async (inv) => {
      const repo = await openRepo(workRoot, inv, dir); if (!repo.ok) return unavailable(repo.reason);
      const { root } = repo;
      const specs = [literal(q.file), ...(q.oldFile !== undefined && q.oldFile !== q.file ? [literal(q.oldFile)] : [])];
      let range: string[];
      if (q.scope === "branch") range = [q.from!, q.to!];
      else {
        if (!await headOid(inv, root)) return unavailable("no-commits");
        range = ["HEAD"];
        // An untracked file has no git diff, so its patch is built here from the file, as an addition.
        const others = await git(inv, ["ls-files", "--others", "--exclude-standard", "-z", "--", literal(q.file)], root, { maxStdoutBytes: LIST_OUTPUT_CAP_BYTES });
        if (others.stdout.split("\0").includes(q.file)) return finish(await untrackedPatch(root, q.file));
      }
      const d = await git(inv, ["diff", ...DIFF_FLAGS, "-U3", ...(w ? ["-w"] : []), ...range, "--", ...specs], root, { maxStdoutBytes: FILE_PATCH_CAP_BYTES });
      if (d.code !== 0 && !d.overflow) return unavailable(q.scope === "branch" ? "bad-commit" : "git-unavailable");
      const cut = d.overflow ? { patch: keepWholeHunks(d.stdout), truncated: true } : cutPatchAtHunk(d.stdout);
      if (!patchHeadersMatch(cut.patch, q.file, q.oldFile)) return unavailable("bad-file");
      return finish(cut);
    });
  }
  function finish(p: { patch: string; truncated: boolean }): ReviewDiffFilePatch { return { available: true, patch: p.patch, truncated: p.truncated, diffHash: sha("patch", p.truncated ? "t" : "", p.patch).slice(0, 32) }; }
  async function untrackedPatch(root: string, file: string): Promise<{ patch: string; truncated: boolean }> {
    const info = await lstat(join(root, ...file.split("/"))).catch(() => null);
    if (!info) return { patch: "", truncated: false };
    if (!info.isFile()) return { patch: synthesizeBinaryPatch(file), truncated: false };
    if (info.size > FILE_CONTENTS_CAP_BYTES) return { patch: "", truncated: true };
    const bytes = await readDisk(root, file, info.size); if (bytes === null) return { patch: "", truncated: false };
    if (hasNul(bytes)) return { patch: synthesizeBinaryPatch(file), truncated: false };
    const raw = new TextDecoder().decode(bytes);
    return cutPatchAtHunk(synthesizeAddedPatch(file, (await foldsCrlf()) ? foldCrlf(raw) : raw));
  }

  // ── One file's whole contents (old side and new side) ──────────────────────────────────────────────

  async function blobSide(inv: GitRunner, root: string, rev: string, file: string): Promise<ReviewSide> {
    const spec = `${rev}:${file}`;
    const size = await git(inv, ["cat-file", "-s", spec], root);
    const n = size.code === 0 ? Number(size.stdout.trim()) : NaN; if (!Number.isFinite(n)) return { state: "absent" };
    const blob = await git(inv, ["cat-file", "blob", spec], root, { maxStdoutBytes: n > FILE_CONTENTS_CAP_BYTES ? SNIFF_BYTES : FILE_CONTENTS_CAP_BYTES + 1 });
    if (blob.code !== 0 && !blob.overflow) return { state: "absent" };
    if (hasNulText(blob.stdout)) return { state: "binary", bytes: n };
    if (n > FILE_CONTENTS_CAP_BYTES) return { state: "too-large", bytes: n };
    return { state: "text", text: blob.stdout, crlf: blob.stdout.includes("\r\n") };
  }
  async function diskSide(root: string, file: string): Promise<ReviewSide> {
    const info = await lstat(join(root, ...file.split("/"))).catch(() => null);
    if (!info || !info.isFile()) return { state: "absent" };   // a symlink is not a regular file under lstat
    const bytes = await readDisk(root, file, info.size > FILE_CONTENTS_CAP_BYTES ? SNIFF_BYTES : info.size); if (bytes === null) return { state: "absent" };
    if (hasNul(bytes)) return { state: "binary", bytes: info.size };
    if (info.size > FILE_CONTENTS_CAP_BYTES) return { state: "too-large", bytes: info.size };
    const raw = new TextDecoder().decode(bytes); const text = (await foldsCrlf()) ? foldCrlf(raw) : raw;
    return { state: "text", text, crlf: text.includes("\r\n") };
  }

  async function contents(dir: string, q: FileQuery): Promise<ReviewDiffFileContents> {
    if (!validFile(q.file) || (q.oldFile !== undefined && !validFile(q.oldFile))) return unavailable("bad-file");
    if (q.scope === "branch" && (!FULL_SHA.test(q.from ?? "") || !FULL_SHA.test(q.to ?? ""))) return unavailable("bad-commit");
    const key = ["contents", dir, q.scope, q.from ?? "", q.to ?? "", q.file, q.oldFile ?? ""].join("\0");
    return serve<ReviewDiffFileContents>(key, async (inv) => {
      const repo = await openRepo(workRoot, inv, dir); if (!repo.ok) return unavailable(repo.reason);
      const { root } = repo;
      const oldSide = await blobSide(inv, root, q.scope === "branch" ? q.from! : "HEAD", q.oldFile ?? q.file);
      const newSide = q.scope === "branch" ? await blobSide(inv, root, q.to!, q.file) : await diskSide(root, q.file);
      return { available: true, old: oldSide, new: newSide, diffHash: sha("contents", JSON.stringify(oldSide), JSON.stringify(newSide)).slice(0, 32) };
    });
  }

  // ── Branches for the base picker ───────────────────────────────────────────────────────────────────

  async function branches(dir: string): Promise<ReviewBranches> {
    return serve<ReviewBranches>(["branches", dir].join("\0"), async (inv) => {
      const repo = await openRepo(workRoot, inv, dir); if (!repo.ok) return unavailable(repo.reason);
      const { root } = repo;
      if (!await headOid(inv, root)) return unavailable("no-commits");
      const st = await statusOf(inv, root);
      const r = await git(inv, ["for-each-ref", "--sort=-committerdate", `--count=${BRANCH_SCAN_COUNT}`, "--format=%(HEAD)%09%(refname)%09%(committerdate:unix)", "refs/heads", "refs/remotes"], root, { maxStdoutBytes: LIST_OUTPUT_CAP_BYTES });
      const out: ReviewBranch[] = []; let truncated = r.overflow === true; let current: string | undefined;
      for (const line of r.stdout.split("\n")) {
        const [mark = "", ref = "", time = "0"] = line.split("\t");
        const m = /^refs\/(heads|remotes)\/(.+)$/.exec(ref); if (!m) continue;
        const remote = m[1] === "remotes", name = m[2]!;
        if (remote && /^[^/]+\/HEAD$/.test(name)) continue;
        if (isHiddenPath(name)) continue;
        if (out.length >= MAX_REVIEW_BRANCHES) { truncated = true; break; }
        const isCurrent = mark === "*"; if (isCurrent) current = name;
        out.push({ name, remote, ...(isCurrent ? { current: true as const } : {}), time: Number(time) || 0 });
      }
      const base = await resolveBase(inv, root, st);
      return { available: true, ...(current ?? st.branch ? { current: current ?? st.branch } : {}), ...(st.detached ? { detached: true as const } : {}), ...(base ? { defaultBase: base.name } : {}), branches: out, truncated };
    });
  }

  return { list, patch, contents, branches, gate };
}
