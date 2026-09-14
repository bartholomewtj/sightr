// Reads the folder selected in Files, walks to its worktree, and reports handed-in panes live inside it.
// This module only ever READS: it switches off operator Git configuration when spawning git, and
// filters every path hidden by the Files skip list before git diff is asked for it.
import { devNull, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { access, realpath } from "node:fs/promises";
import { containedRealpath } from "./journal/files.ts";
import { isRefusedName } from "./workdir.ts";
import type { FolderGitEntry, FolderGitResponse } from "../shared/wire.ts";

export const GIT_TIMEOUT_MS = 10_000;
export const DIFF_CAP_BYTES = 256 * 1024;
export const MAX_STATUS_ENTRIES = 500;
export const MAX_DIFF_PATHS = 200;
export const MAX_PATHSPEC_BYTES = 8_000;
export const MAX_PANE_IDS = 50;
export const MAX_WALK = 40;
export interface GitRun { code: number; stdout: string; stderr: string; timedOut: boolean; failed: boolean }
export type GitRunner = (args: string[], cwd: string) => Promise<GitRun>;
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
function readEffectiveAutocrlf(): Promise<string[]> {
  effectiveAutocrlf ??= (async () => { try { const proc = Bun.spawn(["git", "config", "--get", "core.autocrlf"], { cwd: tmpdir(), stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }); await proc.exited; return autocrlfArgs(await new Response(proc.stdout).text()); } catch { return []; } })();
  return effectiveAutocrlf;
}
export const spawnGit: GitRunner = async (args, cwd) => {
  let proc: any;
  try { proc = Bun.spawn(["git", ...prefix, ...(await readEffectiveAutocrlf()), ...args], { cwd, env: env(), stdout: "pipe", stderr: "pipe" }); } catch { return { code: -1, stdout: "", stderr: "", timedOut: false, failed: true }; }
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
export function parseStatusV2(records: string[]): { branch?: string; detached: boolean; noCommits: boolean; entries: Array<FolderGitEntry & { tracked: boolean }> } {
  let branch: string | undefined, detached = false, noCommits = false;
  const entries: Array<FolderGitEntry & { tracked: boolean }> = [];
  for (const original of records) {
    let r = original;
    // Git places its newline-delimited branch headers before the first NUL-terminated record.
    if (r.includes("\n# ")) {
      const lines = r.split("\n"); r = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith("# branch.head ")) { const v = line.slice(14); if (v === "(detached)") detached = true; else branch = v; }
        else if (line === "# branch.oid (initial)") noCommits = true;
      }
    }
    if (r.startsWith("# branch.head ")) { const v = r.slice(14); if (v === "(detached)") detached = true; else branch = v; continue; }
    if (r === "# branch.oid (initial)") { noCommits = true; continue; }
    const f = r.split(" "); const type = f[0];
    if (type === "1" && f.length >= 9) entries.push({ path: f.slice(8).join(" "), x: f[1]![0]!, y: f[1]![1]!, tracked: true });
    else if (type === "u" && f.length >= 11) entries.push({ path: f.slice(10).join(" "), x: f[1]![0]!, y: f[1]![1]!, tracked: true });
    else if (type === "?" && f.length >= 2) entries.push({ path: f.slice(1).join(" "), x: "?", y: "?", tracked: false });
  }
  return { ...(branch === undefined ? {} : { branch }), detached, noCommits, entries };
}
export function isHiddenPath(path: string): boolean { return path.split("/").some((seg) => seg !== "" && isRefusedName(seg)); }
function cutDiff(text: string): { text: string; truncated: boolean } { const bytes = new TextEncoder().encode(text); if (bytes.length <= DIFF_CAP_BYTES) return { text, truncated: false }; const cut = new TextDecoder().decode(bytes.slice(0, DIFF_CAP_BYTES)); return { text: cut.slice(0, cut.lastIndexOf("\n") + 1), truncated: true }; }
export function createFolderGit(workRoot: string, run: GitRunner = spawnGit) {
  // Keep injected runners subject to the same hardened argv contract as the real runner.
  const invoke: GitRunner = run === spawnGit ? run : (args, cwd) => run([...prefix, ...args], cwd);
  return { async inspect(dir: string, panes: Array<{ paneId: string; cwd: string }> = []): Promise<FolderGitResponse> {
    const realCwd = await containedRealpath(dir, workRoot); if (!realCwd) return { available: false, reason: "outside-root" };
    const root = await findWorktreeRoot(realCwd, workRoot); if (!root) return { available: false, reason: "not-a-repo" };
    const top = await invoke(["rev-parse", "--show-toplevel"], root); if (top.failed) return { available: false, reason: "git-unavailable" }; if (top.timedOut) return { available: false, reason: "timeout" }; if (top.code !== 0) return { available: false, reason: "not-a-repo" };
    const gitRoot = await realpath(top.stdout.trim()).catch(() => ""); const sameRoot = process.platform === "win32" ? resolve(gitRoot).toLowerCase() === resolve(root).toLowerCase() : resolve(gitRoot) === resolve(root); if (!gitRoot || !sameRoot) return { available: false, reason: "not-a-repo" };
    const status = await invoke(["status", "--porcelain=v2", "--branch", "-z", "--no-renames", "--untracked-files=normal"], root); if (status.failed) return { available: false, reason: "git-unavailable" }; if (status.timedOut) return { available: false, reason: "timeout" };
    const parsed = parseStatusV2(status.stdout.split("\0").filter(Boolean)); let hidden = 0; const visible: Array<FolderGitEntry & { tracked: boolean }> = [];
    for (const e of parsed.entries) { if (isHiddenPath(e.path)) hidden++; else if (visible.length < MAX_STATUS_ENTRIES) visible.push(e); }
    const statusTruncated = parsed.entries.filter((e) => !isHiddenPath(e.path)).length > visible.length;
    const paths: string[] = []; let diffTruncated = statusTruncated, size = 0;
    for (const e of visible) if (e.tracked) { const p = `:(literal,top)${e.path}`, n = new TextEncoder().encode(p).length + (paths.length ? 1 : 0); if (paths.length >= MAX_DIFF_PATHS || size + n > MAX_PATHSPEC_BYTES) { diffTruncated = true; break; } paths.push(p); size += n; }
    let diff = ""; if (!parsed.noCommits && paths.length) { const d = await invoke(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "-U3", "HEAD", "--", ...paths], root); if (d.timedOut || d.code !== 0) diffTruncated = true; const cut = cutDiff(d.stdout); diff = cut.text; diffTruncated ||= cut.truncated; }
    const seen = new Set<string>(); const inRepo: string[] = [];
    for (const p of panes.slice(0, MAX_PANE_IDS)) { if (seen.has(p.paneId)) continue; seen.add(p.paneId); if (await containedRealpath(p.cwd, root)) inRepo.push(p.paneId); }
    return { available: true, repo: basename(root), rel: relative(root, realCwd).split(sep).join("/"), ...(parsed.branch ? { branch: parsed.branch } : {}), ...(parsed.detached ? { detached: true } : {}), ...(parsed.noCommits ? { noCommits: true } : {}), clean: visible.length === 0 && hidden === 0, entries: visible.map(({ tracked: _tracked, ...e }) => e), hidden, statusTruncated, diff, diffTruncated, panes: inRepo };
  } };
}
