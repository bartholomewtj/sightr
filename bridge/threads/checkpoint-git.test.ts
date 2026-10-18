import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { fingerprint, gitDirChanges, gitIn, makeRepo, rmrf, tempRoot, writeFiles } from "../test/git-fixtures.ts";
import { spawnGit, type GitRunner } from "../workdir-git.ts";
import {
  alternatesValue, BUSY, CHECKPOINT_SUBCOMMANDS, checkpointRef, configPairs, createCheckpointGit, createStoreQueue, MAX_FILE_BYTES, parseAddErrors, refId, repoKeyOf, SNAPSHOT_CONFIG,
  type CheckpointGitOptions, type RepoInfo,
} from "./checkpoint-git.ts";

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
    expect(repoKeyOf("C:\\Repo\\.git")).toBe(repoKeyOf("c:\\repo\\.git"));
  });
  test("alternatesValue quotes a path holding the list separator", () => {
    expect(alternatesValue("/a/b", ":")).toBe("/a/b");
    expect(alternatesValue("/a:b", ":")).toBe('"/a:b"');
    expect(alternatesValue("C:\\x;y", ";")).toBe('"C:\\\\x;y"');
  });
  test("configPairs keeps only values git accepts and expands ~ in the excludes file", () => {
    const m = configPairs("core.autocrlf true\ncore.eol bogus\ncore.ignorecase TRUE\ncore.filemode maybe\ncore.excludesfile ~/ig\nuser.name x\n", "/home/u");
    expect(m.get("core.autocrlf")).toBe("true");
    expect(m.has("core.eol")).toBe(false);
    expect(m.get("core.ignorecase")).toBe("true");
    expect(m.has("core.filemode")).toBe(false);
    expect(m.get("core.excludesfile")).toBe(join("/home/u", "ig"));
    expect(m.has("user.name")).toBe(false);
  });
  test("parseAddErrors names unreadable paths and refuses what it does not understand", () => {
    expect(parseAddErrors("error: open(\"locked.txt\"): Permission denied\nerror: unable to index file 'locked.txt'\nfatal: adding files failed\n")).toEqual({ paths: ["locked.txt"], understood: true });
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
});

describe("checkpoint git: snapshots", () => {
  test("a clean tree: the commit and ref land in the private store, the user's .git is byte-identical", async () => {
    const { repo, git, info, state } = await setup({ "a.txt": "one\n", "src/b.ts": "export const b = 1;\n" });
    const head = await repo.git("rev-parse", "HEAD");
    const out = await untouched(repo.root, () => git.snapshot(info, req()));
    expect(out.ok).toBe(true); if (!out.ok) return;
    expect(info.store).toBe(join(state, "checkpoints", `${info.repoKey}.git`));
    expect(await filesAt(info, out.commit)).toEqual(["a.txt", "src/b.ts"]);
    expect(await storeGit(info)("rev-parse", `${out.commit}^`)).toBe(head);
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
    const { repo, git, work } = await setup({ "a.txt": "a\n" });
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
    const fresh = (await cg(join(work, "state2")).resolveRepo(repo.root))!; // config is read now
    // No `git status` around this one: the operator's own git WOULD run that fsmonitor and filter.
    const before = await fingerprint(join(repo.root, ".git"));
    const out = await git.snapshot(fresh, req());
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

  test("a repo with no commits has a parentless snapshot; a detached HEAD only changes the parent", async () => {
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
    if (d.ok) { expect(await storeGit(dInfo)("rev-parse", `${d.commit}^`)).toBe(first); expect(await blobAt(dInfo, d.commit, "a.txt")).toBe("a"); }
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
