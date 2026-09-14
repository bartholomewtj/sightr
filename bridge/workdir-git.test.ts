import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autocrlfArgs, createFolderGit, DIFF_CAP_BYTES, findWorktreeRoot, isHiddenPath, MAX_DIFF_PATHS, MAX_PANE_IDS, parseStatusV2, spawnGit } from "./workdir-git.ts";

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
    const response = await createFolderGit(root, async (args) => { if (args[11] === "rev-parse") return run(join(root, "repo")); if (args[11] === "status") return run(paths); diffArgs = args; return run("x".repeat(DIFF_CAP_BYTES - 1) + "\n" + "y".repeat(100)); }).inspect(join(root, "repo"));
    expect(diffArgs.filter((x) => x.startsWith(":(literal,top)"))).toHaveLength(MAX_DIFF_PATHS);
    expect(response).toMatchObject({ diffTruncated: true }); expect((response as any).diff.length).toBeLessThanOrEqual(DIFF_CAP_BYTES); expect((response as any).diff.endsWith("\n")).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  test("reads a real git repository without leaking hidden content", async () => {
    const probe = Bun.spawn(["git", "--version"], { stdout: "ignore", stderr: "ignore" });
    if (await probe.exited !== 0) { console.warn("skipping real-git test: git is unavailable"); return; }
    const work = await rootTemp("sightr-git-real-"); const repo = join(work, "repo"); await mkdir(repo, { recursive: true });
    const git = async (args: string[]) => { const p = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" }); await p.exited; return p; };
    try { await git(["init", "-q"]); await writeFile(join(repo, "a.txt"), "before\n"); await git(["add", "a.txt"]); await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]); await writeFile(join(repo, "a.txt"), "after\n"); await writeFile(join(repo, ".env"), "SECRET=1\n"); await git(["add", "-A"]); const response = await createFolderGit(work, spawnGit).inspect(repo); expect(response).toMatchObject({ available: true, hidden: 1, panes: [] }); expect(JSON.stringify(response)).toContain("a.txt"); expect(JSON.stringify(response)).not.toContain(work); expect(JSON.stringify(response)).not.toContain(".env"); expect((response as any).diff).not.toContain("SECRET"); } finally { await rm(work, { recursive: true, force: true }); }
  });
});

describe("autocrlf passthrough", () => {
  test("only the three legal values become a -c flag", () => {
    expect(autocrlfArgs("true\n")).toEqual(["-c", "core.autocrlf=true"]); expect(autocrlfArgs("Input")).toEqual(["-c", "core.autocrlf=input"]); expect(autocrlfArgs("false")).toEqual(["-c", "core.autocrlf=false"]);
    expect(autocrlfArgs(undefined)).toEqual([]); expect(autocrlfArgs("")).toEqual([]); expect(autocrlfArgs("yes; rm -rf /")).toEqual([]);
  });
  test("an LF-committed file that git checked out with CRLF is clean only when autocrlf=true is passed through", async () => {
    const work = await mkdtemp(join(tmpdir(), "sightr-git-crlf-")); const repo = join(work, "repo"); await mkdir(repo);
    const git = (args: string[]) => spawnGit(args, repo);
    try {
      await git(["init", "-q"]); await writeFile(join(repo, "a.txt"), "one\ntwo\n"); await git(["add", "a.txt"]); await git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"]); await rm(join(repo, "a.txt")); await git(["-c", "core.autocrlf=true", "checkout", "--", "a.txt"]); expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("one\r\ntwo\r\n");
      const withCrlf = await createFolderGit(work, (args, cwd) => spawnGit(["-c", "core.autocrlf=true", ...args], cwd)).inspect(repo); expect(withCrlf).toMatchObject({ available: true, clean: true, diff: "" });
      const without = await createFolderGit(work, (args, cwd) => spawnGit(["-c", "core.autocrlf=false", ...args], cwd)).inspect(repo); expect(without).toMatchObject({ available: true, clean: false });
    } finally { await rm(work, { recursive: true, force: true }); }
  });
});
