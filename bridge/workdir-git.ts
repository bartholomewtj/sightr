// Reads the folder selected in Files, walks to its worktree, and reports handed-in panes live inside it.
// This module only ever READS: it switches off operator Git configuration when spawning git, and
// filters every path hidden by the Files skip list before git diff is asked for it.
import { devNull, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { access, realpath } from "node:fs/promises";
import { containedRealpath } from "./containment.ts";
import { isRefusedName, relInRoot } from "./workdir.ts";
import type { FolderGitCommit, FolderGitDiffResponse, FolderGitEntry, FolderGitFileStat, FolderGitResponse, FolderGitUnavailable } from "../shared/wire.ts";

export const GIT_TIMEOUT_MS = 10_000;
export const DIFF_CAP_BYTES = 256 * 1024;
export const MAX_STATUS_ENTRIES = 500;
export const MAX_DIFF_PATHS = 200;
export const MAX_PATHSPEC_BYTES = 8_000;
export const MAX_PANE_IDS = 50;
export const MAX_WALK = 40;
export interface GitRun { code: number; stdout: string; stderr: string; timedOut: boolean; failed: boolean; /** stdout passed `maxStdoutBytes` and the process was stopped; `stdout` holds the first bytes only. */ overflow?: boolean }
/** Optional per-call output bound. The review routes pass it; the Git tab does not, so its reads are unchanged. */
export interface GitLimits {
  maxStdoutBytes?: number;
  /** Read by the review wrapper, not by the runner: this caller copes with cut output (`overflow`); every other review call treats it as a failure. */
  allowPartial?: boolean;
}
export type GitRunner = (args: string[], cwd: string, limits?: GitLimits) => Promise<GitRun>;
const STDERR_CAP_BYTES = 64 * 1024;
const prefix = [
  "--no-pager", // never let a read block on or emit pager output
  "-c", `core.hooksPath=${devNull}`, // repo hooks must never execute during a read
  "-c", "core.fsmonitor=false", // do not start a watcher daemon in the repo
  "-c", "core.pager=cat", // belt and braces with --no-pager
  "-c", "color.ui=false", // JSON must not contain ANSI colour escapes
  "-c", "diff.external=", // do not invoke an external diff program
];
function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "windir", "ComSpec", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TZ"]) if (process.env[key]) out[key] = process.env[key]!;
  const gitNull = process.platform === "win32" ? "NUL" : devNull;
  Object.assign(out, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: gitNull, GIT_CONFIG_GLOBAL: gitNull, GIT_ATTR_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_PAGER: "cat", PAGER: "cat", LC_ALL: "C" });
  return out;
}
// The scrubbed env above hides the operator's system and global gitconfig, and with them
// core.autocrlf. Git for Windows sets autocrlf=true in the SYSTEM file, so an LF-committed file it
// checked out with CRLF reads as a whole-file "modified" the moment git runs without that setting —
// a 790/790 diff the operator's own `git status` never shows. So the one line-ending setting is
// read once, from the real config (system + global, from a non-repo cwd so no repo config leaks
// in), and passed back in explicitly.
export function autocrlfArgs(raw: string | undefined): string[] { const value = raw?.trim().toLowerCase(); return value === "true" || value === "false" || value === "input" ? ["-c", `core.autocrlf=${value}`] : []; }
let effectiveAutocrlf: Promise<string[]> | null = null;
export function readEffectiveAutocrlf(): Promise<string[]> {
  effectiveAutocrlf ??= (async () => { try { const proc = Bun.spawn(["git", "config", "--get", "core.autocrlf"], { cwd: tmpdir(), stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }); await proc.exited; return autocrlfArgs(await new Response(proc.stdout).text()); } catch { return []; } })();
  return effectiveAutocrlf;
}
/** A bounded read of a stream: `done` holds up to `cap` bytes (past that it stops, calls `onOverflow` and says so); `stop()` ends it early with what it has. Lossy UTF-8 like `Response.text()`. */
function readCapped(stream: ReadableStream<Uint8Array>, cap: number, onOverflow: () => void): { done: Promise<{ text: string; overflow: boolean }>; stop: () => void } {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0, overflow = false;
  const done = (async () => {
    try {
      for (;;) {
        const { done: end, value } = await reader.read(); if (end) break;
        const room = cap - size;
        if (value.length > room) { if (room > 0) chunks.push(value.subarray(0, room)); size = cap; overflow = true; onOverflow(); break; }
        chunks.push(value); size += value.length;
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.length; }
    return { text: new TextDecoder().decode(bytes), overflow };
  })();
  return { done, stop: () => { void reader.cancel().catch(() => {}); } };
}
/** How long a killed process's pipes may stay open (a grandchild, such as a filter driver, can hold them) before the read is cut and the concurrency slot freed. */
export const KILL_GRACE_MS = 500;
export interface BoundedProc { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }
/** Run a spawned process to completion with stdout bounded, a timeout, and a grace period for its pipes after it dies. */
export async function collectBounded(proc: BoundedProc, maxStdoutBytes: number, timeoutMs = GIT_TIMEOUT_MS, graceMs = KILL_GRACE_MS): Promise<GitRun> {
  let timedOut = false; let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<number>((r) => { timer = setTimeout(() => { timedOut = true; proc.kill(); r(-1); }, timeoutMs); });
  const out = readCapped(proc.stdout, maxStdoutBytes, () => proc.kill()), err = readCapped(proc.stderr, STDERR_CAP_BYTES, () => {});
  const code = await Promise.race([proc.exited, timeout]); clearTimeout(timer!);
  // The process is gone (or killed); its pipes close with it unless a child kept them. Give them a moment, then cut.
  let grace: ReturnType<typeof setTimeout>; let outClosed = false;
  void out.done.then(() => { outClosed = true; });
  await Promise.race([Promise.all([out.done, err.done]), new Promise<void>((r) => { grace = setTimeout(r, graceMs); })]); clearTimeout(grace!);
  // stdout still open when the grace ran out: what we hold may stop mid-record even though git exited 0. Say so the
  // way a cap does (`overflow`), so no caller reads it as complete. A cut stderr alone costs nothing.
  const stdoutCut = !outClosed;
  out.stop(); err.stop();
  const [o, e] = await Promise.all([out.done, err.done]);
  return { code, stdout: o.text, stderr: e.text, timedOut, failed: false, ...(o.overflow || stdoutCut ? { overflow: true } : {}) };
}
export const spawnGit: GitRunner = async (args, cwd, limits) => {
  let proc: any;
  try { proc = Bun.spawn(["git", ...prefix, ...(await readEffectiveAutocrlf()), ...args], { cwd, env: env(), stdout: "pipe", stderr: "pipe" }); } catch { return { code: -1, stdout: "", stderr: "", timedOut: false, failed: true }; }
  // Bounded read (the review routes): drain both pipes from the start, stop the process once stdout passes the cap.
  if (limits?.maxStdoutBytes !== undefined) return collectBounded(proc, limits.maxStdoutBytes);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<number>((r) => { timer = setTimeout(() => { timedOut = true; proc.kill(); r(-1); }, GIT_TIMEOUT_MS); });
  const code = await Promise.race([proc.exited, timeout]); clearTimeout(timer!);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr, timedOut, failed: false };
};
function inside(path: string, root: string): boolean { const a = resolve(path), b = resolve(root); return a === b || a.toLowerCase().startsWith(b.toLowerCase() + sep); }
export async function findWorktreeRoot(cwd: string, workRoot: string): Promise<string | null> {
  let dir = resolve(cwd), root = resolve(workRoot);
  for (let i = 0; i <= MAX_WALK && inside(dir, root); i++) {
    if (await access(join(dir, ".git")).then(() => true).catch(() => false)) return dir;
    const parent = dirname(dir); if (parent === dir) break; dir = parent;
  }
  return null;
}
export interface ParsedStatus { branch?: string; detached: boolean; noCommits: boolean; upstream?: string; ahead?: number; behind?: number; entries: Array<FolderGitEntry & { tracked: boolean }> }
export function parseStatusV2(records: string[]): ParsedStatus {
  let branch: string | undefined, detached = false, noCommits = false, upstream: string | undefined, ahead: number | undefined, behind: number | undefined;
  const entries: Array<FolderGitEntry & { tracked: boolean }> = [];
  /** A `# branch.*` header; true when the record was one. */
  const header = (line: string): boolean => {
    if (line.startsWith("# branch.head ")) { const v = line.slice(14); if (v === "(detached)") detached = true; else branch = v; return true; }
    if (line === "# branch.oid (initial)") { noCommits = true; return true; }
    if (line.startsWith("# branch.upstream ")) { upstream = line.slice(18); return true; }
    const ab = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line); if (ab) { ahead = Number(ab[1]); behind = Number(ab[2]); return true; }
    return line.startsWith("# ");
  };
  for (const original of records) {
    let r = original;
    // Git places its newline-delimited branch headers before the first NUL-terminated record.
    if (r.includes("\n# ")) {
      const lines = r.split("\n"); r = lines.pop()!;
      for (const line of lines) header(line);
    }
    if (header(r)) continue;
    const f = r.split(" "); const type = f[0];
    if (type === "1" && f.length >= 9) entries.push({ path: f.slice(8).join(" "), x: f[1]![0]!, y: f[1]![1]!, tracked: true });
    else if (type === "u" && f.length >= 11) entries.push({ path: f.slice(10).join(" "), x: f[1]![0]!, y: f[1]![1]!, tracked: true });
    else if (type === "?" && f.length >= 2) entries.push({ path: f.slice(1).join(" "), x: "?", y: "?", tracked: false });
  }
  // An upstream with no `branch.ab` line is gone (deleted on the remote): no counts to trust.
  return { ...(branch === undefined ? {} : { branch }), detached, noCommits, ...(upstream === undefined ? {} : { upstream }), ...(ahead === undefined ? {} : { ahead, behind: behind! }), entries };
}
export function isHiddenPath(path: string): boolean { return path.split("/").some((seg) => seg !== "" && isRefusedName(seg)); }
function cutDiff(text: string): { text: string; truncated: boolean } { const bytes = new TextEncoder().encode(text); if (bytes.length <= DIFF_CAP_BYTES) return { text, truncated: false }; const cut = new TextDecoder().decode(bytes.slice(0, DIFF_CAP_BYTES)); return { text: cut.slice(0, cut.lastIndexOf("\n") + 1), truncated: true }; }

// ── History: commits, the branch range, one commit's diff. Read-only like everything above. ─────────

export const MAX_COMMITS = 20;
/** A commit the client names: hex only, so it can never be read as an option or a revision expression. */
export const SHA_RE = /^[0-9a-f]{7,40}$/;
export const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Flags every patch or count call carries: no external diff, no textconv driver, no signature check, plain text. */
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"];
const LOG_FORMAT = "--format=%x1e%H%x1f%h%x1f%ct%x1f%P%x1f%an%x1f%s";
/** Where a branch range is measured from when the branch has no upstream. Fixed refs, never client input. */
const BASE_FALLBACKS = ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"];

/** One `--numstat -z` record (`added\tremoved\tpath`); `-` counts mean a binary file. */
export function parseNumstatRecord(record: string): FolderGitFileStat | null {
  const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(record.replace(/^\n+/, ""));
  if (!m) return null;
  const binary = m[1] === "-" || m[2] === "-";
  return { path: m[3]!, added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), ...(binary ? { binary: true } : {}) };
}

export interface RawCommit { sha: string; short: string; time: number; parents: number; author: string; subject: string; stats: FolderGitFileStat[] }
/** `git log -z --numstat` with {@link LOG_FORMAT}: one `\x1e`-led record per commit, then its numstat records. */
export function parseLogZ(stdout: string): RawCommit[] {
  const out: RawCommit[] = [];
  for (const chunk of stdout.split("\x1e").slice(1)) {
    const [head = "", ...rest] = chunk.split("\0");
    const [sha = "", short = "", time = "", parents = "", author = "", ...subject] = head.split("\x1f");
    if (!FULL_SHA.test(sha)) continue;
    const stats = rest.map(parseNumstatRecord).filter((s): s is FolderGitFileStat => s !== null);
    out.push({ sha, short, time: Number(time) || 0, parents: parents.trim() ? parents.trim().split(" ").length : 0, author, subject: subject.join("\x1f"), stats });
  }
  return out;
}

/** Split stats into what the client may see and how many the Files refusal list hid. */
function visibleStats(stats: FolderGitFileStat[]): { files: FolderGitFileStat[]; hidden: number } {
  let hidden = 0; const files: FolderGitFileStat[] = [];
  for (const s of stats) { if (isHiddenPath(s.path)) hidden++; else files.push(s); }
  return { files, hidden };
}

function toCommit(raw: RawCommit, ahead: Set<string> | null): FolderGitCommit {
  const { files } = visibleStats(raw.stats);
  return { sha: raw.sha, short: raw.short, subject: raw.subject, author: raw.author, time: raw.time, parents: raw.parents, files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0), ...(ahead?.has(raw.sha) ? { ahead: true } : {}) };
}

/** Literal, top-anchored pathspecs for `paths`, capped by count and bytes. */
function literalSpecs(paths: string[]): { specs: string[]; truncated: boolean } {
  const specs: string[] = []; let size = 0;
  for (const path of paths) { const p = `:(literal,top)${path}`, n = new TextEncoder().encode(p).length + (specs.length ? 1 : 0); if (specs.length >= MAX_DIFF_PATHS || size + n > MAX_PATHSPEC_BYTES) return { specs, truncated: true }; specs.push(p); size += n; }
  return { specs, truncated: false };
}

export type RepoOpen = { ok: true; root: string; realCwd: string } | { ok: false; reason: FolderGitUnavailable };

/** Keep injected runners subject to the same hardened argv contract as the real runner. */
export function hardenedInvoke(run: GitRunner): GitRunner { return run === spawnGit ? run : (args, cwd, limits) => run([...prefix, ...args], cwd, limits); }

/** The worktree around a Files folder, proven by git itself. `invoke` is a {@link hardenedInvoke} runner. */
export async function openRepo(workRoot: string, invoke: GitRunner, dir: string): Promise<RepoOpen> {
  const realCwd = await containedRealpath(dir, workRoot); if (!realCwd) return { ok: false, reason: "outside-root" };
  const root = await findWorktreeRoot(realCwd, workRoot); if (!root) return { ok: false, reason: "not-a-repo" };
  const top = await invoke(["rev-parse", "--show-toplevel"], root); if (top.failed) return { ok: false, reason: "git-unavailable" }; if (top.timedOut) return { ok: false, reason: "timeout" }; if (top.code !== 0) return { ok: false, reason: "not-a-repo" };
  const gitRoot = await realpath(top.stdout.trim()).catch(() => ""); const sameRoot = process.platform === "win32" ? resolve(gitRoot).toLowerCase() === resolve(root).toLowerCase() : resolve(gitRoot) === resolve(root); if (!gitRoot || !sameRoot) return { ok: false, reason: "not-a-repo" };
  return { ok: true, root, realCwd };
}

export interface ResolvedBase { ref: string; name: string; upstream: boolean }
/** The ref a branch range starts from: the upstream when git knows it, else origin's default branch, main or master (never the branch itself). */
export async function resolveBase(invoke: GitRunner, root: string, st: Pick<ParsedStatus, "branch" | "upstream" | "ahead">): Promise<ResolvedBase | null> {
  if (st.upstream && st.ahead !== undefined) return { ref: "@{upstream}", name: st.upstream, upstream: true };
  for (const ref of BASE_FALLBACKS) {
    const r = await invoke(["rev-parse", "--verify", "--quiet", "--symbolic-full-name", ref], root);
    const full = r.code === 0 && !r.timedOut ? r.stdout.trim() : "";
    if (!/^refs\/(?:heads|remotes)\/\S+$/.test(full)) continue;
    if (st.branch && full === `refs/heads/${st.branch}`) continue;
    return { ref: full, name: full.replace(/^refs\/(?:heads|remotes)\//, ""), upstream: false };
  }
  return null;
}

export function createFolderGit(workRoot: string, run: GitRunner = spawnGit) {
  const invoke = hardenedInvoke(run);
  const openRepoHere = (dir: string) => openRepo(workRoot, invoke, dir);
  const resolveBaseHere = (root: string, st: Pick<ParsedStatus, "branch" | "upstream" | "ahead">) => resolveBase(invoke, root, st);

  /** Upstream, ahead/behind against the base, and the last commits on HEAD. Any failure leaves the field out. */
  async function history(root: string, st: ParsedStatus): Promise<Pick<Extract<FolderGitResponse, { available: true }>, "upstream" | "base" | "ahead" | "behind" | "commits">> {
    const out: Pick<Extract<FolderGitResponse, { available: true }>, "upstream" | "base" | "ahead" | "behind" | "commits"> = {};
    if (st.upstream) out.upstream = st.upstream;
    const base = await resolveBaseHere(root, st);
    let ahead: number | undefined, behind: number | undefined;
    if (base?.upstream) { ahead = st.ahead; behind = st.behind; }
    else if (base) {
      const c = await invoke(["rev-list", "--left-right", "--count", `${base.ref}...HEAD`, "--"], root);
      const m = c.code === 0 ? /^(\d+)\s+(\d+)\s*$/.exec(c.stdout) : null;
      if (m) { behind = Number(m[1]); ahead = Number(m[2]); }
    }
    if (base && ahead !== undefined) Object.assign(out, { base: base.name, ahead, behind: behind ?? 0 });
    let aheadSet: Set<string> | null = null;
    if (base && ahead) {
      const r = await invoke(["rev-list", "-n", String(MAX_COMMITS), `${base.ref}..HEAD`, "--"], root);
      if (r.code === 0) aheadSet = new Set(r.stdout.split("\n").map((s) => s.trim()).filter((s) => FULL_SHA.test(s)));
    }
    const log = await invoke(["log", "-n", String(MAX_COMMITS), "--no-show-signature", "--diff-merges=first-parent", ...DIFF_FLAGS, "--numstat", "-z", LOG_FORMAT, "HEAD", "--"], root);
    if (log.code === 0 && !log.timedOut) out.commits = parseLogZ(log.stdout).map((c) => toCommit(c, aheadSet));
    return out;
  }

  /** The patch for the visible files only, after their counts. */
  async function patchFor(root: string, raw: FolderGitFileStat[], countsOk: boolean, patchArgs: string[]): Promise<{ files: FolderGitFileStat[]; hidden: number; filesTruncated: boolean; diff: string; diffTruncated: boolean }> {
    const { files: all, hidden } = visibleStats(raw);
    const files = all.slice(0, MAX_STATUS_ENTRIES); const filesTruncated = all.length > files.length;
    const { specs, truncated } = literalSpecs(files.map((f) => f.path));
    let diff = "", diffTruncated = truncated || filesTruncated || !countsOk;
    if (specs.length) { const d = await invoke([...patchArgs, "--", ...specs], root); if (d.timedOut || d.code !== 0) diffTruncated = true; const cut = cutDiff(d.stdout); diff = cut.text; diffTruncated ||= cut.truncated; }
    return { files, hidden, filesTruncated, diff, diffTruncated };
  }

  return {
    async inspect(dir: string, panes: Array<{ paneId: string; cwd: string }> = []): Promise<FolderGitResponse> {
      const repo = await openRepoHere(dir); if (!repo.ok) return { available: false, reason: repo.reason };
      const { root, realCwd } = repo;
      const status = await invoke(["status", "--porcelain=v2", "--branch", "-z", "--no-renames", "--untracked-files=normal"], root); if (status.failed) return { available: false, reason: "git-unavailable" }; if (status.timedOut) return { available: false, reason: "timeout" };
      const parsed = parseStatusV2(status.stdout.split("\0").filter(Boolean)); let hidden = 0; const visible: Array<FolderGitEntry & { tracked: boolean }> = [];
      for (const e of parsed.entries) { if (isHiddenPath(e.path)) hidden++; else if (visible.length < MAX_STATUS_ENTRIES) visible.push(e); }
      const statusTruncated = parsed.entries.filter((e) => !isHiddenPath(e.path)).length > visible.length;
      const { specs: paths, truncated } = literalSpecs(visible.filter((e) => e.tracked).map((e) => e.path)); let diffTruncated = statusTruncated || truncated;
      let diff = ""; if (!parsed.noCommits && paths.length) { const d = await invoke(["diff", ...DIFF_FLAGS, "-U3", "HEAD", "--", ...paths], root); if (d.timedOut || d.code !== 0) diffTruncated = true; const cut = cutDiff(d.stdout); diff = cut.text; diffTruncated ||= cut.truncated; }
      const seen = new Set<string>(); const inRepo: string[] = [];
      for (const p of panes.slice(0, MAX_PANE_IDS)) { if (seen.has(p.paneId)) continue; seen.add(p.paneId); if (await containedRealpath(p.cwd, root)) inRepo.push(p.paneId); }
      const rootPath = await relInRoot(workRoot, root);
      const past = parsed.noCommits ? (parsed.upstream ? { upstream: parsed.upstream } : {}) : await history(root, parsed);
      return { available: true, repo: basename(root), rel: relative(root, realCwd).split(sep).join("/"), ...(parsed.branch ? { branch: parsed.branch } : {}), ...(parsed.detached ? { detached: true } : {}), ...(parsed.noCommits ? { noCommits: true } : {}), clean: visible.length === 0 && hidden === 0, entries: visible.map(({ tracked: _tracked, ...e }) => e), hidden, statusTruncated, diff, diffTruncated, panes: inRepo, ...(rootPath === null ? {} : { rootPath }), ...past };
    },

    /** One commit's diff (against its first parent), or the branch range `base...HEAD` (from their merge base). */
    async diff(dir: string, q: { scope: "commit"; sha: string } | { scope: "branch" }): Promise<FolderGitDiffResponse> {
      if (q.scope === "commit" && !SHA_RE.test(q.sha)) return { available: false, reason: "bad-commit" };
      const repo = await openRepoHere(dir); if (!repo.ok) return { available: false, reason: repo.reason };
      const { root } = repo;
      if (q.scope === "commit") {
        const v = await invoke(["rev-parse", "--verify", "--quiet", `${q.sha}^{commit}`], root);
        if (v.failed) return { available: false, reason: "git-unavailable" }; if (v.timedOut) return { available: false, reason: "timeout" };
        const full = v.code === 0 ? v.stdout.trim() : ""; if (!FULL_SHA.test(full)) return { available: false, reason: "bad-commit" };
        const numstat = ["log", "-n", "1", "--no-show-signature", "--diff-merges=first-parent", ...DIFF_FLAGS, "--numstat", "-z", LOG_FORMAT, full, "--"];
        const meta = await invoke(numstat, root); if (meta.timedOut) return { available: false, reason: "timeout" };
        const raw = meta.code === 0 ? parseLogZ(meta.stdout)[0] : undefined; if (!raw || raw.sha !== full) return { available: false, reason: "bad-commit" };
        const r = await patchFor(root, raw.stats, true, ["show", "--format=", "--no-show-signature", "--diff-merges=first-parent", ...DIFF_FLAGS, "-U3", full]);
        return { available: true, scope: "commit", commit: toCommit(raw, null), ...r };
      }
      const status = await invoke(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"], root);
      if (status.failed) return { available: false, reason: "git-unavailable" }; if (status.timedOut) return { available: false, reason: "timeout" };
      const st = parseStatusV2(status.stdout.split("\0").filter(Boolean)); if (st.noCommits) return { available: false, reason: "no-base" };
      const base = await resolveBaseHere(root, st); if (!base) return { available: false, reason: "no-base" };
      const range = `${base.ref}...HEAD`;
      const counts = await invoke(["diff", ...DIFF_FLAGS, "--numstat", "-z", range, "--"], root); if (counts.timedOut) return { available: false, reason: "timeout" };
      const raw = counts.code === 0 ? counts.stdout.split("\0").map(parseNumstatRecord).filter((s): s is FolderGitFileStat => s !== null) : [];
      const r = await patchFor(root, raw, counts.code === 0, ["diff", ...DIFF_FLAGS, "-U3", range]);
      return { available: true, scope: "branch", base: base.name, ...r };
    },
  };
}
