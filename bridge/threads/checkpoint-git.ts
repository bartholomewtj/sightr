// Pattern of T3 Code apps/server/src/vcs/GitVcsDriver.ts `checkpoints.captureCheckpoint` (MIT, see web2/THIRD_PARTY.md):
// a temp index seeded from the real one, `add`, `write-tree`, `commit-tree`, `update-ref`. T3 parents each
// checkpoint on HEAD; here they have no parent, so a gc in the store never walks (or, in a shallow clone,
// trips over) the user's history. T3 writes its hidden refs and objects into the user's repo; Sightr writes
// NOTHING there (spec T30). Every snapshot goes into a private bare repo Sightr owns,
// `<stateDir>/checkpoints/<repoKey>.git`, with:
//   GIT_DIR=<private>             refs, config, logs, hooks dir, info/exclude: all private
//   GIT_OBJECT_DIRECTORY=<private>/objects            every object write lands here
//   GIT_ALTERNATE_OBJECT_DIRECTORIES=<real objects>   read-only reuse of the blobs and trees the repo has;
//                                 never given to a call that reads the temp index (see below)
//   GIT_INDEX_FILE=<stateDir>/checkpoint-tmp/<uuid>.index  (and its `.lock`) deleted in `finally`
//   GIT_WORK_TREE=<repo root>     read only: `update-index` and `add` hash the files, never write them
// The only calls that run against the real repo are `rev-parse` (paths, HEAD) and `config --get-regexp`
// (the line-ending, link, case, ignore, attribute and sparse settings the scrubbed env hides), both reads.
// Every call goes through workdir-git's hardened runner (hooks to /dev/null, no fsmonitor, no pager, no
// external diff, system and global config nulled, `GIT_OPTIONAL_LOCKS=0`) plus `-c diff.autoRefreshIndex=false
// --no-optional-locks`, a subcommand allowlist per side, a byte cap on stdout, the remaining budget as its
// timeout and workdir-git's pipe grace period.
//
// No option stops git "freshening" an object an alternate already holds when it would write it (it sets
// that object's mtime: object-file.c `check_and_freshen_nonlocal`), and reading an index can write trees
// (a sparse index expanded, or a full one collapsed, rebuilds its cache tree). So no call that reads the
// temp index sees the real objects: `ls-files`, `diff-files`, `update-index`, `add` and `write-tree` run
// with the store alone. What they must read of the user's objects is copied in first: the index blob of
// every file about to be rehashed (git's safer-autocrlf check reads it to decide whether CRLF is kept), by
// `pack-objects` through the alternate, which reads the blobs it is given and writes one pack into the
// store. The calls that keep the alternate read objects by name only (`pack-objects`, `ls-tree`,
// `commit-tree`, the diffs). A sparse index stays sparse and a full one full (`index.sparse` follows the
// file), and a folder outside a sparse cone that is on disk makes the side `absent: sparse-checkout`
// (git would expand the index to look inside it). The tests pin the user's `.git` byte- and
// mtime-identical, after a revert, mid-merge, mid-rebase, with CRLF files and in a sparse checkout too.
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

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
  private: ["init", "rev-parse", "update-index", "diff-files", "ls-files", "read-tree", "add", "write-tree", "mktree", "commit-tree", "update-ref", "diff", "cat-file", "pack-objects", "ls-tree", "rev-list", "for-each-ref", "gc"],
} as const;

/**
 * Passed on every checkpoint call. Long paths on Windows; no CRLF refusal and no reflog; never sign; no
 * auto-gc or maintenance; a split or untracked-cache index is never written, and no shared index is ever
 * expired (T3 d37bce55f: a write to a scratch index under `core.splitIndex` can delete the `sharedindex.*` the
 * real index still uses; here the temp index's git dir is the store, so this is belt and braces); the
 * fsmonitor stays off.
 */
export const SNAPSHOT_CONFIG = [
  "-c", "core.longpaths=true",
  "-c", "core.safecrlf=false",
  "-c", "core.logAllRefUpdates=false",
  "-c", "commit.gpgsign=false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "core.splitIndex=false",
  "-c", "splitIndex.sharedIndexExpire=never",
  "-c", "core.untrackedCache=false",
  "-c", "core.fsmonitor=false",
] as const;

/** Real-repo settings the scrubbed env hides but a snapshot must honour, so blobs match what the operator's `git status` sees. */
// The attributes file decides line endings (`-text`, `eol`) as `.gitattributes` does. The sparse-checkout
// keys keep the temp index as sparse as the real one (`index.sparse` is then set from the index file itself).
const CONFIG_KEYS = ["core.autocrlf", "core.eol", "core.symlinks", "core.ignorecase", "core.filemode", "core.excludesfile", "core.attributesfile", "core.sparsecheckout", "core.sparsecheckoutcone", "index.sparse"] as const;
const CONFIG_RE = "^(core\\.(autocrlf|eol|symlinks|ignorecase|filemode|excludesfile|attributesfile|sparsecheckout|sparsecheckoutcone)|index\\.sparse)$";
/** Keys whose value is a file path (`~/` expanded, a relative one resolved against the repo root). */
const PATH_KEYS = ["core.excludesfile", "core.attributesfile"];
const BOOL_KEYS = ["core.symlinks", "core.ignorecase", "core.filemode", "core.sparsecheckout", "core.sparsecheckoutcone", "index.sparse"];
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
    if (BOOL_KEYS.includes(key) && !BOOL_VALUES.has(value)) continue;
    if (PATH_KEYS.includes(key)) {
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
  /** The real `info/sparse-checkout` (copied into the store like the exclude file). Optional for callers that build one by hand. */
  sparsePath?: string;
  /** The real `info/attributes` (copied into the store like the exclude file). Optional like `sparsePath`. */
  attributesPath?: string;
  /** `-c` pairs for the effective {@link CONFIG_KEYS}. */
  config: string[];
}

export type SnapshotSide = "start" | "end";
/** `sparse-checkout`: a folder outside a sparse index's cone is on disk, or the index cannot be read as it is. */
export type SnapshotFailure = "too-large" | "timeout" | "git-failed" | "sparse-checkout";
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
/**
 * The private store's key: sha256 (first 32 hex) of the realpath of the repo's git dir. Lower-cased only
 * where the file system is case-insensitive by default (Windows, macOS), so `C:\Repo` and `c:\repo` share
 * a store there; on a case-sensitive file system (Linux) two repos that differ only in case get two stores.
 */
export const repoKeyOf = (gitDir: string, platform: NodeJS.Platform = process.platform): string =>
  createHash("sha256").update(platform === "win32" || platform === "darwin" ? gitDir.toLowerCase() : gitDir).digest("hex").slice(0, 32);
/** `GIT_ALTERNATE_OBJECT_DIRECTORIES` for one directory: C-quoted when it holds the list separator or a quote. */
export function alternatesValue(dir: string, sep = process.platform === "win32" ? ";" : ":"): string {
  return dir.includes(sep) || dir.includes('"') ? `"${dir.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : dir;
}
const samePath = (a: string, b: string): boolean => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
/** `p` is strictly below `dir` (case-insensitive on Windows). */
export function inside(p: string, dir: string): boolean {
  const norm = (x: string) => (process.platform === "win32" ? resolve(x).toLowerCase() : resolve(x));
  const a = norm(p), b = norm(dir);
  return a.startsWith(b.endsWith(sep) ? b : b + sep);
}
/** git's words for an object it cannot reach (`rev-list --missing` in a store whose alternate lost objects). */
const MISSING_OBJECT_RE = /unable to read tree|bad object|missing (?:blob|tree|object)|not a valid object|invalid object|could not read/i;

class Stop extends Error {
  constructor(readonly reason: SnapshotFailure, readonly truncated = false, detail?: string) { super(detail ?? reason); }
}

/** One index entry as `ls-files -s` prints it. */
interface IndexEntry { mode: string; oid: string; stage: string }
/** The empty blob (SHA-1, SHA-256): an intent-to-add entry's, never worth copying (it holds no CR). */
const EMPTY_BLOBS = new Set(["e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813"]);
/** `update-index` runs per settle round: each run that stops at a file git cannot read drops that file and goes again. */
const MAX_UPDATE_ATTEMPTS = 32;

/** The entry count in an index file's header (`DIRC`, version, count): null when there is no file, NaN when it is not an index. */
export async function indexEntryCount(path: string): Promise<number | null> {
  let fh: Awaited<ReturnType<typeof open>>;
  try { fh = await open(path, "r"); } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : Number.NaN; }
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await fh.read(head, 0, 12, 0);
    return bytesRead === 12 && head.toString("latin1", 0, 4) === "DIRC" ? head.readUInt32BE(8) : Number.NaN;
  } finally { await fh.close(); }
}
/** A boolean `-c key=value` in a config list is on (the last one wins). */
function configOn(config: readonly string[], key: string): boolean {
  let on = false;
  for (let i = 0; i + 1 < config.length; i += 2) {
    const m = /^([^=]+)=(.*)$/.exec(config[i + 1]!);
    if (config[i] === "-c" && m && m[1]!.toLowerCase() === key) on = ["true", "yes", "on", "1"].includes(m[2]!.toLowerCase());
  }
  return on;
}
/** `dest` becomes a copy of the file `src`, or is removed when there is none. */
async function mirrorFile(src: string | undefined, dest: string): Promise<void> {
  const body = src ? await readFile(src).catch(() => null) : null;
  if (body === null) await rm(dest, { force: true });
  else await writeFile(dest, body);
}

/** Paths git named on stderr as unreadable during `add` or `update-index`, and whether every non-empty line was understood. */
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
    // `update-index` stops at the first path it cannot read (writing nothing) and skips a name it refuses.
    else if ((m = /^fatal: Unable to process path (.+)$/.exec(line))) paths.push(m[1]!);
    else if ((m = /^error: lstat\("(.+)"\): /.exec(line))) paths.push(m[1]!);
    else if ((m = /^Ignoring path (.+)$/.exec(line))) paths.push(m[1]!);
    else if (/^fatal: (?:adding files failed|updating files failed|unable to (?:stat|index) file)/.test(line)) continue;
    else if (/^warning: in the working copy of '/.test(line)) continue;
    else if (/^(?:hint|warning): /.test(line) && !/^warning: could not/.test(line)) continue;
    else understood = false;
  }
  return { paths: [...new Set(paths)], understood };
}

/**
 * One task per store at a time, FIFO per store, at most `maxActive` stores busy at once. A task with a
 * `deadline` (epoch ms; the run-scope review reads) gives up while it is still waiting: `BUSY` as soon as
 * the deadline passes, or at once when `maxQueued` deadline tasks already wait. Background work (snapshots,
 * the sweep) has no deadline and always waits its turn.
 */
export const BUSY = Symbol("busy");
/** Run-scope reads waiting for a store at once; one more is answered `busy` (T26's `REVIEW_QUEUE_MAX`). */
export const MAX_QUEUED_READS = 32;
export function createStoreQueue(maxActive = MAX_ACTIVE_STORES, maxQueued = MAX_QUEUED_READS) {
  interface Job { key: string; start: () => void; deadline: boolean }
  const waiting: Job[] = []; const busy = new Set<string>(); const inFlight = new Set<Promise<unknown>>();
  let active = 0;
  const pump = () => {
    for (let i = 0; i < waiting.length && active < maxActive;) {
      const job = waiting[i]!;
      // An earlier job for the same store blocks this one, so each store stays FIFO.
      if (busy.has(job.key) || waiting.slice(0, i).some((j) => j.key === job.key)) { i++; continue; }
      waiting.splice(i, 1); job.start();
    }
  };
  return {
    get active() { return active; },
    get waiting() { return waiting.length; },
    run<T>(key: string, task: () => Promise<T>, deadline?: number): Promise<T | typeof BUSY> {
      const p = new Promise<T | typeof BUSY>((resolve, reject) => {
        if (deadline !== undefined && (Date.now() >= deadline || waiting.filter((j) => j.deadline).length >= maxQueued)) return resolve(BUSY);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const job: Job = {
          key, deadline: deadline !== undefined,
          start: () => {
            if (timer) clearTimeout(timer);
            active++; busy.add(key);
            task().then(resolve, reject).finally(() => { active--; busy.delete(key); pump(); });
          },
        };
        waiting.push(job);
        if (deadline !== undefined) timer = setTimeout(() => { const i = waiting.indexOf(job); if (i >= 0) { waiting.splice(i, 1); resolve(BUSY); pump(); } }, deadline - Date.now());
        pump();
      });
      const tracked = p.catch(() => {});
      inFlight.add(tracked); void tracked.then(() => inFlight.delete(tracked));
      return p;
    },
    /** Resolves when every queued task has run (tests). */
    async idle(): Promise<void> { while (inFlight.size > 0) await Promise.all([...inFlight]); },
  };
}

export interface CheckpointGitOptions {
  /** Resolved to an absolute path at once; every private call's `GIT_DIR` must lie under its `checkpoints/`. */
  stateDir: string;
  /**
   * The Files root. When set, a repo whose git dir, index, objects dir or exclude file lies outside it (a
   * worktree `.git` file pointing elsewhere) is not snapshotted: the bridge would read files outside the root.
   */
  workRoot?: string;
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
  const stateDir = resolve(opts.stateDir);
  const storesDir = join(stateDir, STORES_DIR);
  const tmpDir = join(stateDir, TMP_DIR);
  const workRoot = opts.workRoot ? resolve(opts.workRoot) : null;
  const queue = createStoreQueue(opts.maxActiveStores ?? MAX_ACTIVE_STORES);
  const caps: SnapshotCaps = { ...SNAPSHOT_CAPS, ...opts.caps };

  /** The private-side env check: the store is an absolute path under `checkpoints/`, the temp index under `checkpoint-tmp/`. */
  function privateEnvError(env: Record<string, string> | undefined): string | null {
    const dir = env?.GIT_DIR;
    if (!dir) return "a private call needs GIT_DIR";
    if (!isAbsolute(dir) || !inside(dir, storesDir)) return "GIT_DIR is not a private store";
    if (env.GIT_OBJECT_DIRECTORY !== undefined && (!isAbsolute(env.GIT_OBJECT_DIRECTORY) || !inside(env.GIT_OBJECT_DIRECTORY, storesDir))) return "GIT_OBJECT_DIRECTORY is not in a private store";
    if (env.GIT_INDEX_FILE !== undefined && (!isAbsolute(env.GIT_INDEX_FILE) || !inside(env.GIT_INDEX_FILE, tmpDir))) return "GIT_INDEX_FILE is not a temp index";
    for (const k of ["GIT_COMMON_DIR", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE", "GIT_GRAFT_FILE"]) if (env[k] !== undefined) return `${k} is not allowed`;
    for (const k of Object.keys(env)) {
      const upper = k.toUpperCase();
      // Windows reads environment names without case: a `git_dir` would slip past the checks above.
      if (upper.startsWith("GIT_") && k !== upper) return `${k} is not allowed (git variables are upper case)`;
      // Config by environment (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n`, `GIT_CONFIG_GLOBAL`, ...)
      // would undo the snapshot config and the nulled system and global files.
      if (upper.startsWith("GIT_CONFIG")) return `${k} is not allowed`;
    }
    return null;
  }

  /** One checkpoint git call: allowlisted subcommand, review prefix, snapshot config, bounded stdout, a timeout. */
  async function call(side: "real" | "private", args: string[], cwd: string, limits: GitLimits & { config?: string[] } = {}): Promise<GitRun> {
    const sub = args[0];
    if (sub === undefined || !(CHECKPOINT_SUBCOMMANDS[side] as readonly string[]).includes(sub)) throw new Error(`checkpoint: git ${sub} is not allowed (${side})`);
    if (side === "real" && sub === "config" && (args[1] !== "--get-regexp" || args.length !== 3)) throw new Error("checkpoint: only `config --get-regexp <re>` reads the real repo's config");
    if (side === "real" && limits.extraEnv) throw new Error("checkpoint: a real-repo call takes no extra env");
    if (side === "private") { const why = privateEnvError(limits.extraEnv); if (why) throw new Error(`checkpoint: ${why}`); }
    // `pack-objects` writes its pack where its last argument says: only into the store's own `objects/pack`.
    if (sub === "pack-objects") {
      const dest = args.at(-1) ?? "", objects = limits.extraEnv?.GIT_OBJECT_DIRECTORY ?? "";
      if (args.includes("--stdout") || !isAbsolute(dest) || !objects || !inside(dest, join(objects, "pack"))) throw new Error("checkpoint: pack-objects writes only into the store's objects/pack");
    }
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
    const r = await call("real", ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-path", "index", "--git-path", "objects", "--git-path", "info/exclude", "--git-path", "info/sparse-checkout", "--git-path", "info/attributes"], root);
    if (r.failed || r.timedOut || r.code !== 0) return null;
    const [gitDirRaw, indexRaw, objectsRaw, excludeRaw, sparseRaw, attributesRaw] = r.stdout.split("\n").map((l) => l.replace(/\r$/, ""));
    if (!gitDirRaw || !indexRaw || !objectsRaw || !excludeRaw || !sparseRaw || !attributesRaw) return null;
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
    const indexPath = await real(indexRaw), excludePath = await real(excludeRaw), sparsePath = await real(sparseRaw), attributesPath = await real(attributesRaw);
    // Containment like T26's roots: a worktree whose `.git` file points outside the Files root is not
    // snapshotted, because the bridge itself reads its index, exclude, sparse and attributes files.
    if (workRoot) {
      const realRoot = await realpath(workRoot).catch(() => workRoot);
      if (![gitDir, indexPath, objectsDir, excludePath, sparsePath, attributesPath].every((p) => inside(p, realRoot))) return null;
    }
    return { root, gitDir, repoKey, store: join(storesDir, `${repoKey}.git`), indexPath, objectsDir, excludePath, sparsePath, attributesPath, config };
  }

  /**
   * The env that points git at a private store; with `index`, a snapshot's temp index and the worktree too.
   * `alternate: false` leaves the real objects dir out: git then cannot see that the real repo already holds
   * an object, so it writes its own copy into the store instead of "freshening" (touching the mtime of) the
   * user's object, and an index it reads cannot make it write the user's trees. Every call that reads the
   * temp index runs that way.
   */
  function storeEnv(info: Pick<RepoInfo, "store" | "objectsDir" | "root">, index?: string, alternate = true): Record<string, string> {
    return {
      GIT_DIR: info.store,
      GIT_OBJECT_DIRECTORY: join(info.store, "objects"),
      ...(alternate ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesValue(info.objectsDir) } : {}),
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
    const index = join(tmpDir, `${randomUUID()}.index`);
    // Every step is inside the `try`: whatever throws (the store's init, a read, a write under the state
    // dir) becomes a failed outcome the caller records, never a lost one.
    try {
      await ensureStore(info, run);
      const store = storeEnv(info);
      // A ref, once written, is never moved: a retry or a replay reuses it.
      const have = await run("private", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], info.store, { ...base, extraEnv: store });
      if (have.code === 0 && FULL_SHA.test(have.stdout.trim())) return { ok: true, commit: have.stdout.trim(), reused: true, skipped: 0, skippedPaths: [], unsettled: false, hiddenStats: {}, capturedAt: now() };

      // HEAD only seeds an index git refused; snapshots have no parent (see step 5).
      const headRun = await run("real", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], info.root);
      const head = headRun.code === 0 && FULL_SHA.test(headRun.stdout.trim()) ? headRun.stdout.trim() : null;

      // The real info/exclude (or an empty one) is the store's, so `--exclude-standard` reads the operator's
      // rules; so are the attributes file (line endings) and the sparse-checkout pattern file (see CONFIG_KEYS).
      await mkdir(join(info.store, "info"), { recursive: true });
      await writeFile(join(info.store, "info", "exclude"), await readFile(info.excludePath).catch(() => ""));
      await mirrorFile(info.attributesPath, join(info.store, "info", "attributes"));
      await mirrorFile(info.sparsePath, join(info.store, "info", "sparse-checkout"));

      await mkdir(tmpDir, { recursive: true, mode: 0o700 });
      const env = storeEnv(info, index), noAlt = storeEnv(info, index, false);
      // Set once the temp index is read: `index.sparse` as the file is, and for a sparse one, no look for
      // files outside the cone (that look expands the index).
      let cfg = info.config;
      /** A call with the store alone: what it writes lands there, and it cannot see (so cannot touch) the user's objects. */
      const local = (args: string[], limits: GitLimits = {}) => run("private", args, info.root, { config: cfg, ...limits, extraEnv: { ...noAlt, ...limits.extraEnv } });
      /** A call that reads objects by name through the alternate. It is given no index and no worktree. */
      const viaAlt = (args: string[], limits: GitLimits = {}) => run("private", args, info.store, { config: cfg, ...limits, extraEnv: { ...store, ...limits.extraEnv } });
      /** `oid` without the given paths (segment lists): every tree on the way is listed (a read) and rebuilt with `mktree` (no alternate). */
      const pruneTree = async (oid: string, drop: string[][]): Promise<string> => {
        const ls = await viaAlt(["ls-tree", "-z", "--full-tree", oid], { maxStdoutBytes: LIST_CAP_BYTES });
        if (ls.code !== 0 || ls.overflow) throw new Stop("git-failed", false, `ls-tree: ${ls.stderr.trim()}`);
        const here = new Set(drop.filter((d) => d.length === 1).map((d) => d[0]!));
        const below = new Map<string, string[][]>();
        for (const d of drop) if (d.length > 1) below.set(d[0]!, [...(below.get(d[0]!) ?? []), d.slice(1)]);
        let input = "";
        for (const rec of ls.stdout.split("\0")) {
          const m = /^(\d+) (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(rec); if (!m) continue;
          const [, mode, type, child, name] = m as unknown as [string, string, string, string, string];
          if (here.has(name)) continue;
          const sub = below.get(name);
          input += `${mode} ${type} ${sub && type === "tree" ? await pruneTree(child, sub) : child}\t${name}\0`;
        }
        const mk = await local(["mktree", "-z", "--missing"], { stdin: input });
        const out = mk.stdout.trim();
        if (mk.code !== 0 || !FULL_SHA.test(out)) throw new Stop("git-failed", false, `mktree: ${mk.stderr.trim()}`);
        return out;
      };

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

      // The temp index as the file holds it: each file's entries (the real ones: what `git add` would hash
      // against), the folders outside a sparse cone (`dir/` entries) and the skip-worktree entries.
      const originals = new Map<string, IndexEntry[]>();
      const sparseDirs = new Map<string, string>();
      const skipWorktree: string[] = [];
      /**
       * `ls-files --sparse` with the store alone. The entries must be the file's, one for one (its header
       * count): git can expand a sparse index on read (with the trees out of reach it drops what it cannot
       * read and still exits 0) or collapse a full one. `index.sparse` off keeps a full index full, on keeps
       * a sparse one sparse; the repo's own setting is tried first, the other if the count does not match.
       * The setting that matched then holds for the whole snapshot.
       */
      const readIndex = async (): Promise<boolean> => {
        const count = await indexEntryCount(index);
        for (const sparseSetting of configOn(info.config, "index.sparse") ? ["true", "false"] : ["false", "true"]) {
          const ls = await run("private", ["ls-files", "-z", "-s", "-t", "--sparse"], info.root, {
            config: [...info.config, "-c", `index.sparse=${sparseSetting}`, "-c", "sparse.expectFilesOutsideOfPatterns=true"], extraEnv: noAlt, maxStdoutBytes: LIST_CAP_BYTES,
          });
          if (ls.overflow) throw new Stop("too-large", true);
          if (ls.code !== 0) return false;
          const records = ls.stdout.split("\0").filter(Boolean);
          if (count !== null && records.length !== count) continue;
          originals.clear(); sparseDirs.clear(); skipWorktree.length = 0;
          for (const rec of records) {
            const m = /^(\S) (\d{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/.exec(rec);
            if (!m) throw new Stop("git-failed", false, `ls-files: ${rec.slice(0, 80)}`);
            const [, tag, mode, oid, stage, path] = m as unknown as [string, string, string, string, string, string];
            if (tag === "S") skipWorktree.push(path);
            if (path.endsWith("/")) { sparseDirs.set(path, oid); continue; }
            originals.set(path, [...(originals.get(path) ?? []), { mode, oid, stage }]);
          }
          cfg = [...info.config, "-c", `index.sparse=${sparseSetting}`, ...(sparseDirs.size > 0 ? ["-c", "sparse.expectFilesOutsideOfPatterns=true"] : [])];
          return true;
        }
        return false;
      };
      if (!seeded || !(await readIndex())) {
        // The copy is gone or git cannot read it as it is (a split index, a newer format). In a sparse
        // checkout HEAD's tree is no stand-in: every file outside the cone would read as deleted.
        if (configOn(info.config, "core.sparsecheckout")) throw new Stop("sparse-checkout", false, "the real index could not be read as it is");
        // Start from HEAD (a full index: nothing is collapsed, so no tree is written), or empty.
        await rm(index, { force: true });
        if (head) {
          const rt = await run("private", ["read-tree", head], info.root, { config: [...info.config, "-c", "index.sparse=false"], extraEnv: env });
          if (rt.code !== 0) throw new Stop("git-failed", false, `read-tree: ${rt.stderr.trim()}`);
        }
        if (!(await readIndex())) throw new Stop("git-failed", false, "the temp index could not be read");
      }
      /**
       * A skip-worktree entry of a sparse index that is on disk (a folder outside the cone: git leaves one
       * that holds untracked or ignored files, and an agent can make one). git would expand the index to
       * look inside it, and with `sparse.expectFilesOutsideOfPatterns` it would not look at all, so the
       * snapshot would miss what is there: the side is absent instead. Checked again at the end.
       */
      const outsideOnDisk = async (): Promise<boolean> => {
        if (sparseDirs.size === 0) return false;
        const seen = new Map<string, boolean>();
        const exists = async (rel: string): Promise<boolean> => {
          if (rel === "") return true;
          let hit = seen.get(rel);
          if (hit === undefined) { hit = (await lstat(join(info.root, ...rel.split("/"))).catch(() => null)) !== null; seen.set(rel, hit); }
          return hit;
        };
        for (const raw of skipWorktree) {
          const p = raw.replace(/\/$/, "");
          const cut = p.lastIndexOf("/");
          if (cut > 0 && !(await exists(p.slice(0, cut)))) continue; // its folder is gone, so is it
          if (await exists(p)) return true;
        }
        return false;
      };
      if (await outsideOnDisk()) throw new Stop("sparse-checkout", false, "a folder outside the sparse cone is on disk");

      /**
       * The real index blobs of `paths`, copied into the store before git rehashes those files. Its
       * safer-autocrlf check (core.autocrlf, `text=auto`) reads the index blob to decide whether a CRLF file is
       * kept as it is; a blob it cannot read counts as "no CR", so a CRLF-committed file would come out LF
       * (a whole-file diff). `pack-objects` reads them through the alternate and writes one pack into the
       * store; nothing of the user's is written. Refused names are never copied.
       */
      const copied = new Set<string>();
      const copyBlobs = async (paths: Iterable<string>): Promise<void> => {
        const want: string[] = [];
        for (const p of paths) {
          if (isHiddenPath(p)) continue;
          for (const e of originals.get(p) ?? []) {
            if (!/^1(00644|00755|20000)$/.test(e.mode) || EMPTY_BLOBS.has(e.oid) || copied.has(e.oid)) continue;
            copied.add(e.oid); want.push(e.oid);
          }
        }
        if (want.length === 0) return;
        const check = await local(["cat-file", "--batch-check"], { stdin: want.join("\n") + "\n", maxStdoutBytes: LIST_CAP_BYTES });
        if (check.code !== 0 || check.overflow) throw new Stop("git-failed", false, `cat-file: ${check.stderr.trim()}`);
        const missing = check.stdout.split("\n").flatMap((l) => { const m = /^([0-9a-f]{40,64}) missing$/.exec(l.trim()); return m ? [m[1]!] : []; });
        if (missing.length === 0) return;
        await mkdir(join(info.store, "objects", "pack"), { recursive: true });
        const pack = await viaAlt(["pack-objects", "-q", "--window=0", "--depth=0", join(info.store, "objects", "pack", "pack")], { stdin: missing.join("\n") + "\n" });
        if (pack.code !== 0) throw new Stop("git-failed", false, `pack-objects: ${pack.stderr.trim()}`);
      };

      // 2. What differs from the temp index (tracked edits, deletions). A partial tree is never committed:
      // past the cap the side is too-large, as a cut snapshot would read as mass deletions.
      const listDirty = async (capped = true): Promise<string[]> => {
        const d = await local(["diff-files", "-z", "--name-only"], { maxStdoutBytes: LIST_CAP_BYTES });
        if (d.overflow) throw new Stop("too-large", true);
        if (d.code !== 0) throw new Stop("git-failed", false, `diff-files: ${d.stderr.trim()}`);
        const out = [...new Set(d.stdout.split("\0").filter(Boolean))];
        if (capped && out.length > caps.maxTrackedChanges) throw new Stop("too-large", true);
        return out;
      };
      // The first list may name files that are in fact clean (stat-dirty, or racy with a blob not readable
      // yet); it says whose blobs to copy, so the refresh then judges every file as the operator's git would.
      // Past the cap (an index rebuilt from HEAD names every file) nothing is copied here: a file the refresh
      // misjudges is rehashed below, its blob copied first, and comes out as it was.
      const candidates = await listDirty(false);
      if (candidates.length <= caps.maxTrackedChanges) await copyBlobs(candidates);
      const refresh = await local(["update-index", "-q", "--refresh"]);
      if (refresh.code !== 0 && refresh.code !== 1) throw new Stop("git-failed", false, `update-index --refresh: ${refresh.stderr.trim()}`);
      const dirtyPaths = await listDirty();

      const others = await local(["ls-files", "-z", "--others", "--exclude-standard"], { maxStdoutBytes: LIST_CAP_BYTES });
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
      // A folder outside a sparse cone is one index entry; `update-index` cannot drop what is in it without
      // expanding the index, so its refused names are cut from the finished tree instead (step 4b).
      const hiddenTracked = [...originals.keys()].filter((p) => isHiddenPath(p));
      if (hiddenTracked.length > 0) {
        const rmh = await local(["update-index", "--force-remove", "-z", "--stdin"], { stdin: hiddenTracked.join("\0") + "\0" });
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
      /** Paths whose temp-index entry this snapshot rewrote (it is no longer the real index's entry). */
      const rewritten = new Set<string>();
      /**
       * Bring `paths` (tracked files that differ from the temp index) up to date, each rehashed against its
       * real index entry as the operator's `git add` would be: an entry an earlier settle round rewrote is
       * put back first (`--index-info`), and the real blobs are copied in (`copyBlobs`). `update-index` rehashes
       * only the paths it is given; `add -u` would also rehash every racy entry, whose blob may not be here.
       * It stops at the first file it cannot read, writing nothing: that file keeps its entry, the rest go again.
       */
      const syncTracked = async (paths: string[]): Promise<void> => {
        let list = paths.filter((p) => !isHiddenPath(p) && !unreadable.has(p));
        if (list.length === 0) return;
        const back = list.filter((p) => rewritten.has(p) && originals.has(p));
        if (back.length > 0) {
          let input = "";
          for (const p of back) {
            const entries = originals.get(p)!;
            input += `0 ${"0".repeat(entries[0]!.oid.length)}\t${p}\0`;
            for (const e of entries) input += `${e.mode} ${e.oid} ${e.stage}\t${p}\0`;
          }
          const r = await local(["update-index", "-z", "--index-info"], { stdin: input });
          if (r.code !== 0) throw new Stop("git-failed", false, `update-index --index-info: ${r.stderr.trim()}`);
        }
        await copyBlobs(list);
        for (let attempt = 0; list.length > 0; attempt++) {
          if (attempt >= MAX_UPDATE_ATTEMPTS) throw new Stop("git-failed", false, "update-index: too many files git cannot read");
          const u = await local(["update-index", "--add", "--remove", "-z", "--stdin"], { stdin: list.join("\0") + "\0" });
          const e = parseAddErrors(u.stderr);
          for (const p of e.paths) unreadable.add(p);
          if (u.code === 0) break;
          if (!e.understood || e.paths.length === 0) throw new Stop("git-failed", false, `update-index: ${u.stderr.trim()}`);
          list = list.filter((p) => !unreadable.has(p));
        }
        for (const p of list) if (!unreadable.has(p)) rewritten.add(p);
      };
      await syncTracked(dirtyPaths);
      // `--sparse`: a new file outside a sparse checkout's patterns is still a file `git status` lists.
      let pending = allowed;
      for (let attempt = 0; pending.length > 0 && attempt < 5; attempt++) {
        const a = await local(["add", "--sparse", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"], { stdin: pending.join("\0") + "\0", extraEnv: { GIT_LITERAL_PATHSPECS: "1" } });
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
        // `--missing-ok`: the trees may name blobs only the real repo holds (they are not visible here).
        const w = await local(["write-tree", "--missing-ok"]);
        const oid = w.stdout.trim();
        if (w.code !== 0 || !FULL_SHA.test(oid)) throw new Stop("git-failed", false, `write-tree: ${w.stderr.trim()}`);
        return oid;
      };
      let tree = await writeTree(); let unsettled = true;
      for (let round = 0; round < SETTLE_ROUNDS; round++) {
        if (deadline - now() <= settleDelayMs) throw new Stop("timeout");
        await sleep(settleDelayMs);
        await syncTracked(await listDirty());
        const again = await writeTree();
        if (again === tree) { unsettled = false; break; }
        tree = again;
      }

      // 4b. A sparse index: list the finished tree (a read through the alternate). Every folder outside the
      // cone must be in it as the index named it (nothing was expanded and lost); then every tree on the way
      // to a refused name is rebuilt without it (`mktree`, no alternate: new trees land in the store only).
      if (sparseDirs.size > 0) {
        const all = await viaAlt(["ls-tree", "-r", "-t", "-z", "--full-tree", tree], { maxStdoutBytes: LIST_CAP_BYTES });
        if (all.overflow) throw new Stop("too-large", true);
        if (all.code !== 0) throw new Stop("git-failed", false, `ls-tree: ${all.stderr.trim()}`);
        const trees = new Map<string, string>(); const refused: string[] = [];
        for (const rec of all.stdout.split("\0")) {
          const m = /^\d+ (\w+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(rec); if (!m) continue;
          if (m[1] === "tree") trees.set(m[3]!, m[2]!);
          else if (isHiddenPath(m[3]!)) refused.push(m[3]!);
        }
        for (const [dir, oid] of sparseDirs) if (trees.get(dir.replace(/\/$/, "")) !== oid) throw new Stop("git-failed", false, `ls-tree: ${dir} is not in the tree as the index named it`);
        if (refused.length > 0) tree = await pruneTree(tree, refused.map((p) => p.split("/")));
        if (await outsideOnDisk()) throw new Stop("sparse-checkout", false, "a folder outside the sparse cone is on disk");
      }

      // 5. The commit: no hooks run, nothing is signed, and no parent. Parenting on HEAD would make every gc
      // in the store walk the user's whole history, and in a shallow clone fail on the cut-off parents
      // (the store has no `shallow` file); no diff or route reads the parent. With the alternate, so git
      // can check a tree the real repo holds; the commit itself is always new, so nothing is freshened.
      const at = now(); const date = `@${Math.floor(at / 1000)} +0000`;
      const ct = await viaAlt(["commit-tree", tree, "-m", `sightr checkpoint ${refId(req.threadId)} ${Math.trunc(req.ordinal)} ${req.side}`], {
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
   * Whether every object a snapshot commit reaches is still readable (`rev-list --objects --missing=print`):
   * true when something is missing (the user rewrote history and pruned what only their repo held), false
   * when all is there, null when git could not say (a timeout, output past the cap). Snapshots have no
   * parent, so this walks one tree, not the user's history.
   */
  async function objectsMissing(info: { store: string; objectsDir: string | null }, commits: string[]): Promise<boolean | null> {
    if (commits.some((c) => !FULL_SHA.test(c))) return null;
    const extraEnv: Record<string, string> = { GIT_DIR: info.store, GIT_OBJECT_DIRECTORY: join(info.store, "objects"), ...(info.objectsDir ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesValue(info.objectsDir) } : {}) };
    const r = await call("private", ["rev-list", "--objects", "--no-object-names", "--missing=print", ...commits, "--"], info.store, { extraEnv, maxStdoutBytes: LIST_CAP_BYTES, timeoutMs: GC_TIMEOUT_MS });
    if (r.timedOut || r.failed || r.overflow) return null;
    if (r.code !== 0) return MISSING_OBJECT_RE.test(r.stderr) || /bad object|unknown revision/i.test(r.stderr) ? true : null;
    return r.stdout.split("\n").some((l) => l.startsWith("?"));
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
    storeRunner, listRefs, deleteRefs, gc, objectsMissing, storeBytes, listStores, removeStore, cleanTmp, queue, storesDir, tmpDir, storeEnv,
  };
}
