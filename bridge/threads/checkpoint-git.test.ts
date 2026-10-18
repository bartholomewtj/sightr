import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

import { ageTree, fingerprint, gitDirChanges, gitIn, makeRepo, rmrf, tempRoot, writeFiles } from "../test/git-fixtures.ts";
import { isHiddenPath, spawnGit, type GitRunner } from "../workdir-git.ts";
import {
  alternatesValue, BUSY, CHECKPOINT_SUBCOMMANDS, checkpointRef, configPairs, createCheckpointGit, createStoreQueue, indexEntryCount, MAX_FILE_BYTES, parseAddErrors, refId, repoKeyOf, SNAPSHOT_CONFIG,
  type CheckpointGitOptions, type RepoInfo,
} from "./checkpoint-git.ts";
import { diffRun } from "./checkpoint-diff.ts";
import { shortNameOf, trackAlias } from "../test/short-names.ts";

// Real git processes: under a loaded full run one test can pass bun's 5 s default.
setDefaultTimeout(60_000);
const roots: string[] = [];
afterAll(async () => { for (const r of roots) await rmrf(r); });
const root = async (name = "sightr-cp-") => { const r = await tempRoot(name); roots.push(r); return r; };
const LF_ONLY = async () => new Map([["core.autocrlf", "false"]]);
const CAN_SYMLINK = await (async () => { const d = await root("sightr-cp-sl-"); try { await writeFile(join(d, "t"), "x"); await symlink(join(d, "t"), join(d, "l")); return true; } catch { return false; } })();
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

function cg(stateDir: string, opts: Partial<CheckpointGitOptions> = {}) {
  return createCheckpointGit({ stateDir, globalConfig: LF_ONLY, settleDelayMs: 5, ...opts });
}
/** Fixture git against a private store (to read what a snapshot holds). */
const storeGit = (info: RepoInfo) => gitIn(info.store, { GIT_DIR: info.store, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesValue(info.objectsDir) });
async function filesAt(info: RepoInfo, commit: string): Promise<string[]> {
  const out = await storeGit(info)("ls-tree", "-r", "--name-only", commit);
  return out ? out.split("\n").sort() : [];
}
const blobAt = (info: RepoInfo, commit: string, path: string) => storeGit(info)("cat-file", "blob", `${commit}:${path}`);
const req = (side: "start" | "end" = "start", ordinal = 1) => ({ threadId: "11111111-2222-3333-4444-555555555555", ordinal, side });

/** A work root with one repo, its checkpoint git, and the print of its `.git` and worktree. */
async function setup(files?: Record<string, string>, opts: Partial<CheckpointGitOptions> = {}) {
  const work = await root();
  const state = join(work, "state");
  const repo = await makeRepo(work, "repo", files);
  const git = cg(state, opts);
  const info = (await git.resolveRepo(repo.root))!;
  return { work, state, repo, git, info };
}
async function untouched<T>(repoRoot: string, act: () => Promise<T>, gitDir = join(repoRoot, ".git")): Promise<T> {
  const statusBefore = await gitIn(repoRoot)("status", "--porcelain", "--untracked-files=all");
  await ageTree(gitDir); // an hour back, so a touched (freshened) object would show
  const before = await fingerprint(gitDir);
  const worktreeBefore = await fingerprint(repoRoot);
  const out = await act();
  const after = await fingerprint(gitDir);
  expect(gitDirChanges(before, after)).toEqual([]);
  expect([...after.content.keys()].filter((k) => k.endsWith(".lock"))).toEqual([]);
  const worktreeAfter = await fingerprint(repoRoot);
  const wt = (p: typeof worktreeBefore) => [...p.content].filter(([k]) => !k.startsWith(".git/"));
  expect(wt(worktreeAfter)).toEqual(wt(worktreeBefore));
  expect(await gitIn(repoRoot)("status", "--porcelain", "--untracked-files=all")).toBe(statusBefore);
  return out;
}

describe("checkpoint git: pure helpers", () => {
  test("refId keeps a plain id and hashes anything else; refs are per thread, ordinal and side", () => {
    expect(refId("abc-DEF_1")).toBe("abc-DEF_1");
    expect(refId("a/b")).toMatch(/^[0-9a-f]{32}$/);
    expect(refId("x".repeat(65))).toMatch(/^[0-9a-f]{32}$/);
    expect(checkpointRef("t1", 3, "end")).toBe("refs/checkpoints/t1/3/end");
  });
  test("repoKeyOf folds case only where the file system does by default (Windows, macOS), so two Linux repos differing in case get two stores", () => {
    expect(repoKeyOf("C:\\Repo\\.git", "win32")).toBe(repoKeyOf("c:\\repo\\.git", "win32"));
    expect(repoKeyOf("/Users/u/Repo/.git", "darwin")).toBe(repoKeyOf("/users/u/repo/.git", "darwin"));
    expect(repoKeyOf("/home/u/Repo/.git", "linux")).not.toBe(repoKeyOf("/home/u/repo/.git", "linux"));
    expect(repoKeyOf("/home/u/repo/.git", "linux")).toMatch(/^[0-9a-f]{32}$/);
    expect(repoKeyOf("C:\\Repo\\.git")).toBe(repoKeyOf("C:\\Repo\\.git", process.platform));
  });
  test("alternatesValue quotes a path holding the list separator", () => {
    expect(alternatesValue("/a/b", ":")).toBe("/a/b");
    expect(alternatesValue("/a:b", ":")).toBe('"/a:b"');
    expect(alternatesValue("C:\\x;y", ";")).toBe('"C:\\\\x;y"');
  });
  test("configPairs keeps only values git accepts and expands ~ in the excludes and attributes files", () => {
    const m = configPairs("core.autocrlf true\ncore.eol bogus\ncore.ignorecase TRUE\ncore.filemode maybe\ncore.excludesfile ~/ig\ncore.attributesFile ~/attrs\nuser.name x\n", "/home/u");
    expect(m.get("core.autocrlf")).toBe("true");
    expect(m.has("core.eol")).toBe(false);
    expect(m.get("core.ignorecase")).toBe("true");
    expect(m.has("core.filemode")).toBe(false);
    expect(m.get("core.excludesfile")).toBe(join("/home/u", "ig"));
    expect(m.get("core.attributesfile")).toBe(join("/home/u", "attrs"));
    expect(configPairs("core.attributesfile rel/attrs\n", "/home/u", resolve("/repo")).get("core.attributesfile")).toBe(resolve("/repo", "rel/attrs"));
    expect(m.has("user.name")).toBe(false);
  });
  test("parseAddErrors names unreadable paths and refuses what it does not understand", () => {
    expect(parseAddErrors("error: open(\"locked.txt\"): Permission denied\nerror: unable to index file 'locked.txt'\nfatal: adding files failed\n")).toEqual({ paths: ["locked.txt"], understood: true });
    // `update-index` stops at the first file it cannot read, and skips a name it refuses.
    expect(parseAddErrors("error: open(\"locked.txt\"): Permission denied\nfatal: Unable to process path locked.txt\n")).toEqual({ paths: ["locked.txt"], understood: true });
    expect(parseAddErrors("Ignoring path server.key.\n")).toEqual({ paths: ["server.key."], understood: true });
    expect(parseAddErrors("fatal: something new\n").understood).toBe(false);
    expect(parseAddErrors("")).toEqual({ paths: [], understood: true });
  });
  test("the snapshot config switches off what could write or prompt", () => {
    const flat = SNAPSHOT_CONFIG.join(" ");
    for (const c of ["core.longpaths=true", "core.safecrlf=false", "core.logAllRefUpdates=false", "commit.gpgsign=false", "gc.auto=0", "core.fsmonitor=false"]) expect(flat).toContain(c);
    expect(CHECKPOINT_SUBCOMMANDS.real).toEqual(["rev-parse", "config"]);
  });
});

describe("checkpoint git: the store queue", () => {
  test("one task per store at a time, FIFO; two stores at once; a deadline gives up", async () => {
    const q = createStoreQueue(2);
    const log: string[] = []; let peak = 0, live = 0;
    const task = (name: string, ms: number) => async () => { live++; peak = Math.max(peak, live); log.push(`+${name}`); await Bun.sleep(ms); log.push(`-${name}`); live--; return name; };
    const runs = [q.run("a", task("a1", 30)), q.run("a", task("a2", 5)), q.run("b", task("b1", 10)), q.run("c", task("c1", 5))];
    expect(await Promise.all(runs)).toEqual(["a1", "a2", "b1", "c1"]);
    expect(log.indexOf("-a1")).toBeLessThan(log.indexOf("+a2"));
    expect(peak).toBe(2);
    const blocker = q.run("d", () => Bun.sleep(40));
    const late = q.run("d", async () => "ran", Date.now() + 5);
    await blocker;
    expect(await late).toBe(BUSY);
  });

  test("a read with a deadline answers busy while it waits (not after the store's long task), and past the waiting cap at once", async () => {
    const q = createStoreQueue(2, 1);
    let release!: () => void;
    const gc = q.run("s", () => new Promise<void>((r) => { release = r; })); // a long gc holding the store
    const t0 = Date.now();
    expect(await q.run("s", async () => "read", Date.now() + 60)).toBe(BUSY);
    expect(Date.now() - t0).toBeLessThan(1_000);
    const waiting = q.run("s", async () => "first", Date.now() + 5_000);
    const t1 = Date.now();
    expect(await q.run("s", async () => "second", Date.now() + 5_000)).toBe(BUSY); // the cap: one read already waits
    expect(Date.now() - t1).toBeLessThan(100);
    const background = q.run("s", async () => "snapshot"); // no deadline: never refused, waits its turn
    release(); await gc;
    expect(await waiting).toBe("first");
    expect(await background).toBe("snapshot");
    expect(q.waiting).toBe(0);
  });
});

describe("checkpoint git: snapshots", () => {
  test("a clean tree: the commit and ref land in the private store, the user's .git is byte-identical", async () => {
    const { repo, git, info, state } = await setup({ "a.txt": "one\n", "src/b.ts": "export const b = 1;\n" });
    const head = await repo.git("rev-parse", "HEAD");
    const out = await untouched(repo.root, () => git.snapshot(info, req()));
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(info.store).toBe(join(state, "checkpoints", `${info.repoKey}.git`));
    expect(await filesAt(info, out.commit)).toEqual(["a.txt", "src/b.ts"]);
    // No parent: a gc in the store never walks the user's history. The tree is HEAD's (nothing changed).
    expect(await storeGit(info)("rev-list", "--parents", "-n", "1", out.commit)).toBe(out.commit);
    expect(await storeGit(info)("rev-parse", `${out.commit}^{tree}`)).toBe(await repo.git("rev-parse", `${head}^{tree}`));
    expect(await storeGit(info)("rev-parse", checkpointRef(req().threadId, 1, "start"))).toBe(out.commit);
    expect(await storeGit(info)("log", "-1", "--format=%an <%ae>", out.commit)).toBe("Sightr <sightr@localhost>");
    // Nothing new in the user's repo: no ref, no object.
    expect(await repo.git("for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    expect(await repo.git("cat-file", "-t", out.commit).catch(() => "missing")).toBe("missing");
    // The temp index is gone; the store has no hooks from a template.
    expect(await readdir(join(state, "checkpoint-tmp"))).toEqual([]);
    expect(existsSync(join(info.store, "hooks"))).toBe(false);
  });

  test("tracked edits, deletions and untracked files are in; ignored files (.gitignore, info/exclude, global list) are not", async () => {
    const work = await root();
    const ignoreFile = join(work, "global-ignore");
    await writeFile(ignoreFile, "*.glob\n");
    const repo = await makeRepo(work, "repo", { "a.txt": "one\n", "gone.txt": "bye\n", ".gitignore": "*.log\n" });
    await writeFile(join(repo.root, ".git", "info", "exclude"), "secret-dir/\n");
    const git = cg(join(work, "state"), { globalConfig: async () => new Map([["core.autocrlf", "false"], ["core.excludesfile", ignoreFile]]) });
    const info = (await git.resolveRepo(repo.root))!;
    await writeFiles(repo.root, { "a.txt": "one\nmore\n", "new/c.ts": "c\n", "x.log": "log\n", "secret-dir/s.txt": "s\n", "y.glob": "g\n" });
    await rm(join(repo.root, "gone.txt"));
    const out = await untouched(repo.root, () => git.snapshot(info, req()));
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(await filesAt(info, out.commit)).toEqual(["a.txt", "new/c.ts"]); // .gitignore is a refused name, so it is out too
    expect(await blobAt(info, out.commit, "a.txt")).toBe("one\nmore");
  });

  test("refused names never enter a snapshot: untracked .env and keys, tracked dot-folders; their stats are kept, never their bytes", async () => {
    const { repo, git, info } = await setup({ "a.txt": "a\n", ".github/ci.yml": "on: push\n", "config/app.json": "{}\n" });
    await writeFiles(repo.root, { ".env": "TOKEN=abc\n", "id_rsa": "PRIVATE\n", "certs/site.pem": "PEM\n", ".github/ci.yml": "on: pull_request\n", "b.txt": "b\n" });
    const out = await untouched(repo.root, () => git.snapshot(info, req()));
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(await filesAt(info, out.commit)).toEqual(["a.txt", "b.txt"]);
    expect(out.skipped).toBe(3); // .env, id_rsa, certs/site.pem
    expect(Object.keys(out.hiddenStats)).toEqual([".github/ci.yml"]);
    // No object in the store holds a secret's bytes.
    const all = await storeGit(info)("cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)");
    for (const line of all.split("\n").filter(Boolean)) {
      const [oid, type] = line.split(" ");
      if (type !== "blob") continue;
      const body = await storeGit(info)("cat-file", "blob", oid!);
      for (const secret of ["TOKEN=abc", "PRIVATE", "PEM", "pull_request"]) expect(body).not.toContain(secret);
    }
  });

  test("the repo's hooks, filters and fsmonitor never run, and commit.gpgsign does not prompt", async () => {
    const { repo, work } = await setup({ "a.txt": "a\n" });
    const marker = join(work, "MARKER");
    const sh = `#!/bin/sh\necho ran > "${marker.replaceAll("\\", "/")}"\n`;
    for (const hook of ["post-index-change", "pre-commit", "post-commit", "reference-transaction", "pre-auto-gc"]) {
      await writeFile(join(repo.root, ".git", "hooks", hook), sh); await chmod(join(repo.root, ".git", "hooks", hook), 0o755);
    }
    const script = join(work, "hook.sh"); await writeFile(script, sh); await chmod(script, 0o755);
    await repo.git("config", "core.hooksPath", join(repo.root, ".git", "hooks"));
    await repo.git("config", "filter.evil.clean", `sh "${script.replaceAll("\\", "/")}"`);
    await repo.git("config", "filter.evil.required", "true");
    await repo.git("config", "core.fsmonitor", script.replaceAll("\\", "/"));
    await repo.git("config", "commit.gpgsign", "true");
    await repo.git("config", "gpg.program", script.replaceAll("\\", "/"));
    await writeFiles(repo.root, { ".gitattributes": "*.txt filter=evil\n", "a.txt": "changed\n", "b.txt": "new\n" });
    const git2 = cg(join(work, "state2")); const fresh = (await git2.resolveRepo(repo.root))!; // config is read now
    // No `git status` around this one: the operator's own git WOULD run that fsmonitor and filter.
    const before = await fingerprint(join(repo.root, ".git"));
    const out = await git2.snapshot(fresh, req());
    expect(out.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(gitDirChanges(before, await fingerprint(join(repo.root, ".git")))).toEqual([]);
    if (out.ok) expect(await blobAt(fresh, out.commit, "a.txt")).toBe("changed"); // the filter's clean step did not run
  });

  test("a file over 5 MiB is skipped; untracked count, untracked bytes and tracked changes trip too-large with no ref", async () => {
    const { repo, git, info } = await setup({ "a.txt": "a\n", "t1.txt": "1\n", "t2.txt": "2\n" });
    await writeFile(join(repo.root, "big.bin"), new Uint8Array(MAX_FILE_BYTES + 1));
    const ok = await git.snapshot(info, req("start", 1));
    expect(ok.ok && ok.skipped).toBe(1);
    if (ok.ok) expect(await filesAt(info, ok.commit)).not.toContain("big.bin");
    await rm(join(repo.root, "big.bin"));

    const tight = cg(join(repo.root, "..", "state-tight"), { caps: { maxUntrackedFiles: 2 } });
    const tInfo = (await tight.resolveRepo(repo.root))!;
    await writeFiles(repo.root, { "u1.txt": "1", "u2.txt": "2", "u3.txt": "3" });
    expect(await untouched(repo.root, () => tight.snapshot(tInfo, req("start", 2)))).toEqual({ ok: false, reason: "too-large", truncated: true, detail: "too-large" });
    const bytes = cg(join(repo.root, "..", "state-bytes"), { caps: { maxUntrackedBytes: 2 } });
    expect((await bytes.snapshot((await bytes.resolveRepo(repo.root))!, req("start", 2))).ok).toBe(false);
    await Promise.all(["u1.txt", "u2.txt", "u3.txt"].map((f) => rm(join(repo.root, f))));
    await writeFiles(repo.root, { "t1.txt": "x", "t2.txt": "y" });
    const tracked = cg(join(repo.root, "..", "state-tracked"), { caps: { maxTrackedChanges: 1 } });
    const trInfo = (await tracked.resolveRepo(repo.root))!;
    const r = await tracked.snapshot(trInfo, req("start", 3));
    expect(r).toMatchObject({ ok: false, reason: "too-large", truncated: true });
    expect(await gitIn(trInfo.store, { GIT_DIR: trInfo.store })("for-each-ref", "--format=%(refname)")).toBe("");
  });

  test("past the budget: an injected slow runner gives timeout, kills git and removes the temp index", async () => {
    const work = await root(); const state = join(work, "state");
    const repo = await makeRepo(work, "repo");
    // `diff-files` hangs until its timeout (the remainder of the budget), as a git stuck on a huge tree would.
    const timeouts: number[] = [];
    const slow: GitRunner = async (args, cwd, limits) => {
      if (!args.includes("diff-files")) return spawnGit(args, cwd, limits);
      timeouts.push(limits?.timeoutMs ?? -1);
      await Bun.sleep(limits?.timeoutMs ?? 0);
      return { code: -1, stdout: "", stderr: "", timedOut: true, failed: false };
    };
    const git = cg(state, { run: slow, budgetMs: 300 });
    const info = (await git.resolveRepo(repo.root))!;
    const out = await untouched(repo.root, () => git.snapshot(info, req()));
    expect(out).toMatchObject({ ok: false, reason: "timeout" });
    expect(timeouts.length).toBe(1);
    expect(timeouts[0]!).toBeLessThanOrEqual(300);
    expect(await readdir(join(state, "checkpoint-tmp"))).toEqual([]);
  });

  test("files still changing through the settle rounds give unsettled (the last tree is kept)", async () => {
    const { repo, info, state } = await setup({ "a.txt": "0\n" });
    let n = 0;
    const git = cg(state, { sleep: async () => { n++; await writeFile(join(repo.root, "a.txt"), `${n}\n`); } });
    const out = await git.snapshot(info, req());
    expect(out.ok && out.unsettled).toBe(true);
    if (out.ok) expect(await blobAt(info, out.commit, "a.txt")).toBe(String(n));
    // Quiet files settle at once.
    const quiet = await cg(state).snapshot(info, req("end"));
    expect(quiet.ok && quiet.unsettled).toBe(false);
  });

  test("two snapshots on one store never overlap; two repos' snapshots may run side by side", async () => {
    const work = await root();
    const a = await makeRepo(work, "a"), b = await makeRepo(work, "b");
    const active = new Map<string, number>(); const peak = new Map<string, number>(); let globalPeak = 0, global = 0;
    const tracking: GitRunner = async (args, cwd, limits) => {
      const key = limits?.extraEnv?.GIT_DIR;
      if (!key) return spawnGit(args, cwd, limits);
      active.set(key, (active.get(key) ?? 0) + 1); peak.set(key, Math.max(peak.get(key) ?? 0, active.get(key)!));
      global++; globalPeak = Math.max(globalPeak, global);
      try { await Bun.sleep(2); return await spawnGit(args, cwd, limits); } finally { active.set(key, active.get(key)! - 1); global--; }
    };
    const git = cg(join(work, "state"), { run: tracking });
    const [ia, ib] = [(await git.resolveRepo(a.root))!, (await git.resolveRepo(b.root))!];
    const outs = await Promise.all([git.snapshot(ia, req("start", 1)), git.snapshot(ia, req("start", 2)), git.snapshot(ib, req("start", 1)), git.snapshot(ia, req("end", 1))]);
    expect(outs.every((o) => o.ok)).toBe(true);
    for (const [, n] of peak) expect(n).toBe(1);
    expect(globalPeak).toBeLessThanOrEqual(2);
  });

  test("a busy repo (the operator's git holds index.lock) still snapshots and its lock is left as it was; untracked names are literal, not globs", async () => {
    const { repo, git, info } = await setup({ "a.txt": "a\n" });
    await writeFile(join(repo.root, ".git", "index.lock"), "held by another git");
    await writeFiles(repo.root, { "[a].txt": "bracket\n", "a.txt": "edited\n" });
    const before = await fingerprint(join(repo.root, ".git"));
    const out = await git.snapshot(info, req());
    expect(gitDirChanges(before, await fingerprint(join(repo.root, ".git")))).toEqual([]);
    expect(out.ok).toBe(true);
    if (out.ok) { expect(await filesAt(info, out.commit)).toEqual(["[a].txt", "a.txt"]); expect(await blobAt(info, out.commit, "[a].txt")).toBe("bracket"); }
    await rm(join(repo.root, ".git", "index.lock"));
  });

  test("a retry or replay reuses the existing ref and moves nothing", async () => {
    const { repo, git, info } = await setup();
    const first = await git.snapshot(info, req());
    await writeFile(join(repo.root, "a.txt"), "changed after\n");
    const again = await untouched(repo.root, () => git.snapshot(info, req()));
    expect(first.ok && again.ok).toBe(true);
    if (first.ok && again.ok) { expect(again.commit).toBe(first.commit); expect(again.reused).toBe(true); }
  });

  test("a repo with no commits and a detached HEAD both snapshot (parentless, the worktree's content)", async () => {
    const work = await root();
    const empty = await makeRepo(work, "empty", {});
    await writeFiles(empty.root, { "first.txt": "1\n" });
    const git = cg(join(work, "state"));
    const eInfo = (await git.resolveRepo(empty.root))!;
    const e = await untouched(empty.root, () => git.snapshot(eInfo, req()));
    expect(e.ok).toBe(true);
    if (e.ok) { expect(await filesAt(eInfo, e.commit)).toEqual(["first.txt"]); expect(await storeGit(eInfo)("rev-list", "--parents", "-n", "1", e.commit)).toBe(e.commit); }

    const det = await makeRepo(work, "det", { "a.txt": "a\n" });
    await writeFile(join(det.root, "a.txt"), "b\n"); await det.git("commit", "-qam", "two");
    const first = await det.git("rev-parse", "HEAD~1");
    await det.git("checkout", "-q", "--detach", first);
    const dInfo = (await git.resolveRepo(det.root))!;
    const d = await untouched(det.root, () => git.snapshot(dInfo, req()));
    expect(d.ok).toBe(true);
    if (d.ok) { expect(await storeGit(dInfo)("rev-list", "--parents", "-n", "1", d.commit)).toBe(d.commit); expect(await blobAt(dInfo, d.commit, "a.txt")).toBe("a"); }
  });

  test("a revert, a merge in conflict, a rebase in conflict and a sparse index: the user's .git keeps every byte and every mtime (no freshened object)", async () => {
    // Revert: a.txt goes back to a blob the user's repo holds (packed and loose). With the real objects as
    // an alternate, git would touch that object's mtime instead of writing it.
    const rev = await setup({ "a.txt": "one\n", "b.txt": "two\n" });
    await rev.repo.git("gc", "-q");
    await writeFiles(rev.repo.root, { "a.txt": "edited\n" }); await rev.repo.git("commit", "-qam", "edit");
    await writeFiles(rev.repo.root, { "a.txt": "one\n", "copy.txt": "edited\n" });
    const r1 = await untouched(rev.repo.root, () => rev.git.snapshot(rev.info, req("start", 1)));
    expect(r1.ok).toBe(true); if (r1.ok) expect(await blobAt(rev.info, r1.commit, "a.txt")).toBe("one");

    // Mid-merge (conflict) and mid-rebase (conflict).
    const mg = await setup({ "a.txt": "base\n" });
    await mg.repo.git("checkout", "-qb", "other"); await writeFiles(mg.repo.root, { "a.txt": "other\n" }); await mg.repo.git("commit", "-qam", "o");
    await mg.repo.git("checkout", "-q", "main"); await writeFiles(mg.repo.root, { "a.txt": "main\n" }); await mg.repo.git("commit", "-qam", "m");
    await mg.repo.git("merge", "other").catch(() => {});
    const m1 = await untouched(mg.repo.root, () => mg.git.snapshot(mg.info, req("start", 1)));
    expect(m1.ok).toBe(true); if (m1.ok) expect(await blobAt(mg.info, m1.commit, "a.txt")).toContain("<<<<<<<");
    await mg.repo.git("merge", "--abort");
    await mg.repo.git("checkout", "-q", "other"); await mg.repo.git("rebase", "main").catch(() => {});
    const m2 = await untouched(mg.repo.root, () => mg.git.snapshot(mg.info, req("start", 2)));
    expect(m2.ok).toBe(true);

    // A sparse checkout with a sparse index: the snapshot still holds the files outside the cone.
    const sp = await setup({ "in/a.txt": "a\n", "out/b.txt": "b\n", "top.txt": "t\n", "vendor/secret.txt": "SECRET_VENDOR\n" });
    await sp.repo.git("sparse-checkout", "set", "--cone", "in");
    await sp.repo.git("config", "index.sparse", "true");
    await sp.repo.git("sparse-checkout", "reapply");
    await writeFiles(sp.repo.root, { "in/a.txt": "a2\n" });
    const spGit = cg(join(sp.work, "state-sparse")); // the repo's sparse settings are read now
    const spInfo = (await spGit.resolveRepo(sp.repo.root))!;
    expect(spInfo.config.join(" ")).toContain("index.sparse=true");
    const s1 = await untouched(sp.repo.root, () => spGit.snapshot(spInfo, req("start", 1)));
    expect(s1.ok).toBe(true);
    // `vendor/` (a refused name) sits outside the cone as one sparse-folder entry; it leaves the snapshot too.
    if (s1.ok) { expect(await filesAt(spInfo, s1.commit)).toEqual(["in/a.txt", "out/b.txt", "top.txt"]); expect(await blobAt(spInfo, s1.commit, "in/a.txt")).toBe("a2"); }
  });

  test("a shallow clone snapshots, and the private gc succeeds and frees what a deleted ref held", async () => {
    const work = await root();
    const src = await makeRepo(work, "src", { "a.txt": "1\n" });
    for (let i = 2; i < 6; i++) { await writeFiles(src.root, { "a.txt": `${i}\n` }); await src.git("commit", "-qam", `c${i}`); }
    await gitIn(work)("clone", "-q", "--depth", "1", `file://${src.root.replaceAll("\\", "/")}`, "sh");
    const shRoot = await realpath(join(work, "sh"));
    const git = cg(join(work, "state"));
    const info = (await git.resolveRepo(shRoot))!;
    const noise = () => randomBytes(150_000).toString("hex"); // incompressible, so freeing it shows
    await writeFiles(shRoot, { "a.txt": "dirty one\n", "big.txt": noise() });
    const one = await untouched(shRoot, () => git.snapshot(info, req("start", 1)));
    await writeFiles(shRoot, { "a.txt": "dirty two\n", "big.txt": noise() });
    const two = await git.snapshot(info, req("start", 2));
    expect(one.ok && two.ok).toBe(true); if (!one.ok || !two.ok) return;
    const sizeOf = async () => (await git.storeBytes(info.store))!;
    expect(await git.deleteRefs(info.store, [checkpointRef(req().threadId, 1, "start")])).toBe(true);
    const before = await sizeOf();
    expect(await git.gc({ store: info.store, objectsDir: info.objectsDir })).toBe(true);
    expect(await sizeOf()).toBeLessThan(before);
    expect(await storeGit(info)("cat-file", "-t", one.commit).catch(() => "gone")).toBe("gone");
    expect(await blobAt(info, two.commit, "a.txt")).toBe("dirty two");
  });

  test("every step that can throw before the snapshot proper (the store's init, the ref check, the HEAD read, the exclude copy) gives a failed outcome", async () => {
    // The store's folder cannot be made: `checkpoints` is a file.
    const a = await setup();
    await mkdir(a.state, { recursive: true }); await writeFile(join(a.state, "checkpoints"), "not a folder");
    expect(await a.git.snapshot(a.info, req())).toMatchObject({ ok: false, reason: "git-failed" });
    // The existing-ref check and the HEAD read throw (an injected runner, as a git that cannot start would).
    const boom = (match: (args: string[]) => boolean): GitRunner => async (args, cwd, limits) => { if (match(args)) throw new Error("spawn failed"); return spawnGit(args, cwd, limits); };
    for (const match of [(x: string[]) => x.some((s) => s.startsWith("refs/checkpoints/")), (x: string[]) => x.includes("HEAD^{commit}")]) {
      const b = await setup({ "a.txt": "a\n" }, { run: boom(match) });
      expect(await b.git.snapshot(b.info, req())).toMatchObject({ ok: false, reason: "git-failed" });
      expect(await readdir(join(b.state, "checkpoint-tmp")).catch(() => [])).toEqual([]);
    }
    // The exclude copy cannot be written: the store's `info` is a file.
    const c = await setup({ "a.txt": "a\n" });
    expect((await c.git.snapshot(c.info, req("start", 1))).ok).toBe(true);
    await rm(join(c.info.store, "info"), { recursive: true, force: true }); await writeFile(join(c.info.store, "info"), "not a folder");
    expect(await c.git.snapshot(c.info, req("start", 2))).toMatchObject({ ok: false, reason: "git-failed" });
  });

  test("the private-side guard: a relative state dir is made absolute; a GIT_DIR outside the stores, or a temp index elsewhere, is refused", async () => {
    const work = await root();
    const repo = await makeRepo(work, "repo");
    const rel = relative(process.cwd(), join(work, "state"));
    const git = cg(rel);
    const info = (await git.resolveRepo(repo.root))!;
    expect(isAbsolute(info.store)).toBe(true);
    expect((await git.snapshot(info, req())).ok).toBe(true);
    expect(git.storesDir).toBe(join(resolve(rel), "checkpoints"));
    // A write command against the user's own .git, or a store outside `checkpoints/`, never runs.
    await expect(git.storeRunner({ ...info, store: join(repo.root, ".git") })(["update-ref", "refs/x", "HEAD"])).rejects.toThrow(/not a private store/);
    await expect(git.storeRunner({ ...info, store: join(work, "elsewhere.git") })(["gc"])).rejects.toThrow(/not a private store/);
    await expect(git.storeRunner(info)(["write-tree"], { extraEnv: { GIT_INDEX_FILE: join(repo.root, ".git", "index") } })).rejects.toThrow(/temp index/);
    await expect(git.storeRunner(info)(["diff"], { extraEnv: { GIT_COMMON_DIR: join(repo.root, ".git") } })).rejects.toThrow(/GIT_COMMON_DIR/);
    await expect(git.storeRunner({ ...info, store: "relative.git" })(["gc"])).rejects.toThrow(/not a private store/);
    // Config by environment would undo the snapshot config; a lower-case name would slip past the checks on Windows.
    await expect(git.storeRunner(info)(["diff"], { extraEnv: { GIT_CONFIG_PARAMETERS: "'core.hookspath'='hooks'" } })).rejects.toThrow(/GIT_CONFIG_PARAMETERS is not allowed/);
    await expect(git.storeRunner(info)(["diff"], { extraEnv: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "hooks" } })).rejects.toThrow(/GIT_CONFIG_COUNT is not allowed/);
    await expect(git.storeRunner(info)(["diff"], { extraEnv: { GIT_CONFIG_GLOBAL: join(repo.root, "cfg") } })).rejects.toThrow(/GIT_CONFIG_GLOBAL is not allowed/);
    await expect(git.storeRunner(info)(["diff"], { extraEnv: { git_dir: join(repo.root, ".git") } })).rejects.toThrow(/upper case/);
    // `pack-objects` writes only into the store's own objects/pack.
    await expect(git.storeRunner(info)(["pack-objects", "-q", join(repo.root, ".git", "objects", "pack", "pack")])).rejects.toThrow(/objects\/pack/);
    await expect(git.storeRunner(info)(["pack-objects", "-q", "--stdout", join(info.store, "objects", "pack", "pack")])).rejects.toThrow(/objects\/pack/);
  });

  test("with a work root, a worktree whose git dir lies outside it is not snapshotted (the bridge would read files outside the root)", async () => {
    const outside = await root("sightr-cp-out-"), work = await root();
    const main = await makeRepo(outside, "main", { "a.txt": "a\n" });
    await main.git("worktree", "add", "-q", join(work, "linked"), "-b", "side");
    const linked = await realpath(join(work, "linked"));
    expect(await cg(join(work, "state"), { workRoot: work }).resolveRepo(linked)).toBeNull();
    expect(await cg(join(work, "state2")).resolveRepo(linked)).not.toBeNull();
    const own = await makeRepo(work, "own");
    expect(await cg(join(work, "state3"), { workRoot: work }).resolveRepo(own.root)).not.toBeNull();
  });

  test("8.3 aliases: a tracked entry named like the short name of .env or of a hidden folder is never snapshotted", async () => {
    expect(isHiddenPath("ENV~1", true)).toBe(true);
    expect(isHiddenPath("src/GITHUB~1/ci.yml", true)).toBe(true);
    expect(isHiddenPath("ENV~1", false)).toBe(false);
    expect(isHiddenPath("src/a.ts", true)).toBe(false);
    if (process.platform !== "win32") { console.warn("skipping the 8.3 alias snapshot: not Windows"); return; }
    const { repo, git, info } = await setup({ "a.txt": "a\n", ".github/ci.yml": "on: push\n" });
    await writeFile(join(repo.root, ".env"), "SECRET=1\n");
    const envShort = shortNameOf(repo.root, ".env"), dirShort = shortNameOf(repo.root, ".github");
    if (!envShort || !dirShort) { console.warn("skipping the 8.3 alias snapshot: this volume has no short names (8.3 name creation is off)"); return; }
    await trackAlias(repo.git, repo.root, envShort);
    await trackAlias(repo.git, repo.root, `${dirShort}/ci.yml`);
    await writeFiles(repo.root, { ".github/ci.yml": "on: SECRET_CI\n" });
    const out = await git.snapshot(info, req());
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(await filesAt(info, out.commit)).toEqual(["a.txt"]);
    const all = await storeGit(info)("cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)");
    for (const line of all.split("\n").filter(Boolean)) {
      const [oid, type] = line.split(" ");
      if (type === "blob") expect(await storeGit(info)("cat-file", "blob", oid!)).not.toContain("SECRET");
    }
  });

  test("a linked worktree and a submodule resolve their own git dir and index, and the shared objects dir", async () => {
    const work = await root();
    const main = await makeRepo(work, "main", { "a.txt": "a\n" });
    await main.git("worktree", "add", "-q", join(work, "linked"), "-b", "side");
    const git = cg(join(work, "state"));
    const linkedRoot = await realpath(join(work, "linked"));
    const lInfo = (await git.resolveRepo(linkedRoot))!;
    expect(lInfo.gitDir.toLowerCase()).toBe(join(main.root, ".git", "worktrees", "linked").toLowerCase());
    expect(lInfo.objectsDir.toLowerCase()).toBe(join(main.root, ".git", "objects").toLowerCase());
    expect(lInfo.indexPath.toLowerCase()).toBe(join(main.root, ".git", "worktrees", "linked", "index").toLowerCase());
    expect(lInfo.excludePath.toLowerCase()).toBe(join(main.root, ".git", "info", "exclude").toLowerCase());
    const mInfo = (await git.resolveRepo(main.root))!;
    expect(lInfo.repoKey).not.toBe(mInfo.repoKey); // own store per worktree, sharing real objects via alternates
    await writeFile(join(linkedRoot, "a.txt"), "linked edit\n");
    const before = await fingerprint(join(main.root, ".git"));
    const l = await git.snapshot(lInfo, req());
    expect(gitDirChanges(before, await fingerprint(join(main.root, ".git")))).toEqual([]);
    expect(l.ok).toBe(true); if (l.ok) expect(await blobAt(lInfo, l.commit, "a.txt")).toBe("linked edit");

    const lib = await makeRepo(work, "lib", { "lib.txt": "lib\n" });
    const sup = await makeRepo(work, "super", { "s.txt": "s\n" });
    await sup.git("submodule", "add", "-q", lib.root.replaceAll("\\", "/"), "sub");
    await sup.git("commit", "-qm", "sub");
    const subRoot = await realpath(join(sup.root, "sub"));
    const sInfo = (await git.resolveRepo(subRoot))!;
    expect(sInfo.gitDir.toLowerCase()).toBe(join(sup.root, ".git", "modules", "sub").toLowerCase());
    expect(sInfo.objectsDir.toLowerCase()).toBe(join(sup.root, ".git", "modules", "sub", "objects").toLowerCase());
    await writeFile(join(subRoot, "lib.txt"), "sub edit\n");
    const s = await untouched(subRoot, () => git.snapshot(sInfo, req()), sInfo.gitDir);
    expect(s.ok).toBe(true); if (s.ok) expect(await filesAt(sInfo, s.commit)).toEqual(["lib.txt"]);
  });

  test("CRLF under autocrlf=true: the stored blob is LF, as the operator's git status sees it", async () => {
    const work = await root();
    const repo = await makeRepo(work, "repo", { "a.txt": "one\ntwo\n" });
    await repo.git("config", "core.autocrlf", "true");
    await writeFile(join(repo.root, "a.txt"), "one\r\ntwo\r\nthree\r\n");
    const git = cg(join(work, "state")); // global says false; the repo's own true wins
    const info = (await git.resolveRepo(repo.root))!;
    expect(info.config.join(" ")).toContain("core.autocrlf=true");
    const out = await untouched(repo.root, () => git.snapshot(info, req()));
    expect(out.ok).toBe(true); if (out.ok) expect(await storeGit(info)("cat-file", "-p", `${out.commit}:a.txt`).then((s) => s.includes("\r"))).toBe(false);
  });

  test.skipIf(process.platform === "win32" || IS_ROOT)("an unreadable file is named in skippedPaths and the snapshot is still ready (POSIX: chmod 000; Windows locks are not simulated)", async () => {
    const { repo, git, info } = await setup({ "a.txt": "a\n", "locked.txt": "l\n" });
    await writeFiles(repo.root, { "locked.txt": "changed\n", "new-locked.txt": "n\n" });
    await chmod(join(repo.root, "locked.txt"), 0o000); await chmod(join(repo.root, "new-locked.txt"), 0o000);
    try {
      const out = await git.snapshot(info, req());
      expect(out.ok).toBe(true); if (!out.ok) return;
      expect(out.skippedPaths).toEqual(["locked.txt", "new-locked.txt"]);
    } finally { await chmod(join(repo.root, "locked.txt"), 0o644); await chmod(join(repo.root, "new-locked.txt"), 0o644); }
  });

  test.skipIf(!CAN_SYMLINK)("an untracked symlink is skipped, never followed", async () => {
    const { repo, git, info, work } = await setup({ "a.txt": "a\n" });
    await writeFile(join(work, "outside.txt"), "outside\n");
    await symlink(join(work, "outside.txt"), join(repo.root, "link.txt"));
    const out = await git.snapshot(info, req());
    expect(out.ok && out.skipped).toBe(1);
    if (out.ok) expect(await filesAt(info, out.commit)).toEqual(["a.txt"]);
  });

  test("an index git cannot read (corrupt copy) falls back to HEAD and still snapshots the worktree", async () => {
    const { repo, info, state } = await setup({ "a.txt": "a\n" });
    await writeFile(join(repo.root, "a.txt"), "edited\n");
    const git = cg(state);
    const broken: RepoInfo = { ...info, indexPath: join(state, "not-an-index") };
    await mkdir(state, { recursive: true }); await writeFile(broken.indexPath, "garbage");
    const out = await untouched(repo.root, () => git.snapshot(broken, req()));
    expect(out.ok).toBe(true); if (out.ok) expect(await blobAt(info, out.commit, "a.txt")).toBe("edited");
  });

  test("every call is allowlisted and carries the hardened prefix; real-repo calls are reads", async () => {
    const seen: string[][] = [];
    const rec: GitRunner = (args, cwd, limits) => { seen.push([...args, `@env:${limits?.extraEnv?.GIT_DIR ? "private" : "real"}`]); return spawnGit(args, cwd, limits); };
    const { repo, state } = await setup({ "a.txt": "a\n" });
    const git = cg(state, { run: rec });
    const info = (await git.resolveRepo(repo.root))!;
    await writeFile(join(repo.root, "a.txt"), "b\n");
    expect((await git.snapshot(info, req())).ok).toBe(true);
    expect(seen.length).toBeGreaterThan(5);
    for (const args of seen) {
      const flat = args.join(" ");
      expect(args).toContain("--no-optional-locks");
      expect(flat).toContain("diff.autoRefreshIndex=false");
      expect(flat).toContain("core.hooksPath=");
      expect(flat).toContain("core.fsmonitor=false");
      // The subcommand is the first argument after the `-c` pairs.
      let i = args.indexOf("--no-optional-locks") + 1;
      while (args[i] === "-c") i += 2;
      const sub = args[i]!;
      if (args.at(-1) === "@env:real") expect(CHECKPOINT_SUBCOMMANDS.real as readonly string[]).toContain(sub);
      else expect(CHECKPOINT_SUBCOMMANDS.private as readonly string[]).toContain(sub);
    }
    await expect(git.storeRunner(info)(["push", "origin"])).rejects.toThrow(/not allowed/);
  });
});

describe("checkpoint git: line endings, attributes and sparse folders (T30 safety review 2)", () => {
  const CRLF10 = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n";
  /** A repo whose `files` are committed byte for byte (the fixture's autocrlf is false), then `config` set; a fresh checkpoint git reads it. */
  async function lineEndingRepo(files: Record<string, string>, config: Record<string, string> = {}) {
    const work = await root();
    const repo = await makeRepo(work, "repo", files);
    for (const [k, v] of Object.entries(config)) await repo.git("config", k, v);
    const git = cg(join(work, "state"));
    const info = (await git.resolveRepo(repo.root))!;
    return { work, repo, git, info };
  }
  /** Worktree files two hours back and the real index refreshed after them: stat-clean and not racy. */
  async function notRacy(repo: { root: string; git: (...a: string[]) => Promise<string> }, files: string[]) {
    const t = Math.floor(Date.now() / 1000) - 7200;
    for (const f of files) await utimes(join(repo.root, ...f.split("/")), t, t);
    await repo.git("update-index", "--really-refresh").catch(() => "");
    await repo.git("status");
  }
  const counts = async (info: RepoInfo, git: ReturnType<typeof cg>, a: string, b: string) => {
    const d = await diffRun(git.storeRunner(info), a, b);
    return "error" in d ? d : d.files.map((f) => `${f.path} ${f.kind} ${f.additions}/${f.deletions}`);
  };
  const oidAt = (info: RepoInfo, commit: string, path: string) => storeGit(info)("rev-parse", `${commit}:${path}`);

  test("a CRLF-committed file under autocrlf=true, files older than the index: a one-line edit is 1/1 as git diff says, its blob is the one the operator's git add makes, an untouched file keeps its CRLF blob", async () => {
    const { repo, git, info } = await lineEndingRepo({ "win.bat": CRLF10, "other.bat": CRLF10, "lf.txt": "a\nb\n" }, { "core.autocrlf": "true" });
    expect(info.config.join(" ")).toContain("core.autocrlf=true");
    await notRacy(repo, ["win.bat", "other.bat", "lf.txt"]);
    const s = await untouched(repo.root, () => git.snapshot(info, req("start")));
    expect(s.ok).toBe(true); if (!s.ok) return;
    for (const f of ["win.bat", "other.bat", "lf.txt"]) expect(await oidAt(info, s.commit, f)).toBe(await repo.git("rev-parse", `HEAD:${f}`));
    await writeFile(join(repo.root, "win.bat"), CRLF10.replace("line 3", "line THREE"));
    const e = await untouched(repo.root, () => git.snapshot(info, req("end")));
    expect(e.ok).toBe(true); if (!e.ok) return;
    expect(await counts(info, git, s.commit, e.commit)).toEqual(["win.bat modified 1/1"]);
    expect(await repo.git("-c", "core.autocrlf=true", "diff", "--numstat")).toBe("1\t1\twin.bat");
    expect(await oidAt(info, e.commit, "other.bat")).toBe(await repo.git("rev-parse", "HEAD:other.bat"));
    // The operator's own `git add` (after the proofs: it writes their index and objects).
    await repo.git("-c", "core.autocrlf=true", "add", "win.bat");
    expect(await oidAt(info, e.commit, "win.bat")).toBe(await repo.git("rev-parse", ":win.bat"));
  });

  test("a CRLF-committed file under `* text=auto` (autocrlf false), files older than the index: a one-line edit is 1/1, the blob the operator's git add makes", async () => {
    const body = "x1\r\nx2\r\nx3\r\nx4\r\n";
    const { repo, git, info } = await lineEndingRepo({ "f.txt": body, "g.txt": "plain\n" });
    await writeFile(join(repo.root, ".gitattributes"), "* text=auto\n"); // a refused name, so never snapshotted; it applies all the same
    await notRacy(repo, ["f.txt", "g.txt"]);
    const s = await untouched(repo.root, () => git.snapshot(info, req("start")));
    expect(s.ok).toBe(true); if (!s.ok) return;
    expect(await oidAt(info, s.commit, "f.txt")).toBe(await repo.git("rev-parse", "HEAD:f.txt"));
    await writeFile(join(repo.root, "f.txt"), body.replace("x2", "y2"));
    const e = await untouched(repo.root, () => git.snapshot(info, req("end")));
    expect(e.ok).toBe(true); if (!e.ok) return;
    expect(await counts(info, git, s.commit, e.commit)).toEqual(["f.txt modified 1/1"]);
    expect(await repo.git("diff", "--numstat")).toBe("1\t1\tf.txt");
    await repo.git("add", "f.txt");
    expect(await oidAt(info, e.commit, "f.txt")).toBe(await repo.git("rev-parse", ":f.txt"));
  });

  test("racy at the start (an index no older than the files), the operator's git status mid-run, one CRLF file edited: only that file, 1/1; the untouched one is not rewritten", async () => {
    const { repo, git, info } = await lineEndingRepo({ "win.bat": CRLF10, "other.bat": CRLF10 }, { "core.autocrlf": "true" });
    // `untouched` sets the user's index an hour back: every entry is racy (the files are newer than the index).
    const s = await untouched(repo.root, () => git.snapshot(info, req("start")));
    expect(s.ok).toBe(true); if (!s.ok) return;
    for (const f of ["win.bat", "other.bat"]) expect(await oidAt(info, s.commit, f)).toBe(await repo.git("rev-parse", `HEAD:${f}`));
    await writeFile(join(repo.root, "win.bat"), CRLF10.replace("line 3", "line THREE"));
    await Bun.sleep(1100);
    await repo.git("status"); // the operator's git rewrites its index: no longer racy
    await ageTree(join(repo.root, ".git", "objects")); // a freshened object would show; the index keeps its new time
    const before = await fingerprint(join(repo.root, ".git"));
    const e = await git.snapshot(info, req("end"));
    expect(gitDirChanges(before, await fingerprint(join(repo.root, ".git")))).toEqual([]);
    expect(e.ok).toBe(true); if (!e.ok) return;
    expect(await counts(info, git, s.commit, e.commit)).toEqual(["win.bat modified 1/1"]);
  });

  test("info/attributes and core.attributesFile are the operator's: `*.txt -text` under autocrlf=true counts a CRLF rewrite as git diff does (3/2)", async () => {
    for (const where of ["info/attributes", "core.attributesFile"]) {
      const work = await root();
      const repo = await makeRepo(work, "repo", { "f.txt": "a\nb\n" });
      await repo.git("config", "core.autocrlf", "true");
      if (where === "info/attributes") await writeFile(join(repo.root, ".git", "info", "attributes"), "*.txt -text\n");
      else { await writeFile(join(work, "attrs"), "*.txt -text\n"); await repo.git("config", "core.attributesFile", join(work, "attrs")); }
      await notRacy(repo, ["f.txt"]);
      const git = cg(join(work, "state"));
      const info = (await git.resolveRepo(repo.root))!;
      const s = await untouched(repo.root, () => git.snapshot(info, req("start")));
      await writeFile(join(repo.root, "f.txt"), "a\r\nb\r\nc\r\n");
      const e = await untouched(repo.root, () => git.snapshot(info, req("end")));
      expect(s.ok && e.ok).toBe(true); if (!s.ok || !e.ok) return;
      expect(await repo.git("-c", "core.autocrlf=true", "diff", "--numstat")).toBe("3\t2\tf.txt");
      expect({ where, files: await counts(info, git, s.commit, e.commit) }).toEqual({ where, files: ["f.txt modified 3/2"] });
    }
  });

  test("a file rewritten between settle rounds is hashed against its real index entry each round (an LF version, then a CRLF one, of a CRLF-committed file)", async () => {
    const work = await root();
    const repo = await makeRepo(work, "repo", { "win.bat": CRLF10 });
    await repo.git("config", "core.autocrlf", "true");
    await writeFile(join(repo.root, "win.bat"), CRLF10.replaceAll("\r\n", "\n").replace("line 1", "line ONE"));
    let sleeps = 0;
    const crlf = CRLF10.replace("line 2", "line TWO");
    const git = cg(join(work, "state"), { sleep: async () => { if (sleeps++ === 0) await writeFile(join(repo.root, "win.bat"), crlf); } });
    const info = (await git.resolveRepo(repo.root))!;
    await ageTree(join(repo.root, ".git")); const before = await fingerprint(join(repo.root, ".git"));
    const out = await git.snapshot(info, req());
    expect(gitDirChanges(before, await fingerprint(join(repo.root, ".git")))).toEqual([]);
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(out.unsettled).toBe(false);
    // The real index blob holds CRLF, so git keeps the CRLF version as it is (the LF one in between must not decide).
    await repo.git("-c", "core.autocrlf=true", "add", "win.bat");
    expect(await oidAt(info, out.commit, "win.bat")).toBe(await repo.git("rev-parse", ":win.bat"));
    expect(await storeGit(info)("cat-file", "-p", `${out.commit}:win.bat`).then((t) => t.includes("line TWO\r\n"))).toBe(true);
  });

  async function sparseRepo(packed = false) {
    const work = await root();
    const repo = await makeRepo(work, "repo", { "in/a.txt": "a\n", "out/b.txt": "b\n", "out/deep/c.txt": "c\n", "top.txt": "t\n" });
    await repo.git("sparse-checkout", "set", "--cone", "in");
    await repo.git("config", "index.sparse", "true");
    await repo.git("sparse-checkout", "reapply");
    if (packed) await repo.git("gc", "-q");
    const git = cg(join(work, "state"));
    const info = (await git.resolveRepo(repo.root))!;
    return { work, repo, git, info };
  }

  test("a sparse index whose folder outside the cone is on disk (a new file there, a file put back, packed objects): absent sparse-checkout, and the user's .git keeps every byte and mtime", async () => {
    for (const variant of ["new file", "file put back", "packed"] as const) {
      const { repo, git, info } = await sparseRepo(variant === "packed");
      const s = await untouched(repo.root, () => git.snapshot(info, req("start")));
      expect(s.ok).toBe(true);
      if (variant === "file put back") await writeFiles(repo.root, { "out/b.txt": "b changed\n" });
      else await writeFiles(repo.root, { "out/new.txt": "n\n" });
      // No git of the operator's runs first (its `git status` would rewrite the index, see below).
      await ageTree(join(repo.root, ".git")); const before = await fingerprint(join(repo.root, ".git"));
      const e = await git.snapshot(info, req("end"));
      expect(gitDirChanges(before, await fingerprint(join(repo.root, ".git")))).toEqual([]);
      expect({ variant, e }).toMatchObject({ variant, e: { ok: false, reason: "sparse-checkout" } });
    }
  });

  test("a full-index sparse checkout: a file put back outside the cone is snapshotted as git status sees it (git clears its skip-worktree bit; nothing is expanded)", async () => {
    const work = await root();
    const repo = await makeRepo(work, "repo", { "in/a.txt": "a\n", "out/b.txt": "b\n", "out/c.txt": "c\n", "top.txt": "t\n" });
    await repo.git("sparse-checkout", "set", "--cone", "--no-sparse-index", "in");
    const git = cg(join(work, "state"));
    const info = (await git.resolveRepo(repo.root))!;
    const s = await untouched(repo.root, () => git.snapshot(info, req("start")));
    await writeFiles(repo.root, { "out/b.txt": "b changed\n" });
    expect(await repo.git("status", "--porcelain")).toBe("M out/b.txt");
    const e = await untouched(repo.root, () => git.snapshot(info, req("end")));
    expect(s.ok && e.ok).toBe(true); if (!s.ok || !e.ok) return;
    expect(await counts(info, git, s.commit, e.commit)).toEqual(["out/b.txt modified 1/1"]);
    expect(await filesAt(info, e.commit)).toEqual(["in/a.txt", "out/b.txt", "out/c.txt", "top.txt"]);
  });

  test("a sparse index: a new file in a new folder outside the cone (no index entry for it) is snapshotted, as git status lists it; the folders outside the cone stay whole", async () => {
    const { repo, git, info } = await sparseRepo();
    await writeFiles(repo.root, { "newdir/x.txt": "x\n", "in/a.txt": "a2\n" });
    const out = await untouched(repo.root, () => git.snapshot(info, req()));
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(await filesAt(info, out.commit)).toEqual(["in/a.txt", "newdir/x.txt", "out/b.txt", "out/deep/c.txt", "top.txt"]);
    expect(await blobAt(info, out.commit, "newdir/x.txt")).toBe("x");
  });

  test("a full index in a repo set to index.sparse (not collapsed yet) is read as it is, and every file outside the cone stays in the snapshot", async () => {
    const work = await root();
    const repo = await makeRepo(work, "repo", { "in/a.txt": "a\n", "out/b.txt": "b\n", "out/c.txt": "c\n", "top.txt": "t\n" });
    await repo.git("sparse-checkout", "set", "--cone", "--no-sparse-index", "in"); // a full index with skip-worktree entries
    await repo.git("config", "--worktree", "index.sparse", "true"); // no command has written the index since
    expect(await indexEntryCount(join(repo.root, ".git", "index"))).toBe(4);
    // git collapses it as it reads it (three entries, `out/` one of them); the snapshot must not take that shape.
    expect((await repo.git("ls-files", "--sparse")).split("\n")).toEqual(["in/a.txt", "out/", "top.txt"]);
    const git = cg(join(work, "state"));
    const info = (await git.resolveRepo(repo.root))!;
    expect(info.config.join(" ")).toContain("index.sparse=true");
    await writeFiles(repo.root, { "in/a.txt": "a2\n" });
    const out = await untouched(repo.root, () => git.snapshot(info, req()));
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(await filesAt(info, out.commit)).toEqual(["in/a.txt", "out/b.txt", "out/c.txt", "top.txt"]);
    expect(await blobAt(info, out.commit, "in/a.txt")).toBe("a2");
  });

  test("indexEntryCount reads the header: the entries a full index holds, null with no file, NaN for a file that is not an index", async () => {
    const { repo, state } = await setup({ "a.txt": "a\n", "b/c.txt": "c\n" });
    expect(await indexEntryCount(join(repo.root, ".git", "index"))).toBe(2);
    expect(await indexEntryCount(join(state, "none"))).toBeNull();
    await mkdir(state, { recursive: true }); await writeFile(join(state, "junk"), "not an index, but long enough");
    expect(await indexEntryCount(join(state, "junk"))).toBeNaN();
  });

  test.skipIf(process.platform !== "win32")("Windows: files another process holds open with no sharing are named in skippedPaths, keep their index entry, and the snapshot is still ready", async () => {
    const { repo, git, info } = await setup({ "a.txt": "a\n", "locked.txt": "l\n" });
    await writeFiles(repo.root, { "a.txt": "a2\n", "locked.txt": "changed\n", "new-locked.txt": "n\n" });
    const ps = (p: string) => join(repo.root, p).replaceAll("'", "''");
    const holder = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      `$a=[IO.File]::Open('${ps("locked.txt")}','Open','ReadWrite','None'); $b=[IO.File]::Open('${ps("new-locked.txt")}','Open','ReadWrite','None'); 'locked'; Start-Sleep -Seconds 60`], { stdout: "pipe", stderr: "ignore" });
    try {
      const reader = holder.stdout.getReader(); let said = "";
      while (!said.includes("locked")) { const { value, done } = await reader.read(); if (done) break; said += new TextDecoder().decode(value); }
      expect(said).toContain("locked");
      const out = await git.snapshot(info, req());
      expect(out.ok).toBe(true); if (!out.ok) return;
      expect(out.skippedPaths).toEqual(["locked.txt", "new-locked.txt"]);
      expect(await blobAt(info, out.commit, "a.txt")).toBe("a2");
      expect(await blobAt(info, out.commit, "locked.txt")).toBe("l");
      expect(await filesAt(info, out.commit)).toEqual(["a.txt", "locked.txt"]);
    } finally { holder.kill(); await holder.exited; }
  });
});

describe.skipIf(process.platform !== "win32")("checkpoint git: Windows", () => {
  // git for Windows cannot open a repo whose `.git/config` is past MAX_PATH (not even with `-c core.longpaths`),
  // and the objects dir is as long as that, so the alternate itself is always under 260 characters. What does
  // pass 260 is everything below it (loose objects, pack files) and deep worktree files.
  test("objects and worktree files past 260 characters snapshot through core.longpaths and the alternates env", async () => {
    const work = await root();
    let parent = work; while (parent.length < 200) parent = join(parent, "seg-xxxxxxxxx");
    const name = "r".repeat(Math.max(1, 232 - parent.length - 1));
    await mkdir(parent, { recursive: true });
    const repo = await makeRepo(parent, name, { "a.txt": "a\n", "kept.txt": "only in the real repo\n" });
    const git = cg(join(work, "state"));
    const info = (await git.resolveRepo(repo.root))!;
    expect(info.objectsDir.length).toBeGreaterThan(240);
    expect(info.objectsDir.length + 42).toBeGreaterThan(260); // a loose object under the alternate
    const deepFile = `${"d".repeat(20)}/${"e".repeat(20)}/f.txt`;
    await writeFiles(repo.root, { "a.txt": "long\n", [deepFile]: "deep\n" });
    expect(join(repo.root, deepFile).length).toBeGreaterThan(260);
    const out = await git.snapshot(info, req());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(await blobAt(info, out.commit, "a.txt")).toBe("long");
      expect(await blobAt(info, out.commit, deepFile)).toBe("deep");
      expect(await blobAt(info, out.commit, "kept.txt")).toBe("only in the real repo"); // read through the alternate
    }
  });
  test("case-insensitive roots: a different-case path resolves to the same store", async () => {
    const { repo, git, info } = await setup();
    const other = (await git.resolveRepo(repo.root.toUpperCase()))!;
    expect(other.repoKey).toBe(info.repoKey);
  });
});
