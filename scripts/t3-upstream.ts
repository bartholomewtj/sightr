#!/usr/bin/env bun
/**
 * What changed upstream in T3 Code for the files Sightr adopted (docs/T3_ADAPTATION.md, spec T20).
 * Report only: it never edits the repo or the ledger. Porting a change stays a deliberate edit that
 * bumps the row's `commit` in web2/t3-upstream.json; a change Bart chose not to take is a `decisions` row.
 *
 *   bun scripts/t3-upstream.ts [--ref <branch|tag|sha>] [--diff] [--json] [--manifest <file>] [--cache <dir>] [--remote <url|path>]
 *
 * - Clones T3 into a cache outside the repo (default %LOCALAPPDATA%/sightr/t3-upstream; blobless for a
 *   URL, so blobs fetch lazily), or fetches if the cache exists.
 * - `--ref` defaults to `main` (the ledger records T3 `main` commits; tags lag it or branch off it). A
 *   branch name means the remote's branch (`origin/<name>`), never a stale local one. A ref the ledger
 *   `baseline` is not an ancestor of is refused.
 * - For each ledger row prints `unchanged | changed | removed | unknown-commit` since the row's `commit`
 *   (`--diff` adds the upstream diff for `changed`). `shape` rows (contracts outside web2/) also list the
 *   `Schema.Literal` tags and struct keys added or removed, from a line scan (no TypeScript parser).
 * - Lists files added since the `baseline` directly under the mirrored folders and not in the ledger.
 * - A `decisions` row `{upstream, commit, verdict, reason}` marks a change as decided while the upstream
 *   file at the ref is still what it was at the decision's commit; a later upstream change shows again.
 * - `--json` prints one object and nothing else (shape in spec T20).
 *
 * Exit 0 for every report. A broken ledger, a failed clone or fetch, an unknown ref, or a ref behind the
 * baseline exits 1 with the reason on stderr.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
/** Ledger `local` paths are relative to web2/; `../` reaches shared/. */
const LOCAL_BASE = join(REPO_ROOT, "web2");

export type Mode = "verbatim" | "adapted" | "pattern" | "shape";
const MODES: readonly Mode[] = ["verbatim", "adapted", "pattern", "shape"];

export interface ManifestRow {
  local: string;
  upstream: string;
  commit: string;
  mode: Mode;
  note?: string;
}

export interface Decision {
  upstream: string;
  commit: string;
  verdict: "skip" | "defer";
  reason: string;
  date?: string;
}

export interface Manifest {
  repo: string;
  baseline: string;
  folders: string[];
  files: ManifestRow[];
  decisions?: Decision[];
}

export interface Options {
  ref: string | null;
  diff: boolean;
  json: boolean;
  manifest: string;
  cache: string;
  remote: string | null;
}

export type RowStatus = "unchanged" | "changed" | "removed" | "unknown-commit";

export interface RowReport {
  local: string;
  upstream: string;
  mode: Mode;
  commit: string;
  status: RowStatus;
  decided?: Decision;
  diff?: string;
}

export interface ContractReport {
  local: string;
  added: string[];
  removed: string[];
}

export interface Report {
  ref: { name: string; sha: string };
  baseline: string;
  rows: RowReport[];
  newFiles: { path: string; decided?: Decision }[];
  contracts: ContractReport[];
}

export interface Io {
  log(line: string): void;
  error?(line: string): void;
}

export function defaultCacheDir(env: Record<string, string | undefined> = process.env): string {
  const base = env.LOCALAPPDATA ?? join(env.HOME ?? homedir(), ".cache");
  return join(base, "sightr", "t3-upstream");
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): Options {
  const opts: Options = {
    ref: null,
    diff: false,
    json: false,
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
    else if (arg === "--json") opts.json = true;
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

/** Where a ledger `local` path lives on disk. */
export function localPath(local: string): string {
  return resolve(LOCAL_BASE, local);
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Checks the ledger's shape. Returns the problem, or null when it is usable. */
export function validateManifest(m: unknown): string | null {
  if (!m || typeof m !== "object") return "the ledger is not a JSON object";
  const o = m as Record<string, unknown>;
  if (!isStr(o.repo)) return "`repo` must be a string";
  if (!isStr(o.baseline)) return "`baseline` must be a commit";
  if (!Array.isArray(o.folders) || !o.folders.every(isStr)) return "`folders` must be an array of paths";
  if (!Array.isArray(o.files)) return "`files` must be an array";
  for (const [i, row] of (o.files as unknown[]).entries()) {
    const r = (row ?? {}) as Record<string, unknown>;
    const where = `files[${i}]${isStr(r.local) ? ` (${r.local})` : ""}`;
    if (!isStr(r.local) || !isStr(r.upstream) || !isStr(r.commit)) return `${where} needs local, upstream and commit`;
    if (!MODES.includes(r.mode as Mode)) return `${where} has mode ${JSON.stringify(r.mode)}; want ${MODES.join(" | ")}`;
    if (!isInside(localPath(r.local), REPO_ROOT)) return `${where} resolves outside the repo`;
  }
  if (o.decisions !== undefined) {
    if (!Array.isArray(o.decisions)) return "`decisions` must be an array";
    for (const [i, row] of (o.decisions as unknown[]).entries()) {
      const d = (row ?? {}) as Record<string, unknown>;
      if (!isStr(d.upstream) || !isStr(d.commit) || !isStr(d.reason)) return `decisions[${i}] needs upstream, commit and reason`;
      if (d.verdict !== "skip" && d.verdict !== "defer") return `decisions[${i}] has verdict ${JSON.stringify(d.verdict)}; want skip | defer`;
    }
  }
  return null;
}

function git(args: string[], cwd?: string): { ok: boolean; code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    ok: proc.exitCode === 0,
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString().trim(),
    err: proc.stderr.toString().trim(),
  };
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

function verifyCommit(cache: string, rev: string): string | null {
  const res = git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cache);
  return res.ok && res.out ? res.out : null;
}

/** The commit to compare against. A branch name means the remote's branch, so a stale local branch in the cache never wins. */
function resolveRef(cache: string, ref: string | null): { sha: string; name: string } | null {
  const name = ref ?? "main";
  for (const candidate of [`refs/remotes/origin/${name}`, `refs/tags/${name}`, name]) {
    const sha = verifyCommit(cache, candidate);
    if (sha) return { sha, name };
  }
  return null;
}

function blobAt(cache: string, commit: string, path: string): string | null {
  const r = git(["rev-parse", "--verify", "--quiet", `${commit}:${path}`], cache);
  return r.ok && r.out ? r.out : null;
}

function fileAt(cache: string, commit: string, path: string): string {
  const r = git(["show", `${commit}:${path}`], cache);
  return r.ok ? r.out : "";
}

export function rowStatus(cache: string, row: ManifestRow, refSha: string): RowStatus {
  if (!git(["cat-file", "-e", `${row.commit}^{commit}`], cache).ok) return "unknown-commit";
  const now = blobAt(cache, refSha, row.upstream);
  if (now === null) return "removed";
  return blobAt(cache, row.commit, row.upstream) === now ? "unchanged" : "changed";
}

/**
 * The decision that covers `path` at `refSha`: one made at or after `since` (the row's commit, or the
 * baseline for a new file) whose upstream file is still the one at the ref. The last such row wins.
 */
export function decisionFor(cache: string, decisions: Decision[], path: string, since: string, refSha: string): Decision | undefined {
  const now = blobAt(cache, refSha, path);
  let found: Decision | undefined;
  for (const d of decisions) {
    if (d.upstream !== path) continue;
    const at = verifyCommit(cache, d.commit);
    if (!at) continue;
    if (!git(["merge-base", "--is-ancestor", since, at], cache).ok) continue;
    if (blobAt(cache, at, path) !== now) continue;
    found = d;
  }
  return found;
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

/**
 * The contract names in a T3 schema file, from a line scan: every `Schema.Literal(s)` tag as
 * `Decl "tag"` and every struct key as `Decl.key`, where `Decl` is the nearest top-level declaration
 * above it. `only` keeps the declarations whose name starts with it (a row's `note`).
 */
export function contractNames(source: string, only?: string): Set<string> {
  const names = new Set<string>();
  let decl = "";
  let inLiterals = false;
  for (const line of source.split("\n")) {
    const top = /^(?:export\s+)?(?:const|function|type|interface|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (top) {
      decl = top[1]!;
      inLiterals = false;
    }
    if (only && !decl.startsWith(only)) continue;
    const tags: string[] = [];
    for (const m of line.matchAll(/Schema\.Literals?\(\s*\[?([^)\]]*)/g)) {
      for (const s of (m[1] ?? "").matchAll(/"([^"]*)"/g)) tags.push(s[1]!);
      if (/Schema\.Literals\(\s*\[[^\]]*$/.test(line.slice(m.index))) inLiterals = true;
    }
    if (inLiterals && !/Schema\.Literals\(/.test(line)) {
      for (const s of line.matchAll(/"([^"]*)"/g)) tags.push(s[1]!);
      if (line.includes("]")) inLiterals = false;
    }
    for (const t of tags) names.add(`${decl} "${t}"`);
    // `key: Schema.x(...)` or `key: SomeSchema` on its own line, and `{ key: ...` / `, key: ...` inline in a struct.
    const own = /^\s+([A-Za-z_$][\w$]*)\??\s*:\s*(?:Schema\.|[A-Z])/.exec(line);
    if (own) names.add(`${decl}.${own[1]}`);
    const inline = /Schema\.Struct\(\{(.*)/.exec(line);
    if (inline) {
      for (const k of (inline[1] ?? "").matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\??\s*:\s*(?:Schema\.|[A-Z])/g)) names.add(`${decl}.${k[1]}`);
    }
  }
  return names;
}

export function contractChange(cache: string, row: ManifestRow, refSha: string): ContractReport {
  const before = contractNames(fileAt(cache, row.commit, row.upstream), row.note);
  const after = contractNames(fileAt(cache, refSha, row.upstream), row.note);
  return {
    local: row.local,
    added: [...after].filter((n) => !before.has(n)).sort(),
    removed: [...before].filter((n) => !after.has(n)).sort(),
  };
}

class Fail extends Error {}

function readManifest(path: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Fail(`cannot read ${path}: ${(e as Error).message}`);
  }
  const problem = validateManifest(parsed);
  if (problem) throw new Fail(`broken ledger ${path}: ${problem}`);
  return parsed as Manifest;
}

/** Builds the report. Throws `Fail` with the reason when the check cannot run. */
export function buildReport(opts: Options): { report: Report; remote: string } {
  const manifest = readManifest(opts.manifest);
  if (isInside(opts.cache, REPO_ROOT)) throw new Fail(`the cache ${opts.cache} is inside the repo; pick a folder outside it (--cache).`);
  const remote = opts.remote ?? manifest.repo;
  const syncError = syncCache(opts.cache, remote);
  if (syncError) throw new Fail(syncError);
  const ref = resolveRef(opts.cache, opts.ref);
  if (!ref) throw new Fail(`no such ref ${opts.ref ?? "main"} in ${remote}`);
  const baseline = verifyCommit(opts.cache, manifest.baseline);
  if (!baseline) throw new Fail(`the ledger baseline ${manifest.baseline} is not in the clone of ${remote}`);
  const ancestor = git(["merge-base", "--is-ancestor", baseline, ref.sha], opts.cache);
  if (!ancestor.ok) {
    throw new Fail(
      ancestor.code === 1
        ? `refusing ${ref.name} (${ref.sha.slice(0, 12)}): the ledger baseline ${manifest.baseline.slice(0, 12)} is not an ancestor of it, so changes would read backwards. Compare against T3 main or a commit after the baseline.`
        : `cannot compare ${ref.name} with the baseline: ${ancestor.err}`,
    );
  }

  const decisions = manifest.decisions ?? [];
  const rows: RowReport[] = [];
  const contracts: ContractReport[] = [];
  for (const row of manifest.files) {
    const status = rowStatus(opts.cache, row, ref.sha);
    const out: RowReport = { local: row.local, upstream: row.upstream, mode: row.mode, commit: row.commit, status };
    if (status === "changed" || status === "removed") {
      const decided = decisionFor(opts.cache, decisions, row.upstream, row.commit, ref.sha);
      if (decided) out.decided = decided;
    }
    if (status === "changed" && opts.diff) out.diff = git(["diff", row.commit, ref.sha, "--", row.upstream], opts.cache).out;
    if (status === "changed" && row.mode === "shape") contracts.push(contractChange(opts.cache, row, ref.sha));
    rows.push(out);
  }
  const newFiles = newUpstreamFiles(opts.cache, manifest, ref.sha).map((path) => {
    const decided = decisionFor(opts.cache, decisions, path, baseline, ref.sha);
    return decided ? { path, decided } : { path };
  });
  return { report: { ref, baseline: manifest.baseline, rows, newFiles, contracts }, remote };
}

function printText(report: Report, remote: string, io: Io): void {
  const mark = (d?: Decision) => (d ? `  (decided: ${d.verdict} — ${d.reason})` : "");
  io.log(`T3 Code ${remote} at ${report.ref.name} (${report.ref.sha.slice(0, 12)})`);
  io.log(`ledger: ${report.rows.length} files, baseline ${report.baseline.slice(0, 12)}`);
  io.log("");
  const counts: Record<RowStatus, number> = { unchanged: 0, changed: 0, removed: 0, "unknown-commit": 0 };
  let decided = 0;
  for (const row of report.rows) {
    if (row.decided) decided += 1;
    else counts[row.status] += 1;
    io.log(`${row.status.padEnd(14)} ${row.local}  <-  ${row.upstream} (${row.mode})${mark(row.decided)}`);
    const contract = row.mode === "shape" ? report.contracts.find((c) => c.local === row.local) : undefined;
    if (contract) {
      for (const n of contract.added) io.log(`    + ${n}`);
      for (const n of contract.removed) io.log(`    - ${n}`);
      if (!contract.added.length && !contract.removed.length) io.log("    (no Schema.Literal tag or struct key added or removed)");
    }
    if (row.diff !== undefined) for (const line of row.diff.split("\n")) io.log(`    ${line}`);
  }
  io.log("");
  io.log(
    `${counts.unchanged} unchanged, ${counts.changed} changed, ${counts.removed} removed` +
      (counts["unknown-commit"] ? `, ${counts["unknown-commit"]} with a commit the clone does not have` : "") +
      (decided ? ` (${decided} more changed or removed, decided)` : ""),
  );

  const openNew = report.newFiles.filter((f) => !f.decided);
  io.log("");
  if (report.newFiles.length === 0) io.log("No new upstream files under the mirrored folders since the baseline.");
  else {
    io.log(`New upstream files under the mirrored folders since the baseline (${openNew.length} undecided, ${report.newFiles.length - openNew.length} decided):`);
    for (const f of report.newFiles) io.log(`  ${f.path}${mark(f.decided)}`);
  }
  io.log("");
  const open = counts.changed + counts.removed + counts["unknown-commit"] + openNew.length;
  io.log(open === 0 ? "Summary: no undecided changes." : `Summary: ${open} undecided change${open === 1 ? "" : "s"}.`);
}

export function run(argv: string[], io: Io = { log: (l) => console.log(l), error: (l) => console.error(l) }, env = process.env): number {
  const fail = (msg: string) => {
    (io.error ?? io.log)(`t3-upstream: ${msg}`);
    return 1;
  };
  let opts: Options;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    return fail((e as Error).message);
  }
  try {
    const { report, remote } = buildReport(opts);
    if (opts.json) io.log(JSON.stringify(report, null, 2));
    else printText(report, remote, io);
    return 0;
  } catch (e) {
    if (e instanceof Fail) return fail(e.message);
    throw e;
  }
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
