// Fixture repos for the T30 checkpoint tests: built in a temp dir with the real `git` (no network), plus
// a whole-tree fingerprint for the "the user's .git is untouched" proofs.
import { createHash } from "node:crypto";
import { devNull, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";

export const tempRoot = async (name: string): Promise<string> => realpath(await mkdtemp(join(tmpdir(), name)));

/** Env for fixture git: no system or global config of the machine running the tests. */
export function fixtureEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^GIT_/i.test(k)) env[k] = v;
  const nul = process.platform === "win32" ? "NUL" : devNull;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: nul, GIT_CONFIG_GLOBAL: nul, GIT_TERMINAL_PROMPT: "0", ...extra };
}

/** Run fixture git in `cwd`; throws with stderr on failure. */
export const gitIn = (cwd: string, extraEnv: Record<string, string> = {}) => async (...args: string[]): Promise<string> => {
  const p = Bun.spawn(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", "-c", "core.longpaths=true", ...args], { cwd, env: fixtureEnv(extraEnv), stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
};

/** A repo at `<parent>/<name>` with `files` committed. */
export async function makeRepo(parent: string, name: string, files: Record<string, string | Uint8Array> = { "a.txt": "one\ntwo\nthree\n" }): Promise<{ root: string; git: ReturnType<typeof gitIn> }> {
  const root = join(parent, name);
  await mkdir(root, { recursive: true });
  const git = gitIn(root);
  await git("init", "-q");
  await writeFiles(root, files);
  if (Object.keys(files).length > 0) {
    await git("add", "-A");
    await git("commit", "-q", "-m", "init");
  }
  return { root: await realpath(root), git };
}

export async function writeFiles(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [path, body] of Object.entries(files)) {
    const abs = join(root, ...path.split("/"));
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
}

export interface TreePrint {
  /** relative path → sha256 of the bytes (files) or `dir` / `link`. */
  content: Map<string, string>;
  /** relative path → mtime (ms), for files. */
  mtime: Map<string, number>;
}

/** Every file under `dir` (recursively, `.git` included when `dir` is a worktree), with its content hash and mtime. */
export async function fingerprint(dir: string): Promise<TreePrint> {
  const content = new Map<string, string>(); const mtime = new Map<string, number>();
  const walk = async (d: string) => {
    for (const name of await readdir(d)) {
      const abs = join(d, name); const rel = relative(dir, abs).split(sep).join("/");
      const st = await lstat(abs);
      if (st.isSymbolicLink()) { content.set(rel, "link"); continue; }
      if (st.isDirectory()) { content.set(rel, "dir"); await walk(abs); continue; }
      content.set(rel, createHash("sha256").update(await readFile(abs)).digest("hex"));
      mtime.set(rel, st.mtimeMs);
    }
  };
  await walk(dir);
  return { content, mtime };
}

/**
 * What changed between two prints of a git dir: files added, removed, with different bytes, or with a
 * different mtime. None is allowed, objects included: a snapshot writes its objects without the real repo
 * as an alternate, so git never "freshens" (touches) an object the user's repo holds.
 */
export function gitDirChanges(before: TreePrint, after: TreePrint): string[] {
  const out: string[] = [];
  for (const [k, v] of before.content) if (after.content.get(k) !== v) out.push(after.content.has(k) ? `changed ${k}` : `removed ${k}`);
  for (const k of after.content.keys()) if (!before.content.has(k)) out.push(`added ${k}`);
  for (const [k, v] of before.mtime) if (after.mtime.has(k) && after.mtime.get(k) !== v) out.push(`touched ${k}`);
  return out;
}

/** Set every file under `dir` an hour back, so a later touch (a freshen) shows as an mtime change. */
export async function ageTree(dir: string): Promise<void> {
  const t = Math.floor(Date.now() / 1000) - 3600;
  const walk = async (d: string): Promise<void> => {
    for (const name of await readdir(d)) {
      const abs = join(d, name); const st = await lstat(abs);
      if (st.isDirectory()) await walk(abs); else if (st.isFile()) await utimes(abs, t, t).catch(() => {});
    }
  };
  await walk(dir);
}

export const rmrf = (p: string) => rm(p, { recursive: true, force: true, maxRetries: 3 });
