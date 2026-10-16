#!/usr/bin/env bun
/**
 * What changed upstream in T3 Code for the files web2 adopted (docs/specs/t3/README.md, "Adapting T3
 * components"). Report only: it never edits web2 and always exits 0. Porting a change stays a deliberate
 * edit that bumps the row's `commit` in web2/t3-upstream.json.
 *
 *   bun scripts/t3-upstream.ts [--ref <tag|sha|branch>] [--diff] [--manifest <file>] [--cache <dir>] [--remote <url|path>]
 *
 * - Clones T3 into a cache outside the repo (default %LOCALAPPDATA%/sightr/t3-upstream), or fetches if
 *   the cache exists.
 * - `--ref` defaults to the newest tag, else `main`.
 * - For each manifest row prints `unchanged | changed | removed` since the row's `commit` (`--diff`
 *   adds the upstream diff for `changed`).
 * - Lists files added since the manifest's `baseline` directly under the mirrored folders that the
 *   manifest does not list yet (test files left out).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

export interface ManifestRow {
  local: string;
  upstream: string;
  commit: string;
  mode: "verbatim" | "adapted" | "pattern";
  note?: string;
}

export interface Manifest {
  repo: string;
  baseline: string;
  folders: string[];
  files: ManifestRow[];
}

export interface Options {
  ref: string | null;
  diff: boolean;
  manifest: string;
  cache: string;
  remote: string | null;
}

export type RowStatus = "unchanged" | "changed" | "removed" | "unknown-commit";

export interface Io {
  log(line: string): void;
}

export function defaultCacheDir(env: Record<string, string | undefined> = process.env): string {
  const base = env.LOCALAPPDATA ?? join(env.HOME ?? homedir(), ".cache");
  return join(base, "sightr", "t3-upstream");
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): Options {
  const opts: Options = {
    ref: null,
    diff: false,
    manifest: join(REPO_ROOT, "web2", "t3-upstream.json"),
    cache: defaultCacheDir(env),
    remote: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--ref") opts.ref = value();
    else if (arg === "--diff") opts.diff = true;
    else if (arg === "--manifest") opts.manifest = resolve(value());
    else if (arg === "--cache") opts.cache = resolve(value());
    else if (arg === "--remote") opts.remote = value();
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

/** True when `dir` is `root` or inside it. */
export function isInside(dir: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function git(args: string[], cwd?: string): { ok: boolean; out: string; err: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim(), err: proc.stderr.toString().trim() };
}

const isUrl = (remote: string) => /^(https?|ssh|git):\/\/|^[\w.-]+@[\w.-]+:/.test(remote);

/** Clone or fetch the cache. Returns an error line, or null when the cache is ready. */
function syncCache(cache: string, remote: string): string | null {
  if (!existsSync(join(cache, ".git"))) {
    mkdirSync(dirname(cache), { recursive: true });
    // Partial clone for the real remote (history without every blob); a local path clones plainly.
    const args = isUrl(remote)
      ? ["clone", "--quiet", "--filter=blob:none", "--no-checkout", remote, cache]
      : ["clone", "--quiet", "--no-checkout", remote, cache];
    const r = git(args);
    return r.ok ? null : `clone failed: ${r.err}`;
  }
  git(["remote", "set-url", "origin", remote], cache);
  const r = git(["fetch", "--quiet", "--tags", "--force", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"], cache);
  return r.ok ? null : `fetch failed: ${r.err}`;
}

/** The commit to compare against, and how to name it. */
function resolveRef(cache: string, ref: string | null): { sha: string; name: string } | null {
  const verify = (r: string) => {
    const res = git(["rev-parse", "--verify", "--quiet", `${r}^{commit}`], cache);
    return res.ok && res.out ? res.out : null;
  };
  if (ref) {
    for (const candidate of [ref, `origin/${ref}`]) {
      const sha = verify(candidate);
      if (sha) return { sha, name: ref };
    }
    return null;
  }
  const tag = git(["for-each-ref", "--sort=-creatordate", "--count=1", "--format=%(refname:short)", "refs/tags"], cache).out;
  if (tag) {
    const sha = verify(`refs/tags/${tag}`);
    if (sha) return { sha, name: tag };
  }
  for (const name of ["origin/main", "origin/HEAD"]) {
    const sha = verify(name);
    if (sha) return { sha, name: name.replace(/^origin\//, "") };
  }
  return null;
}

function blobAt(cache: string, commit: string, path: string): string | null {
  const r = git(["rev-parse", "--verify", "--quiet", `${commit}:${path}`], cache);
  return r.ok && r.out ? r.out : null;
}

export function rowStatus(cache: string, row: ManifestRow, refSha: string): RowStatus {
  if (!git(["cat-file", "-e", `${row.commit}^{commit}`], cache).ok) return "unknown-commit";
  const now = blobAt(cache, refSha, row.upstream);
  if (now === null) return "removed";
  return blobAt(cache, row.commit, row.upstream) === now ? "unchanged" : "changed";
}

/** Files added since `baseline` directly under the mirrored folders and not in the manifest. */
export function newUpstreamFiles(cache: string, manifest: Manifest, refSha: string): string[] {
  const known = new Set(manifest.files.map((f) => f.upstream));
  const folders = manifest.folders.map((f) => (f.endsWith("/") ? f : `${f}/`));
  const r = git(["diff", "--name-only", "--diff-filter=A", manifest.baseline, refSha, "--", ...folders], cache);
  if (!r.ok) return [];
  return r.out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((path) => folders.some((f) => path.startsWith(f) && !path.slice(f.length).includes("/")))
    .filter((path) => !/\.test\.[jt]sx?$/.test(path) && !known.has(path))
    .sort();
}

export function run(argv: string[], io: Io = { log: (l) => console.log(l) }, env = process.env): number {
  let opts: Options;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    io.log(`t3-upstream: ${(e as Error).message}`);
    return 0;
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(opts.manifest, "utf8")) as Manifest;
  } catch (e) {
    io.log(`t3-upstream: cannot read ${opts.manifest}: ${(e as Error).message}`);
    return 0;
  }
  if (isInside(opts.cache, REPO_ROOT)) {
    io.log(`t3-upstream: the cache ${opts.cache} is inside the repo; pick a folder outside it (--cache).`);
    return 0;
  }
  const remote = opts.remote ?? manifest.repo;
  const syncError = syncCache(opts.cache, remote);
  if (syncError) {
    io.log(`t3-upstream: ${syncError}`);
    return 0;
  }
  const ref = resolveRef(opts.cache, opts.ref);
  if (!ref) {
    io.log(`t3-upstream: no such ref ${opts.ref ?? "(latest tag or main)"} in ${remote}`);
    return 0;
  }

  io.log(`T3 Code ${remote} at ${ref.name} (${ref.sha.slice(0, 12)})`);
  io.log(`manifest: ${manifest.files.length} files, baseline ${manifest.baseline.slice(0, 12)}`);
  io.log("");
  const counts: Record<RowStatus, number> = { unchanged: 0, changed: 0, removed: 0, "unknown-commit": 0 };
  for (const row of manifest.files) {
    const status = rowStatus(opts.cache, row, ref.sha);
    counts[status] += 1;
    io.log(`${status.padEnd(14)} ${row.local}  <-  ${row.upstream} (${row.mode})`);
    if (status === "changed" && opts.diff) {
      const d = git(["diff", row.commit, ref.sha, "--", row.upstream], opts.cache);
      for (const line of d.out.split("\n")) io.log(`    ${line}`);
    }
  }
  io.log("");
  io.log(
    `${counts.unchanged} unchanged, ${counts.changed} changed, ${counts.removed} removed` +
      (counts["unknown-commit"] ? `, ${counts["unknown-commit"]} with a commit the clone does not have` : ""),
  );

  const added = newUpstreamFiles(opts.cache, manifest, ref.sha);
  io.log("");
  if (added.length === 0) io.log("No new upstream files under the mirrored folders since the baseline.");
  else {
    io.log(`New upstream files under the mirrored folders since the baseline (${added.length}):`);
    for (const path of added) io.log(`  ${path}`);
  }
  return 0;
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
