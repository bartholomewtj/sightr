// Pattern of T3 Code apps/server/src/vcs/GitVcsDriver.ts `checkpoints.captureCheckpoint` (MIT, see web2/THIRD_PARTY.md):
// a temp index seeded from the real one, `add`, `write-tree`, `commit-tree` with HEAD as parent, `update-ref`.
// T3 writes its hidden refs and objects into the user's repo; Sightr writes NOTHING there (spec T30). Every
// snapshot goes into a private bare repo Sightr owns, `<stateDir>/checkpoints/<repoKey>.git`, with:
//   GIT_DIR=<private>             refs, config, logs, hooks dir, info/exclude: all private
//   GIT_OBJECT_DIRECTORY=<private>/objects            every object write lands here
//   GIT_ALTERNATE_OBJECT_DIRECTORIES=<real objects>   read-only reuse of the blobs and trees the repo has
//   GIT_INDEX_FILE=<stateDir>/checkpoint-tmp/<uuid>.index  (and its `.lock`) deleted in `finally`
//   GIT_WORK_TREE=<repo root>     read only: `add` hashes the files, never writes them
// The only calls that run against the real repo are `rev-parse` (paths, HEAD) and `config --get-regexp`
// (the line-ending, link, case and ignore settings the scrubbed env hides), both reads. Every call goes
// through workdir-git's hardened runner (hooks to /dev/null, no fsmonitor, no pager, no external diff,
// system and global config nulled, `GIT_OPTIONAL_LOCKS=0`) plus `-c diff.autoRefreshIndex=false
// --no-optional-locks`, a subcommand allowlist per side, a byte cap on stdout, the remaining budget as its
// timeout and workdir-git's pipe grace period.
//
// One side effect on the real repo git itself causes and no option turns off: when git writes an object
// that already exists in an alternate (a file reverted to a committed version, an unchanged tree), it
// "freshens" that object by setting its mtime (git's object-file.c `check_and_freshen_nonlocal`). Content,
// names, refs, index, config, hooks and logs are untouched; only that object file's (or pack's) mtime
// moves, which delays its pruning. The tests pin the byte-identity and say so.
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { REVIEW_GIT_PREFIX } from "../workdir-review.ts";
import { FULL_SHA, hardenedInvoke, isHiddenPath, spawnGit, type GitLimits, type GitRun, type GitRunner } from "../workdir-git.ts";

export const SNAPSHOT_BUDGET_MS = 20_000;
export const SETTLE_DELAY_MS = 250;
export const SETTLE_ROUNDS = 3;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_UNTRACKED_FILES = 5_000;
export const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;
export const MAX_TRACKED_CHANGES = 20_000;
export const GC_TIMEOUT_MS = 120_000;
/** Snapshots, patch captures and gc in different private stores that may run at once. */
export const MAX_ACTIVE_STORES = 2;
/** Bound on list-shaped output (`ls-files`, `diff-files`, `for-each-ref`); past it the side is `too-large`. */
export const LIST_CAP_BYTES = 32 * 1024 * 1024;
/** Bound on calls that print an oid, a path or a few lines. */
export const SMALL_CAP_BYTES = 64 * 1024;
/** Tracked refused-name paths whose stat is remembered per snapshot (to count `hidden`). */
export const MAX_HIDDEN_STATS = 1_000;
export const STORES_DIR = "checkpoints";
export const TMP_DIR = "checkpoint-tmp";
/** The file in each private store naming the repo it belongs to (for the orphan sweep). */
export const STORE_META = "sightr-repo.json";
const ZERO_OID = "0".repeat(40);

/**
 * The only subcommands a checkpoint call may run, by side. `real` runs in the user's repo with the plain
 * hardened env and only reads (`config` is limited to `--get-regexp` below). `private` runs with the
 * private-store env above (or in the store alone), so whatever it writes lands under the state dir.
 */
export const CHECKPOINT_SUBCOMMANDS = {
  real: ["rev-parse", "config"],
  private: ["init", "rev-parse", "update-index", "diff-files", "ls-files", "read-tree", "add", "write-tree", "commit-tree", "update-ref", "diff", "cat-file", "ls-tree", "for-each-ref", "gc"],
} as const;

/**
 * Passed on every checkpoint call. Long paths on Windows; no CRLF refusal and no reflog; never sign; no
 * auto-gc or maintenance; a split or untracked-cache index is never written; the fsmonitor stays off.
 */
export const SNAPSHOT_CONFIG = [
  "-c", "core.longpaths=true",
  "-c", "core.safecrlf=false",
  "-c", "core.logAllRefUpdates=false",
  "-c", "commit.gpgsign=false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "core.splitIndex=false",
  "-c", "core.untrackedCache=false",
  "-c", "core.fsmonitor=false",
] as const;

/** Real-repo settings the scrubbed env hides but a snapshot must honour, so blobs match what the operator's `git status` sees. */
const CONFIG_KEYS = ["core.autocrlf", "core.eol", "core.symlinks", "core.ignorecase", "core.filemode", "core.excludesfile"] as const;
const CONFIG_RE = "^core\\.(autocrlf|eol|symlinks|ignorecase|filemode|excludesfile)$";
const BOOL_VALUES = new Set(["true", "false", "yes", "no", "on", "off", "1", "0"]);

/** `-c key=value` pairs from `key value` lines (`git config --get-regexp`), keeping only values git would accept. */
export function configPairs(text: string, home = process.env.HOME ?? process.env.USERPROFILE ?? "", base = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^(\S+) (.*)$/.exec(line.replace(/\r$/, ""));
    if (!m) continue;
    const key = m[1]!.toLowerCase(), raw = m[2]!.trim(), value = raw.toLowerCase();
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) continue;
    if (key === "core.autocrlf" && !["true", "false", "input"].includes(value)) continue;
    if (key === "core.eol" && !["lf", "crlf", "native"].includes(value)) continue;
    if (["core.symlinks", "core.ignorecase", "core.filemode"].includes(key) && !BOOL_VALUES.has(value)) continue;
    if (key === "core.excludesfile") {
      if (!raw || raw.length > 4096 || /[\0\n]/.test(raw)) continue;
      const expanded = raw.startsWith("~/") && home ? join(home, raw.slice(2)) : raw;
      out.set(key, isAbsolute(expanded) || !base ? expanded : resolve(base, expanded));
      continue;
    }
    out.set(key, value);
  }
  return out;
}

let globalConfig: Promise<Map<string, string>> | null = null;
/** The operator's system + global values of {@link CONFIG_KEYS}, read once from a non-repo cwd (workdir-git's `readEffectiveAutocrlf` pattern, generalised). */
export function readGlobalCheckpointConfig(): Promise<Map<string, string>> {
  globalConfig ??= (async () => {
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^GIT_/i.test(k)) env[k] = v;
      const proc = Bun.spawn(["git", "config", "--get-regexp", CONFIG_RE], { cwd: tmpdir(), stdout: "pipe", stderr: "ignore", env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
      await proc.exited;
      return configPairs(await new Response(proc.stdout).text());
    } catch {
      return new Map();
    }
  })();
  return globalConfig;
}

/** What a snapshot needs to know about one repo. Paths are realpaths; nothing here is ever sent to a client. */
export interface RepoInfo {
  root: string;
  gitDir: string;
  repoKey: string;
  /** `<stateDir>/checkpoints/<repoKey>.git` */
  store: string;
  indexPath: string;
  objectsDir: string;
  excludePath: string;
  /** `-c` pairs for the effective {@link CONFIG_KEYS}. */
  config: string[];
}

export type SnapshotSide = "start" | "end";
export type SnapshotFailure = "too-large" | "timeout" | "git-failed";
/** A window that closed while the snapshot waited for its store. */
export type SnapshotSkip = "start-missed" | "end-missed";
/** The private store's queue key: its repo key (the store's folder name without `.git`). */
export const storeKey = (store: string): string => basename(store).replace(/\.git$/, "");
export type SnapshotOutcome =
  | {
      ok: true;
      commit: string;
      /** The ref already existed (a retry or a replay): nothing was written. */
      reused: boolean;
      /** Untracked files left out: refused names, links, files over {@link MAX_FILE_BYTES}, unreadable ones. */
      skipped: number;
      /** Paths git could not read (locked, too long): dropped from every file list. */
      skippedPaths: string[];
      unsettled: boolean;
      /** Tracked refused-name paths that differ from the index, with `size:mtime` (or `gone`). */
      hiddenStats: Record<string, string>;
      capturedAt: number;
    }
  | { ok: false; reason: SnapshotFailure; truncated?: boolean; detail?: string };

/** A ref segment for a thread id: the id itself when it is plain, else a hash of it. */
export function refId(threadId: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(threadId) ? threadId : createHash("sha256").update(threadId).digest("hex").slice(0, 32);
}
export const checkpointRef = (threadId: string, ordinal: number, side: SnapshotSide): string => `refs/checkpoints/${refId(threadId)}/${Math.trunc(ordinal)}/${side}`;
/** The private store's key: sha256 (first 32 hex) of the lower-cased realpath of the repo's git dir. */
export const repoKeyOf = (gitDir: string): string => createHash("sha256").update(gitDir.toLowerCase()).digest("hex").slice(0, 32);
/** `GIT_ALTERNATE_OBJECT_DIRECTORIES` for one directory: C-quoted when it holds the list separator or a quote. */
export function alternatesValue(dir: string, sep = process.platform === "win32" ? ";" : ":"): string {
  return dir.includes(sep) || dir.includes('"') ? `"${dir.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : dir;
}
const samePath = (a: string, b: string): boolean => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

class Stop extends Error {
  constructor(readonly reason: SnapshotFailure, readonly truncated = false, detail?: string) { super(detail ?? reason); }
}

/** Paths git named on stderr as unreadable during `add`, and whether every non-empty line was understood. */
export function parseAddErrors(stderr: string): { paths: string[]; understood: boolean } {
  const paths: string[] = []; let understood = true;
  for (const line of stderr.split("\n").map((l) => l.replace(/\r$/, ""))) {
    if (!line.trim()) continue;
    let m: RegExpExecArray | null;
    if ((m = /^error: open\("(.+)"\): /.exec(line))) paths.push(m[1]!);
    else if ((m = /^error: unable to index file '(.+)'$/.exec(line))) paths.push(m[1]!);
    else if ((m = /^error: (.+): (?:failed to insert into database|short read .*)$/.exec(line))) paths.push(m[1]!);
    else if ((m = /^error: readlink\("(.+)"\): /.exec(line))) paths.push(m[1]!);
    else if ((m = /^(?:warning|error): could not open directory '(.+)': /.exec(line))) paths.push(m[1]!.replace(/\/$/, ""));
    else if (/^fatal: (?:adding files failed|updating files failed|unable to (?:stat|index) file)/.test(line)) continue;
    else if (/^warning: in the working copy of '/.test(line)) continue;
    else if (/^(?:hint|warning): /.test(line) && !/^warning: could not/.test(line)) continue;
    else understood = false;
  }
  return { paths: [...new Set(paths)], understood };
}

/** A per-store FIFO with at most `maxActive` stores busy at once. `deadline` (epoch ms) gives up a wait: the result is `BUSY`. */
export const BUSY = Symbol("busy");
export function createStoreQueue(maxActive = MAX_ACTIVE_STORES) {
  const tails = new Map<string, Promise<unknown>>();
  let active = 0; const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> => (active < maxActive ? (active++, Promise.resolve()) : new Promise<void>((r) => waiting.push(r)));
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };
  return {
    get active() { return active; },
    run<T>(key: string, task: () => Promise<T>, deadline?: number): Promise<T | typeof BUSY> {
      const prev = tails.get(key) ?? Promise.resolve();
      const p = prev.catch(() => {}).then(async (): Promise<T | typeof BUSY> => {
        await acquire();
        try {
          if (deadline !== undefined && Date.now() >= deadline) return BUSY;
          return await task();
        } finally { release(); }
      });
      const tail = p.catch(() => {});
      tails.set(key, tail);
      void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
      return p;
    },
    /** Resolves when every queued task has run (tests). */
    async idle(): Promise<void> { while (tails.size > 0) await Promise.all([...tails.values()]); },
  };
}

export interface CheckpointGitOptions {
  stateDir: string;
  /** The runner (default workdir-git's `spawnGit`); an injected one gets the hardened prefix too. */
  run?: GitRunner;
  now?: () => number;
  budgetMs?: number;
  settleDelayMs?: number;
  maxActiveStores?: number;
  /** System + global config (default {@link readGlobalCheckpointConfig}). */
  globalConfig?: () => Promise<Map<string, string>>;
  sleep?: (ms: number) => Promise<void>;
  /** The caps (tests lower them; the defaults are the spec's). */
  caps?: Partial<SnapshotCaps>;
}

export interface SnapshotCaps { maxFileBytes: number; maxUntrackedFiles: number; maxUntrackedBytes: number; maxTrackedChanges: number }
export const SNAPSHOT_CAPS: SnapshotCaps = { maxFileBytes: MAX_FILE_BYTES, maxUntrackedFiles: MAX_UNTRACKED_FILES, maxUntrackedBytes: MAX_UNTRACKED_BYTES, maxTrackedChanges: MAX_TRACKED_CHANGES };

export type CheckpointGit = ReturnType<typeof createCheckpointGit>;

export function createCheckpointGit(opts: CheckpointGitOptions) {
  const invoke = hardenedInvoke(opts.run ?? spawnGit);
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? SNAPSHOT_BUDGET_MS;
  const settleDelayMs = opts.settleDelayMs ?? SETTLE_DELAY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const readGlobal = opts.globalConfig ?? readGlobalCheckpointConfig;
  const storesDir = join(opts.stateDir, STORES_DIR);
  const tmpDir = join(opts.stateDir, TMP_DIR);
  const queue = createStoreQueue(opts.maxActiveStores ?? MAX_ACTIVE_STORES);
  const caps: SnapshotCaps = { ...SNAPSHOT_CAPS, ...opts.caps };

  /** One checkpoint git call: allowlisted subcommand, review prefix, snapshot config, bounded stdout, a timeout. */
  async function call(side: "real" | "private", args: string[], cwd: string, limits: GitLimits & { config?: string[] } = {}): Promise<GitRun> {
    const sub = args[0];
    if (sub === undefined || !(CHECKPOINT_SUBCOMMANDS[side] as readonly string[]).includes(sub)) throw new Error(`checkpoint: git ${sub} is not allowed (${side})`);
    if (side === "real" && sub === "config" && (args[1] !== "--get-regexp" || args.length !== 3)) throw new Error("checkpoint: only `config --get-regexp <re>` reads the real repo's config");
    if (side === "real" && limits.extraEnv) throw new Error("checkpoint: a real-repo call takes no extra env");
    if (side === "private" && !limits.extraEnv?.GIT_DIR) throw new Error("checkpoint: a private call needs GIT_DIR");
    const { config = [], ...rest } = limits;
    return invoke([...REVIEW_GIT_PREFIX, ...SNAPSHOT_CONFIG, ...config, ...args], cwd, { maxStdoutBytes: SMALL_CAP_BYTES, ...rest });
  }

  /** A call inside a snapshot's budget: a spawn failure or a timeout stops the snapshot. */
  function budgeted(deadline: number) {
    return async (side: "real" | "private", args: string[], cwd: string, limits: GitLimits & { config?: string[] } = {}): Promise<GitRun> => {
      const left = deadline - now();
      if (left <= 0) throw new Stop("timeout");
      const r = await call(side, args, cwd, { ...limits, timeoutMs: Math.min(left, limits.timeoutMs ?? left) });
      if (r.failed) throw new Stop("git-failed", false, `git ${args[0]} could not start`);
      if (r.timedOut) throw new Stop("timeout");
      return r;
    };
  }

  // ── Repo discovery ─────────────────────────────────────────────────────────────────────────────

  const infoCache = new Map<string, { at: number; info: RepoInfo | null }>();
  /** The real git dir, index, objects dir and exclude file of the worktree at `root` (a realpath), and its private store. Reads only. */
  async function resolveRepo(root: string): Promise<RepoInfo | null> {
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    const hit = infoCache.get(key); if (hit && now() - hit.at < 60_000) return hit.info;
    const info = await resolveRepoUncached(root).catch(() => null);
    infoCache.set(key, { at: now(), info });
    return info;
  }
  async function resolveRepoUncached(root: string): Promise<RepoInfo | null> {
    const r = await call("real", ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-path", "index", "--git-path", "objects", "--git-path", "info/exclude"], root);
    if (r.failed || r.timedOut || r.code !== 0) return null;
    const [gitDirRaw, indexRaw, objectsRaw, excludeRaw] = r.stdout.split("\n").map((l) => l.replace(/\r$/, ""));
    if (!gitDirRaw || !indexRaw || !objectsRaw || !excludeRaw) return null;
    const gitDir = await realpath(gitDirRaw);
    const objectsDir = await realpath(objectsRaw);
    // The index and exclude file may not exist yet; their folders do.
    const real = async (p: string) => join(await realpath(dirname(p)).catch(() => dirname(p)), basename(p));
    const repoKey = repoKeyOf(gitDir);
    const local = await call("real", ["config", "--get-regexp", CONFIG_RE], root);
    const merged = new Map(await readGlobal());
    if (!local.failed && !local.timedOut && local.code === 0) for (const [k, v] of configPairs(local.stdout, undefined, root)) merged.set(k, v);
    const config: string[] = [];
    for (const [k, v] of merged) config.push("-c", `${k}=${v}`);
    return { root, gitDir, repoKey, store: join(storesDir, `${repoKey}.git`), indexPath: await real(indexRaw), objectsDir, excludePath: await real(excludeRaw), config };
  }

  /** The env that points git at a private store; with `index`, a snapshot's temp index and the worktree too. */
  function storeEnv(info: Pick<RepoInfo, "store" | "objectsDir" | "root">, index?: string): Record<string, string> {
    return {
      GIT_DIR: info.store,
      GIT_OBJECT_DIRECTORY: join(info.store, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesValue(info.objectsDir),
      ...(index ? { GIT_INDEX_FILE: index, GIT_WORK_TREE: info.root } : {}),
    };
  }

  async function ensureStore(info: RepoInfo, run: ReturnType<typeof budgeted>): Promise<void> {
    if (!(await stat(join(info.store, "HEAD")).catch(() => null))) {
      await mkdir(storesDir, { recursive: true, mode: 0o700 });
      // `init` makes the bare store; GIT_DIR names it so nothing else is touched. No templates: no sample hooks.
      const r = await run("private", ["init", "--bare", "--quiet", "--template=", info.store], storesDir, { extraEnv: { GIT_DIR: info.store }, config: ["-c", "init.defaultBranch=main"] });
      if (r.code !== 0) throw new Stop("git-failed", false, `init: ${r.stderr.trim()}`);
    }
    await writeFile(join(info.store, STORE_META), JSON.stringify({ root: info.root, gitDir: info.gitDir, objectsDir: info.objectsDir }));
  }

  // ── Snapshot ───────────────────────────────────────────────────────────────────────────────────

  async function snapshotNow(info: RepoInfo, req: { threadId: string; ordinal: number; side: SnapshotSide }): Promise<SnapshotOutcome> {
    const deadline = now() + budgetMs;
    const run = budgeted(deadline);
    const ref = checkpointRef(req.threadId, req.ordinal, req.side);
    const base = { config: info.config };
    await ensureStore(info, run);
    const store = storeEnv(info);
    // A ref, once written, is never moved: a retry or a replay reuses it.
    const have = await run("private", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], info.store, { ...base, extraEnv: store });
    if (have.code === 0 && FULL_SHA.test(have.stdout.trim())) return { ok: true, commit: have.stdout.trim(), reused: true, skipped: 0, skippedPaths: [], unsettled: false, hiddenStats: {}, capturedAt: now() };

    const headRun = await run("real", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], info.root);
    const head = headRun.code === 0 && FULL_SHA.test(headRun.stdout.trim()) ? headRun.stdout.trim() : null;

    // The real info/exclude (or an empty one) is the store's, so `--exclude-standard` reads the operator's rules.
    await mkdir(join(info.store, "info"), { recursive: true });
    await writeFile(join(info.store, "info", "exclude"), await readFile(info.excludePath).catch(() => ""));

    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const index = join(tmpDir, `${randomUUID()}.index`);
    const env = storeEnv(info, index);
    const priv = (args: string[], limits: GitLimits = {}) => run("private", args, info.root, { ...base, ...limits, extraEnv: { ...env, ...limits.extraEnv } });
    try {
      // 1. Seed: a copy of the real index keeps its stat cache, so only changed files are rehashed. Its
      // mtime is set a second below the original's so git's racy-entry check still sees what it saw.
      let seeded = false;
      try {
        const src = await stat(info.indexPath);
        await copyFile(info.indexPath, index);
        const t = Math.floor((src.mtimeMs - 1000) / 1000);
        if (t > 0) await utimes(index, t, t);
        seeded = true;
      } catch { seeded = false; }
      let refresh = seeded ? await priv(["update-index", "-q", "--refresh"]) : null;
      if (!refresh || (refresh.code !== 0 && refresh.code !== 1)) {
        // The copy is gone or git refused it (a split index, a newer format): start from HEAD, or empty.
        await rm(index, { force: true });
        if (head) { const rt = await priv(["read-tree", head]); if (rt.code !== 0) throw new Stop("git-failed", false, `read-tree: ${rt.stderr.trim()}`); }
        refresh = await priv(["update-index", "-q", "--refresh"]);
        if (refresh.code !== 0 && refresh.code !== 1) throw new Stop("git-failed", false, `update-index: ${refresh.stderr.trim()}`);
      }

      // 2. Pre-flight caps. A partial tree is never committed: a cut snapshot would read as mass deletions.
      const dirty = await priv(["diff-files", "-z", "--name-only"], { maxStdoutBytes: LIST_CAP_BYTES });
      if (dirty.overflow) throw new Stop("too-large", true);
      if (dirty.code !== 0) throw new Stop("git-failed", false, `diff-files: ${dirty.stderr.trim()}`);
      const dirtyPaths = [...new Set(dirty.stdout.split("\0").filter(Boolean))];
      if (dirtyPaths.length > caps.maxTrackedChanges) throw new Stop("too-large", true);

      const others = await priv(["ls-files", "-z", "--others", "--exclude-standard"], { maxStdoutBytes: LIST_CAP_BYTES });
      if (others.overflow) throw new Stop("too-large", true);
      if (others.code !== 0) throw new Stop("git-failed", false, `ls-files: ${others.stderr.trim()}`);
      let skipped = 0, bytes = 0; const allowed: string[] = [];
      for (const p of others.stdout.split("\0")) {
        if (!p || p.endsWith("/")) continue; // an embedded repository: not a file
        if (isHiddenPath(p)) { skipped++; continue; }
        const st = await lstat(join(info.root, ...p.split("/"))).catch(() => null);
        if (!st) continue; // gone since the listing
        if (st.isSymbolicLink() || !st.isFile()) { skipped++; continue; }
        if (st.size > caps.maxFileBytes) { skipped++; continue; }
        allowed.push(p); bytes += st.size;
        if (allowed.length > caps.maxUntrackedFiles || bytes > caps.maxUntrackedBytes) throw new Stop("too-large", true);
      }

      // Refused names never enter a snapshot: tracked ones leave the temp index before anything is hashed.
      const cached = await priv(["ls-files", "-z", "--cached"], { maxStdoutBytes: LIST_CAP_BYTES });
      if (cached.overflow) throw new Stop("too-large", true);
      if (cached.code !== 0) throw new Stop("git-failed", false, `ls-files: ${cached.stderr.trim()}`);
      const hiddenTracked = [...new Set(cached.stdout.split("\0").filter((p) => p && isHiddenPath(p)))];
      if (hiddenTracked.length > 0) {
        const rmh = await priv(["update-index", "--force-remove", "-z", "--stdin"], { stdin: hiddenTracked.join("\0") + "\0" });
        if (rmh.code !== 0) throw new Stop("git-failed", false, `update-index --force-remove: ${rmh.stderr.trim()}`);
      }
      const hiddenStats: Record<string, string> = {};
      for (const p of dirtyPaths) {
        if (!isHiddenPath(p) || Object.keys(hiddenStats).length >= MAX_HIDDEN_STATS) continue;
        const st = await lstat(join(info.root, ...p.split("/"))).catch(() => null);
        hiddenStats[p] = st ? `${st.size}:${Math.trunc(st.mtimeMs)}` : "gone";
      }

      // 3. Tracked edits and deletions, then the allowed untracked files (as literal paths).
      const unreadable = new Set<string>();
      const addTracked = async () => {
        const a = await priv(["add", "-u", "--ignore-errors"]);
        const e = parseAddErrors(a.stderr);
        if (a.code !== 0 && (!e.understood || e.paths.length === 0)) throw new Stop("git-failed", false, `add -u: ${a.stderr.trim()}`);
        for (const p of e.paths) unreadable.add(p);
      };
      await addTracked();
      let pending = allowed;
      for (let attempt = 0; pending.length > 0 && attempt < 5; attempt++) {
        const a = await priv(["add", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"], { stdin: pending.join("\0") + "\0", extraEnv: { GIT_LITERAL_PATHSPECS: "1" } });
        const gone = /^fatal: pathspec '(.+)' did not match any files$/m.exec(a.stderr);
        if (a.code !== 0 && gone) { pending = pending.filter((p) => p !== gone[1]); continue; } // deleted since the listing
        const e = parseAddErrors(a.stderr);
        if (a.code !== 0 && (!e.understood || e.paths.length === 0)) throw new Stop("git-failed", false, `add: ${a.stderr.trim()}`);
        for (const p of e.paths) unreadable.add(p);
        pending = [];
      }
      if (pending.length > 0) throw new Stop("git-failed", false, "add: files kept vanishing");

      // 4. Settle: the agent may still be writing. Equal trees twice in a row, or keep the last and say so.
      const writeTree = async (): Promise<string> => {
        const w = await priv(["write-tree"]);
        const oid = w.stdout.trim();
        if (w.code !== 0 || !FULL_SHA.test(oid)) throw new Stop("git-failed", false, `write-tree: ${w.stderr.trim()}`);
        return oid;
      };
      let tree = await writeTree(); let unsettled = true;
      for (let round = 0; round < SETTLE_ROUNDS; round++) {
        if (deadline - now() <= settleDelayMs) throw new Stop("timeout");
        await sleep(settleDelayMs);
        await addTracked();
        const again = await writeTree();
        if (again === tree) { unsettled = false; break; }
        tree = again;
      }

      // 5. The commit: no hooks run, nothing is signed, HEAD (when born) is the parent.
      const at = now(); const date = `@${Math.floor(at / 1000)} +0000`;
      const ct = await priv(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `sightr checkpoint ${refId(req.threadId)} ${Math.trunc(req.ordinal)} ${req.side}`], {
        extraEnv: { GIT_AUTHOR_NAME: "Sightr", GIT_AUTHOR_EMAIL: "sightr@localhost", GIT_COMMITTER_NAME: "Sightr", GIT_COMMITTER_EMAIL: "sightr@localhost", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
      const commit = ct.stdout.trim();
      if (ct.code !== 0 || !FULL_SHA.test(commit)) throw new Stop("git-failed", false, `commit-tree: ${ct.stderr.trim()}`);

      // 6. The ref, only if it does not exist yet (old value all zeros); a lost race reuses the winner.
      const ur = await run("private", ["update-ref", ref, commit, ZERO_OID], info.store, { ...base, extraEnv: store });
      if (ur.code !== 0) {
        const again = await run("private", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], info.store, { ...base, extraEnv: store });
        if (again.code === 0 && FULL_SHA.test(again.stdout.trim())) return { ok: true, commit: again.stdout.trim(), reused: true, skipped: 0, skippedPaths: [], unsettled: false, hiddenStats: {}, capturedAt: at };
        throw new Stop("git-failed", false, `update-ref: ${ur.stderr.trim()}`);
      }
      return { ok: true, commit, reused: false, skipped: skipped + unreadable.size, skippedPaths: [...unreadable].sort(), unsettled, hiddenStats, capturedAt: at };
    } catch (err) {
      if (err instanceof Stop) return { ok: false, reason: err.reason, ...(err.truncated ? { truncated: true } : {}), detail: err.message };
      return { ok: false, reason: "git-failed", detail: (err as Error).message };
    } finally {
      await rm(index, { force: true }).catch(() => {});
      await rm(`${index}.lock`, { force: true }).catch(() => {});
    }
  }

  /**
   * One side of a run's checkpoint, queued behind any other work on the same private store. `check` runs
   * when the snapshot is about to start (after the queue wait): a reason it returns skips the snapshot.
   */
  async function snapshot(info: RepoInfo, req: { threadId: string; ordinal: number; side: SnapshotSide }, check?: () => SnapshotSkip | null): Promise<SnapshotOutcome | { ok: false; reason: SnapshotSkip }> {
    const r = await queue.run(info.repoKey, async () => {
      const skip = check?.(); if (skip) return { ok: false as const, reason: skip };
      return snapshotNow(info, req);
    });
    return r === BUSY ? { ok: false, reason: "timeout" } : r;
  }

  // ── Store-only calls (diff, blobs, refs, gc) ───────────────────────────────────────────────────

  /** A runner bound to one store (no worktree, no index): for diffs and blob reads between two commits. */
  function storeRunner(info: Pick<RepoInfo, "store" | "objectsDir" | "root">) {
    const extraEnv = storeEnv(info);
    return (args: string[], limits: GitLimits = {}) => call("private", args, info.store, { ...limits, extraEnv: { ...extraEnv, ...limits.extraEnv } });
  }
  /** A runner for a store dir alone (ref listing and deletion; no alternates needed). */
  function bareRunner(store: string) {
    return (args: string[], limits: GitLimits = {}) => call("private", args, store, { ...limits, extraEnv: { GIT_DIR: store, GIT_OBJECT_DIRECTORY: join(store, "objects"), ...limits.extraEnv } });
  }

  /** The refs under `refs/checkpoints/` in a store. Null when git could not list them. */
  async function listRefs(store: string): Promise<string[] | null> {
    const r = await bareRunner(store)(["for-each-ref", "--format=%(refname)", "refs/checkpoints/"], { maxStdoutBytes: LIST_CAP_BYTES });
    if (r.code !== 0 || r.overflow || r.timedOut) return null;
    return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("refs/checkpoints/"));
  }
  async function deleteRefs(store: string, refs: string[]): Promise<boolean> {
    if (refs.length === 0) return true;
    const r = await bareRunner(store)(["update-ref", "--stdin"], { stdin: refs.filter((ref) => /^refs\/checkpoints\/[A-Za-z0-9_-]+\/\d+\/(?:start|end)$/.test(ref)).map((ref) => `delete ${ref}\n`).join("") });
    return r.code === 0;
  }
  /** `gc --prune=now` in the private store only. Local objects only (gc's repack is `-l`); the real repo's are never touched. */
  async function gc(info: { store: string; objectsDir: string | null }): Promise<boolean> {
    const extraEnv: Record<string, string> = { GIT_DIR: info.store, GIT_OBJECT_DIRECTORY: join(info.store, "objects"), ...(info.objectsDir ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesValue(info.objectsDir) } : {}) };
    const r = await call("private", ["gc", "--prune=now", "--quiet"], info.store, { extraEnv, timeoutMs: GC_TIMEOUT_MS });
    return r.code === 0 && !r.timedOut;
  }
  /**
   * The store's object bytes on disk: every file under its `objects/` (loose, packs, garbage). Measured on
   * the store, not summed from rows. Not `count-objects -v`: git for Windows reports loose objects as 0 KiB
   * there (it sizes them by `st_blocks`, which Windows leaves at 0).
   */
  async function storeBytes(store: string): Promise<number | null> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) total += (await stat(p).catch(() => null))?.size ?? 0;
      }
    };
    try { await walk(join(store, "objects")); return total; } catch { return null; }
  }
  /** Every private store on disk with the repo it names (null when its meta file is missing or unreadable). */
  async function listStores(): Promise<Array<{ store: string; root: string | null; objectsDir: string | null }>> {
    const names = await readdir(storesDir).catch(() => [] as string[]);
    const out: Array<{ store: string; root: string | null; objectsDir: string | null }> = [];
    for (const name of names) {
      if (!/^[0-9a-f]{32}\.git$/.test(name)) continue;
      const store = join(storesDir, name);
      const meta = await readFile(join(store, STORE_META), "utf8").then((t) => JSON.parse(t) as { root?: unknown; objectsDir?: unknown }).catch(() => null);
      out.push({ store, root: typeof meta?.root === "string" ? meta.root : null, objectsDir: typeof meta?.objectsDir === "string" ? meta.objectsDir : null });
    }
    return out;
  }
  async function removeStore(store: string): Promise<void> {
    if (!/^[0-9a-f]{32}\.git$/.test(basename(store)) || !samePath(dirname(store), storesDir)) throw new Error("checkpoint: not a private store");
    await rm(store, { recursive: true, force: true });
  }
  /** Empty the temp-index dir (bridge start: a crash can leave one behind). */
  async function cleanTmp(): Promise<void> {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    resolveRepo, snapshot,
    /** {@link snapshot} for a caller already holding the store's queue slot (`queue.run(info.repoKey, …)`), so it can record the result before the slot is let go. */
    snapshotLocked: snapshotNow,
    storeRunner, listRefs, deleteRefs, gc, storeBytes, listStores, removeStore, cleanTmp, queue, storesDir, tmpDir, storeEnv,
  };
}
