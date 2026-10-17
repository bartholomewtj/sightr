import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autocrlfArgs, createFolderGit, DIFF_CAP_BYTES, findWorktreeRoot, isHiddenPath, MAX_DIFF_PATHS, MAX_PANE_IDS, parseLogZ, parseNumstatRecord, parseStatusV2, spawnGit } from "./workdir-git.ts";
import type { FolderGitResponse } from "../shared/wire.ts";

const rootTemp = async (name: string) => realpath(await mkdtemp(join(tmpdir(), name)));
const run = (stdout: string, extra: Partial<{ code: number; failed: boolean; timedOut: boolean }> = {}) => ({ code: 0, stdout, stderr: "", failed: false, timedOut: false, ...extra });

describe("pane git", () => {
  test("parses porcelain v2 records without losing paths", () => {
    const parsed = parseStatusV2([
      "# branch.head main", "# branch.oid abc",
      "1 .M N... 100644 100644 100644 abc def src/file with spaces.ts",
      "? new file.ts", "! ignored.txt", "2 R. N... 100644 100644 100644 100644 abc def ghi jkl old new.txt",
    ]);
    expect(parsed.branch).toBe("main");
    expect(parsed.entries).toEqual([
      { path: "src/file with spaces.ts", x: ".", y: "M", tracked: true },
      { path: "new file.ts", x: "?", y: "?", tracked: false },
    ]);
    expect(parseStatusV2(["# branch.head (detached)", "# branch.oid (initial)"]).detached).toBe(true);
    expect(parseStatusV2(["# branch.head (detached)", "# branch.oid (initial)"]).noCommits).toBe(true);
    // Real -z output can attach newline-delimited headers to the first record.
    expect(parseStatusV2(["# branch.head feature\n# branch.oid abc\n1 .M N... 100644 100644 100644 abc def spaced.ts"])).toMatchObject({ branch: "feature", entries: [{ path: "spaced.ts" }] });
  });

  test("uses the Files refusal list for every path segment", () => {
    for (const path of [".env", "a/.env", "config/creds.json", "node_modules/x/y.js", "deploy/key.pem", ".github/workflows/ci.yml"]) expect(isHiddenPath(path)).toBe(true);
    for (const path of ["src/api.ts", "web/env.ts", "README.md"]) expect(isHiddenPath(path)).toBe(false);
  });

  test("walks to a repo and accepts linked-worktree git files", async () => {
    const root = await rootTemp("sightr-git-walk-");
    try {
      await mkdir(join(root, "repo", "sub", "deep"), { recursive: true }); await mkdir(join(root, "repo", ".git"));
      expect(await findWorktreeRoot(join(root, "repo", "sub", "deep"), root)).toBe(join(root, "repo"));
      await rm(join(root, "repo", ".git"), { recursive: true }); await writeFile(join(root, "repo", ".git"), "gitdir: elsewhere");
      expect(await findWorktreeRoot(join(root, "repo", "sub"), root)).toBe(join(root, "repo"));
      await mkdir(join(root, "above", ".git"), { recursive: true });
      expect(await findWorktreeRoot(root, join(root, "repo"))).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("hardens calls, filters secrets, and never diffs untracked files", async () => {
    const root = await rootTemp("sightr-git-fake-"); await mkdir(join(root, "repo", ".git"), { recursive: true });
    const calls: string[][] = [];
    const fake = async (args: string[]) => { calls.push(args); if (args[11] === "rev-parse") return run(join(root, "repo") + "\n"); if (args[11] === "status") return run(["# branch.head main", "# branch.oid abc", "1 .M N... 100644 100644 100644 a b src/a.ts", "1 .M N... 100644 100644 100644 a b .env", "1 .M N... 100644 100644 100644 a b config/db.json", "? new.ts", ""].join("\0")); return run("diff -- a.ts\n"); };
    const response = await createFolderGit(root, fake as any).inspect(join(root, "repo"));
    expect(response).toMatchObject({ available: true, entries: [{ path: "src/a.ts" }, { path: "new.ts" }], hidden: 2 });
    for (const args of calls) { expect(args).toContain("--no-pager"); expect(args).toContain("-c"); expect(args).toContain("core.hooksPath=" + (process.platform === "win32" ? "\\\\.\\nul" : "/dev/null")); expect(args).toContain("diff.external="); expect(args).toContain("color.ui=false"); }
    const diffCall = calls.find((args) => args[11] === "diff")!; expect(diffCall).toContain("--no-ext-diff"); expect(diffCall).toContain("--no-textconv"); expect(diffCall).toContain("--no-renames"); expect(diffCall).toContain("--no-color"); expect(calls.find((x) => x[11] === "status")).not.toContain(".");
    expect(JSON.stringify(response)).not.toContain(".env");
    expect(calls.find((x) => x[11] === "diff")).toContain(":(literal,top)src/a.ts");
    expect(calls.find((x) => x[11] === "diff")?.some((x) => x.includes("new.ts"))).toBe(false);
        await rm(root, { recursive: true, force: true });
  });

  test("returns honest unavailable states and handles a clean tree", async () => {
    const root = await rootTemp("sightr-git-states-"); await mkdir(join(root, "repo", ".git"), { recursive: true });
    const inspect = (result: any) => createFolderGit(root, async (args) => args[11] === "rev-parse" ? result : run("")).inspect(join(root, "repo"));
    expect(await inspect(run("", { code: 1 }))).toEqual({ available: false, reason: "not-a-repo" });
    expect(await inspect(run("", { failed: true }))).toEqual({ available: false, reason: "git-unavailable" });
    expect(await inspect(run("", { timedOut: true }))).toEqual({ available: false, reason: "timeout" });
    const mismatchRoot = join(root, "repo", "other"); await mkdir(mismatchRoot, { recursive: true });
    expect(await createFolderGit(root, async (args) => args[11] === "rev-parse" ? run(mismatchRoot) : run("")).inspect(join(root, "repo"))).toEqual({ available: false, reason: "not-a-repo" });
    const cleanCalls: string[][] = [];
    const clean = await createFolderGit(root, async (args) => { cleanCalls.push(args); return args[11] === "rev-parse" ? run(join(root, "repo")) : run("# branch.head main\0# branch.oid abc\0"); }).inspect(join(root, "repo"));
    expect(clean).toMatchObject({ clean: true, entries: [], diff: "", panes: [] });
    expect(await createFolderGit(root, async () => run("", { code: 1 })).inspect(join(root, "repo"))).not.toHaveProperty("panes");
    expect(cleanCalls.some((args) => args[11] === "diff")).toBe(false);
    expect(await createFolderGit(root, async () => { throw new Error("must not run"); }).inspect(join(root, "outside"))).toEqual({ available: false, reason: "outside-root" });
    await rm(root, { recursive: true, force: true });
  });

  test("reads a subfolder from the repository root and filters pane membership", async () => {
    const root = await rootTemp("sightr-git-folder-"); const repo = join(root, "repo"); await mkdir(join(repo, ".git"), { recursive: true }); await mkdir(join(repo, "sub")); await mkdir(join(root, "other"));
    const cwdCalls: string[] = []; const response = await createFolderGit(root, async (args, cwd) => { cwdCalls.push(cwd); return args[11] === "rev-parse" ? run(repo) : run("# branch.head main\\0# branch.oid abc\\0"); }).inspect(join(repo, "sub"), [{ paneId: "a", cwd: repo }, { paneId: "a", cwd: root }, { paneId: "b", cwd: join(repo, "sub") }, { paneId: "c", cwd: join(root, "other") }, { paneId: "d", cwd: join(repo, "missing") }]);
    expect(response).toMatchObject({ rel: "sub", panes: ["a", "b"] }); expect(cwdCalls).toContain(repo); expect(cwdCalls).not.toContain(join(repo, "sub")); await rm(root, { recursive: true, force: true });
  });

  test("caps pane membership checks", async () => {
    const root = await rootTemp("sightr-git-pane-cap-"); const repo = join(root, "repo"); await mkdir(join(repo, ".git"), { recursive: true }); const checked: string[] = [];
    const response = await createFolderGit(root, async (args) => args[11] === "rev-parse" ? run(repo) : run("# branch.head main\\0# branch.oid abc\\0")).inspect(repo, Array.from({ length: MAX_PANE_IDS + 1 }, (_, i) => ({ paneId: String(i), cwd: (checked.push(String(i)), repo) })));
    expect(response).toMatchObject({ panes: Array.from({ length: MAX_PANE_IDS }, (_, i) => String(i)) }); await rm(root, { recursive: true, force: true });
  });

  test("caps diff and pathspecs", async () => {
    const root = await rootTemp("sightr-git-caps-"); await mkdir(join(root, "repo", ".git"), { recursive: true });
    let diffArgs: string[] = [];
    const paths = Array.from({ length: 300 }, (_, i) => `1 .M N... 100644 100644 100644 a b c src/${i}.ts`).join("\0");
    const response = await createFolderGit(root, async (args) => { if (args[11] === "rev-parse") return run(join(root, "repo")); if (args[11] === "status") return run(paths); if (args[11] === "diff") diffArgs = args; return run("x".repeat(DIFF_CAP_BYTES - 1) + "\n" + "y".repeat(100)); }).inspect(join(root, "repo"));
    expect(diffArgs.filter((x) => x.startsWith(":(literal,top)"))).toHaveLength(MAX_DIFF_PATHS);
    expect(response).toMatchObject({ diffTruncated: true }); expect((response as any).diff.length).toBeLessThanOrEqual(DIFF_CAP_BYTES); expect((response as any).diff.endsWith("\n")).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  // Real git processes: under a loaded full run these have passed 5 s, so they get their own budget.
  test("reads a real git repository without leaking hidden content", async () => {
    const probe = Bun.spawn(["git", "--version"], { stdout: "ignore", stderr: "ignore" });
    if (await probe.exited !== 0) { console.warn("skipping real-git test: git is unavailable"); return; }
    const work = await rootTemp("sightr-git-real-"); const repo = join(work, "repo"); await mkdir(repo, { recursive: true });
    const git = async (args: string[]) => { const p = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" }); await p.exited; return p; };
    try { await git(["init", "-q"]); await writeFile(join(repo, "a.txt"), "before\n"); await git(["add", "a.txt"]); await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]); await writeFile(join(repo, "a.txt"), "after\n"); await writeFile(join(repo, ".env"), "SECRET=1\n"); await git(["add", "-A"]); const response = await createFolderGit(work, spawnGit).inspect(repo); expect(response).toMatchObject({ available: true, hidden: 1, panes: [] }); expect(JSON.stringify(response)).toContain("a.txt"); expect(JSON.stringify(response)).not.toContain(work); expect(JSON.stringify(response)).not.toContain(".env"); expect((response as any).diff).not.toContain("SECRET"); } finally { await rm(work, { recursive: true, force: true }); }
  }, 30_000);
});

describe("history", () => {
  test("parses upstream and ahead/behind from the status headers; a gone upstream has no counts", () => {
    expect(parseStatusV2(["# branch.oid abc", "# branch.head feat", "# branch.upstream origin/feat", "# branch.ab +3 -1"])).toMatchObject({ branch: "feat", upstream: "origin/feat", ahead: 3, behind: 1 });
    expect(parseStatusV2(["# branch.head feat\n# branch.upstream origin/main\n# branch.ab +0 -2\n1 .M N... 100644 100644 100644 a b x.ts"])).toMatchObject({ upstream: "origin/main", ahead: 0, behind: 2, entries: [{ path: "x.ts" }] });
    const gone = parseStatusV2(["# branch.head feat", "# branch.upstream origin/feat"]);
    expect(gone.upstream).toBe("origin/feat"); expect(gone).not.toHaveProperty("ahead");
  });

  test("parses log -z numstat records, binary files and odd paths included", () => {
    const sha = "a".repeat(40), sha2 = "b".repeat(40);
    const out = `\x1e${sha}\x1faaaaaaa\x1f1700000000\x1f${sha2}\x1fAda\x1ffix: tabs\x1fand all\0\n1\t2\tsrc/a b.ts\0-\t-\timg.png\0\x1e${sha2}\x1fbbbbbbb\x1f1690000000\x1f\x1fAda\x1froot\0\n`;
    expect(parseLogZ(out)).toEqual([
      { sha, short: "aaaaaaa", time: 1700000000, parents: 1, author: "Ada", subject: "fix: tabs\x1fand all", stats: [{ path: "src/a b.ts", added: 1, removed: 2 }, { path: "img.png", added: 0, removed: 0, binary: true }] },
      { sha: sha2, short: "bbbbbbb", time: 1690000000, parents: 0, author: "Ada", subject: "root", stats: [] },
    ]);
    expect(parseLogZ("not a log")).toEqual([]);
    expect(parseNumstatRecord("x\ty\tz")).toBeNull();
  });

  test("refuses anything but a hex sha before git runs, and fences every revision with --", async () => {
    const root = await rootTemp("sightr-git-sha-"); await mkdir(join(root, "repo", ".git"), { recursive: true });
    try {
      const calls: string[][] = [];
      const git = createFolderGit(root, async (args) => { calls.push(args); return args[11] === "rev-parse" && args.includes("--show-toplevel") ? run(join(root, "repo")) : run("", { code: 1 }); });
      for (const sha of ["HEAD", "--output=x", "abc", "ABCDEF1", "a1b2c3d..HEAD", "a1b2c3d^", "@{upstream}", "a".repeat(41), "a1b2c3d e"]) {
        expect(await git.diff(join(root, "repo"), { scope: "commit", sha })).toEqual({ available: false, reason: "bad-commit" });
      }
      expect(calls).toEqual([]);
      expect(await git.diff(join(root, "repo"), { scope: "commit", sha: "a1b2c3d" })).toEqual({ available: false, reason: "bad-commit" });
      expect(calls.find((a) => a.includes("--verify"))).toContain("a1b2c3d^{commit}");
      expect(await git.diff(join(root, "outside"), { scope: "branch" })).toEqual({ available: false, reason: "outside-root" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // Real git processes: a bare "remote", a clone pushed once, then local commits ahead of it.
  test("shows committed work: upstream, ahead/behind, recent commits, the branch range and one commit", async () => {
    const work = await rootTemp("sightr-git-hist-"); const up = join(work, "up.git"), repo = join(work, "repo");
    const git = async (cwd: string, args: string[]) => { const p = Bun.spawn(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); await p.exited; return (await new Response(p.stdout).text()).trim(); };
    try {
      await mkdir(up); await git(up, ["init", "-q", "--bare", "-b", "main"]); await mkdir(repo); await git(repo, ["init", "-q", "-b", "main"]); await git(repo, ["remote", "add", "origin", up]);
      await writeFile(join(repo, "a.txt"), "one\n"); await git(repo, ["add", "-A"]); await git(repo, ["commit", "-qm", "base"]); await git(repo, ["push", "-q", "-u", "origin", "main"]);
      await writeFile(join(repo, "a.txt"), "one\ntwo\n"); await writeFile(join(repo, ".env"), "SECRET=1\n"); await git(repo, ["add", "-A"]); await git(repo, ["commit", "-qm", "add two"]);
      await mkdir(join(repo, "src")); await writeFile(join(repo, "src", "b.ts"), "export {}\n"); await git(repo, ["add", "-A"]); await git(repo, ["commit", "-qm", "add b"]);
      await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\n");
      const folder = createFolderGit(work, spawnGit);
      const status = await folder.inspect(repo) as Extract<FolderGitResponse, { available: true }>;
      expect(status).toMatchObject({ available: true, branch: "main", upstream: "origin/main", base: "origin/main", ahead: 2, behind: 0, rootPath: "repo", entries: [{ path: "a.txt" }] });
      expect(status.commits?.map((c) => [c.subject, c.ahead ?? false, c.files, c.added, c.removed])).toEqual([["add b", true, 1, 1, 0], ["add two", true, 1, 1, 0], ["base", false, 1, 1, 0]]);
      expect(status.commits?.[0]?.short).toMatch(/^[0-9a-f]{7,}$/);
      expect(JSON.stringify(status)).not.toContain(".env"); expect(JSON.stringify(status)).not.toContain(work);

      const branch = await folder.diff(repo, { scope: "branch" });
      expect(branch).toMatchObject({ available: true, scope: "branch", base: "origin/main", hidden: 1, files: [{ path: "a.txt", added: 1, removed: 0 }, { path: "src/b.ts", added: 1, removed: 0 }] });
      expect((branch as any).diff).toContain("+two"); expect((branch as any).diff).not.toContain("three"); expect((branch as any).diff).not.toContain("SECRET");

      const short = status.commits![1]!.short;
      const commit = await folder.diff(repo, { scope: "commit", sha: short });
      expect(commit).toMatchObject({ available: true, scope: "commit", commit: { subject: "add two", files: 1 }, hidden: 1, files: [{ path: "a.txt" }] });
      expect((commit as any).diff).toContain("+two"); expect((commit as any).diff).not.toContain("SECRET");
      const root = await folder.diff(repo, { scope: "commit", sha: status.commits![2]!.sha });
      expect(root).toMatchObject({ available: true, commit: { subject: "base", parents: 0 }, files: [{ path: "a.txt", added: 1 }] });
      expect(await folder.diff(repo, { scope: "commit", sha: "0000000" })).toEqual({ available: false, reason: "bad-commit" });

      // Behind: the remote moves on; a branch with no upstream measures from main.
      await git(repo, ["push", "-q", "origin", "HEAD:main"]); await git(repo, ["reset", "-q", "--hard", "HEAD~1"]); await git(repo, ["fetch", "-q"]);
      expect(await folder.inspect(repo)).toMatchObject({ upstream: "origin/main", ahead: 0, behind: 1 });
      await git(repo, ["remote", "set-head", "origin", "main"]); await git(repo, ["checkout", "-q", "-b", "feat"]); await writeFile(join(repo, "c.txt"), "c\n"); await git(repo, ["add", "c.txt"]); await git(repo, ["commit", "-qm", "feat work"]);
      const feat = await folder.inspect(repo) as Extract<FolderGitResponse, { available: true }>;
      // No upstream: the range is measured from origin's default branch (origin/HEAD, set above).
      expect(feat).toMatchObject({ branch: "feat", base: "origin/main", ahead: 1, behind: 1 }); expect(feat).not.toHaveProperty("upstream");
      expect(feat.commits?.map((c) => c.ahead ?? false)).toEqual([true, false, false]);
      expect(await folder.diff(repo, { scope: "branch" })).toMatchObject({ available: true, base: "origin/main", files: [{ path: "c.txt" }] });
    } finally { await rm(work, { recursive: true, force: true }); }
  }, 60_000);

  test("a repo with no other branch to compare has no base", async () => {
    const work = await rootTemp("sightr-git-nobase-"); const repo = join(work, "repo"); await mkdir(repo);
    const git = (args: string[]) => spawnGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], repo);
    try {
      await git(["init", "-q", "-b", "main"]); await writeFile(join(repo, "a.txt"), "a\n"); await git(["add", "a.txt"]); await git(["commit", "-qm", "only"]);
      const folder = createFolderGit(work, spawnGit);
      const status = await folder.inspect(repo);
      expect(status).toMatchObject({ available: true, branch: "main", commits: [{ subject: "only" }] }); expect(status).not.toHaveProperty("base"); expect(status).not.toHaveProperty("ahead");
      expect(await folder.diff(repo, { scope: "branch" })).toEqual({ available: false, reason: "no-base" });
    } finally { await rm(work, { recursive: true, force: true }); }
  }, 30_000);
});

describe("autocrlf passthrough", () => {
  test("only the three legal values become a -c flag", () => {
    expect(autocrlfArgs("true\n")).toEqual(["-c", "core.autocrlf=true"]); expect(autocrlfArgs("Input")).toEqual(["-c", "core.autocrlf=input"]); expect(autocrlfArgs("false")).toEqual(["-c", "core.autocrlf=false"]);
    expect(autocrlfArgs(undefined)).toEqual([]); expect(autocrlfArgs("")).toEqual([]); expect(autocrlfArgs("yes; rm -rf /")).toEqual([]);
  });
  // Real git processes: under a loaded full run these have passed 5 s, so they get their own budget.
  test("an LF-committed file that git checked out with CRLF is clean only when autocrlf=true is passed through", async () => {
    const work = await mkdtemp(join(tmpdir(), "sightr-git-crlf-")); const repo = join(work, "repo"); await mkdir(repo);
    const git = (args: string[]) => spawnGit(args, repo);
    try {
      await git(["init", "-q"]); await writeFile(join(repo, "a.txt"), "one\ntwo\n"); await git(["add", "a.txt"]); await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]); await rm(join(repo, "a.txt")); await git(["-c", "core.autocrlf=true", "checkout", "--", "a.txt"]); expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("one\r\ntwo\r\n");
      const withCrlf = await createFolderGit(work, (args, cwd) => spawnGit(["-c", "core.autocrlf=true", ...args], cwd)).inspect(repo); expect(withCrlf).toMatchObject({ available: true, clean: true, diff: "" });
      const without = await createFolderGit(work, (args, cwd) => spawnGit(["-c", "core.autocrlf=false", ...args], cwd)).inspect(repo); expect(without).toMatchObject({ available: true, clean: false });
    } finally { await rm(work, { recursive: true, force: true }); }
  }, 30_000);
});
