// Pattern of T3 Code apps/server/src/checkpointing/CheckpointDiffQuery.ts (MIT, see web2/THIRD_PARTY.md): the
// diff between a run's two checkpoint commits, as a file list with counts and as one patch per file. Sightr
// compares two trees in its private store (spec T30), so a file already dirty before the run and unchanged by
// it is absent, an edit reverted within the run is absent, and a commit the agent made mid-run does not
// matter. T3's `authored` rule is a git-import filter (paths HEAD moved through a pull or merge are dropped);
// Sightr's `authored` flag is the run's own `file_change` items instead, and nothing is hidden by default.
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import type { CheckpointFile } from "../../shared/v2/contracts.ts";
import type { ReviewSide } from "../../shared/v2/review.ts";
import { DIFF_CAP_BYTES, FULL_SHA, isHiddenPath, parseNumstatRecord, type GitLimits, type GitRun } from "../workdir-git.ts";
import { FILE_CONTENTS_CAP_BYTES, SNIFF_BYTES } from "../workdir-review.ts";
import type { CheckpointPatchRow } from "./store.ts";

export const MAX_CHECKPOINT_FILES = 500;
export const PATCH_BUDGET_MS = 20_000;
export const PATCH_CONCURRENCY = 2;
export const MAX_PATCH_BYTES_PER_RUN = 2 * 1024 * 1024;
export const MAX_PATCH_STORE_BYTES = 256 * 1024 * 1024;
const LIST_CAP_BYTES = 32 * 1024 * 1024;
/** Every checkpoint diff: no external diff or textconv, no renames (a rename is a delete plus an add, as in T26), plain `a/` `b/` names. */
export const CHECKPOINT_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];

/** A runner bound to one private store (checkpoint-git's `storeRunner`). */
export type StoreRun = (args: string[], limits?: GitLimits) => Promise<GitRun>;

/** git's words for an object the store cannot reach: the snapshot (or an alternate's object under it) is gone. */
export function isMissingObject(stderr: string): boolean {
  return /bad object|bad file|missing (?:blob|tree|commit|object)|unable to read|not a valid object name|not a tree object|invalid object|bad revision|could not read|fatal: (?:bad|invalid) /i.test(stderr);
}

/** Cut text at `cap` bytes, at the last whole line. */
export function cutAtLine(text: string, cap = DIFF_CAP_BYTES): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= cap) return { text, truncated: false };
  const cut = new TextDecoder().decode(bytes.subarray(0, cap)).replace(/�$/, "");
  return { text: cut.slice(0, cut.lastIndexOf("\n") + 1), truncated: true };
}

/** A journal path (`file_change.fileName`: absolute, or relative to the pane) as a test against repo paths. */
export function authoredMatcher(root: string, fileNames: readonly string[]): (path: string) => boolean {
  const win = process.platform === "win32";
  const norm = (p: string) => (win ? p.toLowerCase() : p);
  const exact = new Set<string>(); const tails: string[] = [];
  for (const raw of fileNames) {
    let p = raw.trim().replaceAll("\\", "/");
    while (p.startsWith("./")) p = p.slice(2);
    if (!p) continue;
    if (isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
      const rel = relative(resolve(root), resolve(p)).replaceAll("\\", "/");
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) exact.add(norm(rel));
      continue;
    }
    exact.add(norm(p)); tails.push("/" + norm(p));
  }
  return (path) => { const p = norm(path); return exact.has(p) || tails.some((t) => p.endsWith(t)); };
}

export interface RunDiff {
  files: CheckpointFile[];
  additions: number;
  deletions: number;
  /** Refused-name paths in the diff (none in practice: they never enter a snapshot). */
  hidden: number;
  truncated: boolean;
}

/** The run's net change, `start` to `end`: kinds from `--raw`, counts from `--numstat`. Null when git failed (missing objects included). */
export async function diffRun(run: StoreRun, start: string, end: string, opts: { skippedPaths?: ReadonlySet<string>; authored?: (path: string) => boolean } = {}): Promise<RunDiff | { error: "missing" | "failed" }> {
  if (!FULL_SHA.test(start) || !FULL_SHA.test(end)) return { error: "failed" };
  const limits = { maxStdoutBytes: LIST_CAP_BYTES };
  const [num, raw] = await Promise.all([
    run(["diff", "--numstat", "-z", ...CHECKPOINT_DIFF_FLAGS, start, end, "--"], limits),
    run(["diff", "--raw", "-z", "--no-abbrev", ...CHECKPOINT_DIFF_FLAGS, start, end, "--"], limits),
  ]);
  for (const r of [num, raw]) {
    if (r.code !== 0 || r.timedOut || r.failed || r.overflow) return { error: r.code !== 0 && isMissingObject(r.stderr) ? "missing" : "failed" };
  }
  const kinds = new Map<string, CheckpointFile["kind"]>();
  const records = raw.stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const m = /^:\d+ \d+ [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(records[i]!);
    if (!m) continue;
    const path = records[++i]; if (!path) continue;
    kinds.set(path, m[1] === "A" ? "added" : m[1] === "D" ? "deleted" : "modified");
  }
  let hidden = 0, additions = 0, deletions = 0; const files: CheckpointFile[] = [];
  for (const record of num.stdout.split("\0")) {
    const s = parseNumstatRecord(record); if (!s) continue;
    if (isHiddenPath(s.path)) { hidden++; continue; }
    if (opts.skippedPaths?.has(s.path)) continue;
    additions += s.added; deletions += s.removed;
    files.push({ path: s.path, kind: kinds.get(s.path) ?? "modified", additions: s.added, deletions: s.removed, ...(s.binary ? { binary: true } : {}), ...(opts.authored ? { authored: opts.authored(s.path) } : {}) });
  }
  const kept = files.slice(0, MAX_CHECKPOINT_FILES);
  return { files: kept, additions, deletions, hidden, truncated: files.length > kept.length };
}

/** One file's patch between two commits (`-w` when asked), cut at {@link DIFF_CAP_BYTES} on a whole line. */
export async function filePatch(run: StoreRun, start: string, end: string, file: string, w: boolean, timeoutMs?: number): Promise<{ patch: string; truncated: boolean } | { error: "missing" | "failed" | "timeout" }> {
  const r = await run(["diff", "-U3", ...CHECKPOINT_DIFF_FLAGS, ...(w ? ["-w"] : []), start, end, "--", `:(literal,top)${file}`], { maxStdoutBytes: DIFF_CAP_BYTES + 1, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  if (r.timedOut) return { error: "timeout" };
  if (r.failed) return { error: "failed" };
  if (r.code !== 0 && !r.overflow) return { error: isMissingObject(r.stderr) ? "missing" : "failed" };
  const cut = cutAtLine(r.stdout);
  return { patch: cut.text, truncated: cut.truncated || r.overflow === true };
}

/**
 * The stored patches for a run's listed files: two at a time, inside {@link PATCH_BUDGET_MS}. Past
 * {@link MAX_PATCH_BYTES_PER_RUN} (or the budget) a file keeps no stored patch (`patch` null, `truncated`),
 * and is computed live while the objects exist. A binary file stores `''`.
 */
export async function capturePatches(run: StoreRun, start: string, end: string, files: readonly CheckpointFile[], opts: { budgetMs?: number; maxRunBytes?: number; now?: () => number } = {}): Promise<CheckpointPatchRow[]> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? PATCH_BUDGET_MS);
  const maxRunBytes = opts.maxRunBytes ?? MAX_PATCH_BYTES_PER_RUN;
  const rows: CheckpointPatchRow[] = new Array(files.length);
  let used = 0, next = 0, over = false;
  const worker = async () => {
    for (;;) {
      const i = next++; if (i >= files.length) return;
      const f = files[i]!;
      if (f.binary) { rows[i] = { path: f.path, patch: "", binary: true, truncated: false, bytes: 0 }; continue; }
      const left = deadline - now();
      if (over || left <= 0) { rows[i] = { path: f.path, patch: null, binary: false, truncated: true, bytes: 0 }; continue; }
      const p = await filePatch(run, start, end, f.path, false, left);
      if ("error" in p) { rows[i] = { path: f.path, patch: null, binary: false, truncated: true, bytes: 0 }; continue; }
      const bytes = new TextEncoder().encode(p.patch).length;
      if (used + bytes > maxRunBytes) { over = true; rows[i] = { path: f.path, patch: null, binary: false, truncated: true, bytes: 0 }; continue; }
      used += bytes;
      rows[i] = { path: f.path, patch: p.patch, binary: false, truncated: p.truncated, bytes };
    }
  };
  await Promise.all(Array.from({ length: Math.min(PATCH_CONCURRENCY, files.length) }, worker));
  return rows.filter(Boolean);
}

/**
 * Both commits and their root trees still reachable (`cat-file -e <commit>^{commit}` and `^{tree}`). The
 * commit is always in the private store; an unchanged root tree may live only in the real repo (the
 * alternate), which a history rewrite plus prune can remove.
 */
export async function commitsAlive(run: StoreRun, commits: readonly string[]): Promise<boolean> {
  for (const c of commits) {
    if (!FULL_SHA.test(c)) return false;
    for (const peel of ["commit", "tree"]) {
      const r = await run(["cat-file", "-e", `${c}^{${peel}}`]);
      if (r.code !== 0) return false;
    }
  }
  return true;
}

/**
 * One side of a file at a commit, in T26's side states with its 1 MB cap. Blobs are already line-ending
 * normalised. The path is looked up with `ls-tree` first: `cat-file <commit>:<path>` says "does not exist"
 * both for a path the tree lacks and for a tree object that is gone, and only the first is an absent side.
 */
export async function blobSide(run: StoreRun, commit: string, file: string): Promise<ReviewSide | { error: "missing" | "failed" }> {
  const lt = await run(["ls-tree", "-z", "--full-tree", commit, "--", file], { extraEnv: { GIT_LITERAL_PATHSPECS: "1" } });
  if (lt.timedOut || lt.failed) return { error: "failed" };
  if (lt.code !== 0) return isMissingObject(lt.stderr) ? { error: "missing" } : { error: "failed" };
  const m = lt.stdout.split("\0").map((r) => /^(\d+) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(r)).find((x) => x?.[4] === file);
  if (!m || m[2] !== "blob") return { state: "absent" };
  const oid = m[3]!;
  const size = await run(["cat-file", "-s", oid]);
  if (size.timedOut || size.failed) return { error: "failed" };
  if (size.code !== 0) return { error: "missing" };
  const n = Number(size.stdout.trim()); if (!Number.isFinite(n)) return { error: "failed" };
  const big = n > FILE_CONTENTS_CAP_BYTES;
  const blob = await run(["cat-file", "blob", oid], { maxStdoutBytes: big ? SNIFF_BYTES : FILE_CONTENTS_CAP_BYTES + 1 });
  if (blob.code !== 0 && !blob.overflow) return isMissingObject(blob.stderr) ? { error: "missing" } : { error: "failed" };
  if (new TextEncoder().encode(blob.stdout.slice(0, SNIFF_BYTES)).subarray(0, SNIFF_BYTES).includes(0)) return { state: "binary", bytes: n };
  if (big) return { state: "too-large", bytes: n };
  return { state: "text", text: blob.stdout, crlf: blob.stdout.includes("\r\n") };
}

export const hashOf = (...parts: Array<string | number | boolean>): string => createHash("sha256").update(parts.map(String).join("\0")).digest("hex").slice(0, 32);
