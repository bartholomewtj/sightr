import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, rm, symlink, unlink, utimes, writeFile, appendFile, realpath, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILE_PATCH_CAP_BYTES, REVIEW_MAX_GIT, REVIEW_QUEUE_MAX, REVIEW_SUBCOMMANDS, createFolderReview, createGate, cutPatchAtHunk, hasNul, headerNamesAllowed, keepWholeHunks,
  parseRawZ, parseNumstatZ, REVIEW_GIT_PREFIX, patchHeadersMatch, synthesizeAddedPatch, validBase,
} from "./workdir-review.ts";
import { KILL_GRACE_MS, collectBounded, spawnGit, type BoundedProc, type GitRun, type GitRunner } from "./workdir-git.ts";
import type { ReviewBranches, ReviewDiffFileContents, ReviewDiffFilePatch, ReviewDiffPreview } from "../shared/v2/review.ts";

const rootTemp = async (name: string) => realpath(await mkdtemp(join(tmpdir(), name)));
const ok = (stdout: string, extra: Partial<GitRun> = {}): GitRun => ({ code: 0, stdout, stderr: "", failed: false, timedOut: false, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const subOf = (args: string[]): string => args[args.indexOf("--no-optional-locks") + 1] ?? "";
const NO_FLAGS = ["--output=x", "HEAD", "a..b", "@{u}", "x.lock", "../x"];
const CAN_SYMLINK = await (async () => { const d = await rootTemp("sightr-review-sl-"); try { await writeFile(join(d, "t"), "x"); await symlink(join(d, "t"), join(d, "l")); return true; } catch { return false; } finally { await rm(d, { recursive: true, force: true }); } })();

/** A runner that forces `core.autocrlf` (the operator's own setting must not decide a test) and records every argv. */
const forced = (crlf: "true" | "false", rec?: string[][]): GitRunner => (args, cwd, limits) => { rec?.push(args); return spawnGit(["-c", `core.autocrlf=${crlf}`, ...args], cwd, limits); };
const reviewer = (work: string, crlf: "true" | "false" = "false", rec?: string[][]) => createFolderReview(work, forced(crlf, rec), { autocrlf: async () => ["-c", `core.autocrlf=${crlf}`] });
const gitIn = (cwd: string) => async (...args: string[]) => {
  const p = Bun.spawn(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
};
const asList = (r: unknown) => r as Extract<ReviewDiffPreview, { available: true }>;
const byPath = (r: Extract<ReviewDiffPreview, { available: true }>) => Object.fromEntries(r.files.map((f) => [f.path, f]));
const asPatch = (r: unknown) => r as Extract<ReviewDiffFilePatch, { available: true }>;
const asContents = (r: unknown) => r as Extract<ReviewDiffFileContents, { available: true }>;
const lines = (n: number, tag = "line") => Array.from({ length: n }, (_, i) => `${tag}-${i} ${"x".repeat(40)}`);
/** Every hunk header's counts match the body that follows: the patch still parses. */
function hunksAreWhole(patch: string): boolean {
  const rows = patch.split("\n"); if (rows.at(-1) === "") rows.pop();
  for (let i = 0; i < rows.length; i++) {
    const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(rows[i]!); if (!m) continue;
    let oldLeft = m[1] === undefined ? 1 : Number(m[1]), newLeft = m[2] === undefined ? 1 : Number(m[2]);
    while (oldLeft > 0 || newLeft > 0) {
      const row = rows[++i]; if (row === undefined) return false;
      if (row.startsWith("\\")) continue;
      if (row.startsWith(" ")) { oldLeft--; newLeft--; } else if (row.startsWith("-")) oldLeft--; else if (row.startsWith("+")) newLeft--; else return false;
    }
  }
  return true;
}

// ── pure helpers ──────────────────────────────────────────────────────────────────────────────────────

describe("review parsers and helpers", () => {
  test("parses numstat -z records, renames (empty path then old, new) and binary", () => {
    const out = "1\t2\tsrc/a b.ts\0-\t-\timg.png\0" + "3\t4\t\0old name.txt\0new name.txt\0";
    expect(parseNumstatZ(out)).toEqual([
      { path: "src/a b.ts", added: 1, removed: 2, binary: false },
      { path: "img.png", added: 0, removed: 0, binary: true },
      { path: "new name.txt", oldPath: "old name.txt", added: 3, removed: 4, binary: false },
    ]);
    expect(parseNumstatZ("")).toEqual([]);
  });
  test("parses diff --raw -z records: letters, blob ids and R100 renames", () => {
    const o = "1".repeat(40), n = "2".repeat(40), z = "0".repeat(40);
    expect(parseRawZ(`:100644 100644 ${o} ${n} M\0a.ts\0:000000 100644 ${z} ${n} A\0b.ts\0:100644 000000 ${o} ${z} D\0c.ts\0:100644 100644 ${o} ${n} R100\0old.ts\0new.ts\0:100644 120000 ${o} ${n} T\0d.ts\0`)).toEqual([
      { status: "M", path: "a.ts", oldMode: "100644", newMode: "100644", oldOid: o, newOid: n }, { status: "A", path: "b.ts", oldMode: "000000", newMode: "100644", oldOid: z, newOid: n }, { status: "D", path: "c.ts", oldMode: "100644", newMode: "000000", oldOid: o, newOid: z },
      { status: "R100", path: "new.ts", oldPath: "old.ts", oldMode: "100644", newMode: "100644", oldOid: o, newOid: n }, { status: "T", path: "d.ts", oldMode: "100644", newMode: "120000", oldOid: o, newOid: n },
    ]);
    expect(parseRawZ("garbage\0x\0")).toEqual([]);
  });
  test("validBase accepts short branch names and refuses anything git could read as more", () => {
    for (const ok2 of ["main", "origin/main", "release/1.2", "feat/ünï", "a+b@c", "x".repeat(200)]) expect(validBase(ok2)).toBe(true);
    for (const bad of [...NO_FLAGS, "", "-x", "--output=x", "a b", "a//b", "a/", "/a", "a@{1}", "x".repeat(201), "a^b", "a~1", "a:b", "a*", "main.lock", "x.lock/y", "head", "@", ".hidden", "config/x", "a\\b", "a\nb"]) expect(validBase(bad)).toBe(false);
  });
  test("cutPatchAtHunk keeps whole hunks, and gives \"\" for one hunk over the cap", () => {
    const hunk = (n: number) => `@@ -${n},1 +${n},1 @@\n-old${n}\n+new${n}\n`;
    const head = "diff --git a/f b/f\n--- a/f\n+++ b/f\n";
    const patch = head + hunk(1) + hunk(20) + hunk(40);
    expect(cutPatchAtHunk(patch)).toEqual({ patch, truncated: false });
    const cut = cutPatchAtHunk(patch, Buffer.byteLength(head + hunk(1) + hunk(20)) + 5);
    expect(cut).toEqual({ patch: head + hunk(1) + hunk(20), truncated: true });
    expect(hunksAreWhole(cut.patch)).toBe(true);
    expect(cutPatchAtHunk(patch, Buffer.byteLength(head) + 5)).toEqual({ patch: "", truncated: true });
    // The second file's header is not left dangling without a hunk.
    const two = head + hunk(1) + "diff --git a/g b/g\n--- a/g\n+++ b/g\n" + hunk(1);
    expect(keepWholeHunks(two.slice(0, two.indexOf("@@ -1,1", two.indexOf("a/g")) + 4))).toBe(head + hunk(1));
  });
  test("synthesizes git's added-file patch, with and without a final newline, and an empty file", () => {
    expect(synthesizeAddedPatch("a.txt", "one\ntwo\n")).toBe("diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n");
    expect(synthesizeAddedPatch("a.txt", "one")).toBe("diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+one\n\\ No newline at end of file\n");
    expect(synthesizeAddedPatch("a.txt", "")).toBe("diff --git a/a.txt b/a.txt\nnew file mode 100644\n");
    expect(synthesizeAddedPatch("café.txt", "x\n")).toContain("diff --git a/café.txt b/café.txt\n");
    expect(hunksAreWhole(synthesizeAddedPatch("a.txt", "a\nb\nc"))).toBe(true);
    expect(hasNul(new Uint8Array([65, 0, 66]))).toBe(true);
    expect(hasNul(new Uint8Array([...new Array(9000).fill(65), 0]))).toBe(false);
  });
  test("a patch header may name only the requested file and its old name, quoted or not", () => {
    expect(headerNamesAllowed("a/x.ts b/x.ts", [["x.ts", "x.ts"]])).toBe(true);
    expect(headerNamesAllowed('"a/caf\\303\\251.txt" "b/caf\\303\\251.txt"', [["café.txt", "café.txt"]])).toBe(true);
    expect(headerNamesAllowed("a/with space.txt b/with space.txt", [["with space.txt", "with space.txt"]])).toBe(true);
    expect(headerNamesAllowed("a/old.ts b/new.ts", [["old.ts", "new.ts"]])).toBe(true);
    expect(headerNamesAllowed("a/other.ts b/other.ts", [["x.ts", "x.ts"]])).toBe(false);
    expect(headerNamesAllowed("a/x.ts b/y.ts", [["x.ts", "x.ts"]])).toBe(false);
    expect(patchHeadersMatch("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n", "x.ts")).toBe(true);
    expect(patchHeadersMatch("diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/secret b/secret\n", "x.ts")).toBe(false);
    expect(patchHeadersMatch("diff --git a/old.ts b/old.ts\ndiff --git a/new.ts b/new.ts\n", "new.ts", "old.ts")).toBe(true);
  });
});

// ── argv: fake runner ─────────────────────────────────────────────────────────────────────────────────

describe("review argv", () => {
  const OID = "a".repeat(40), OID2 = "b".repeat(40);
  async function fakeRepo() {
    const work = await rootTemp("sightr-review-argv-"); const repo = join(work, "repo"); await mkdir(join(repo, ".git"), { recursive: true });
    const calls: string[][] = []; const limitsSeen: Array<import("./workdir-git.ts").GitLimits | undefined> = [];
    const fake: GitRunner = async (args, _cwd, limits) => {
      calls.push(args); limitsSeen.push(limits); const sub = subOf(args);
      if (sub === "rev-parse" && args.includes("--show-toplevel")) return ok(repo + "\n");
      if (sub === "rev-parse" && args.includes("--symbolic-full-name")) return ok(args.at(-1) + "\n");
      if (sub === "rev-parse") return ok(OID + "\n");
      if (sub === "merge-base") return ok(OID2 + "\n");
      if (sub === "status") return ok("# branch.head main\0# branch.oid " + OID + "\0");
      if (sub === "cat-file" && args.includes("-s")) return ok("3\n");
      if (sub === "cat-file") return ok("abc");
      return ok("");
    };
    return { work, repo, calls, limitsSeen, review: createFolderReview(work, fake, { autocrlf: async () => [] }) };
  }

  test("every call carries the hardened prefix and --no-optional-locks, and only an allowlisted subcommand", async () => {
    const { work, repo, calls, limitsSeen, review } = await fakeRepo();
    try {
      await review.list(repo, { scope: "working-tree", ignoreWhitespace: true });
      await review.list(repo, { scope: "branch", base: "release" });
      await review.list(repo, { scope: "branch" });
      await review.patch(repo, { scope: "working-tree", file: "src/a.ts", oldFile: "src/b.ts" });
      await review.patch(repo, { scope: "branch", file: "src/a.ts", from: OID, to: OID2 });
      await review.contents(repo, { scope: "working-tree", file: "src/a.ts" });
      await review.contents(repo, { scope: "branch", file: "a.ts", oldFile: "b.ts", from: OID, to: OID2 });
      await review.branches(repo);
      expect(calls.length).toBeGreaterThan(20);
      // Every call goes through the bounded read (so a killed process frees its slot), status included.
      expect(limitsSeen).toHaveLength(calls.length);
      limitsSeen.forEach((l, i) => { expect(l?.maxStdoutBytes, calls[i]!.join(" ")).toBeGreaterThan(0); expect(l?.maxStdoutBytes).toBeLessThanOrEqual(8 * 1024 * 1024); });
      expect(calls.filter((a) => subOf(a) === "status").length).toBeGreaterThan(0);
      for (const args of calls) {
        expect(args).toContain("--no-pager"); expect(args).toContain("color.ui=false"); expect(args).toContain("diff.external="); expect(args).toContain("core.fsmonitor=false");
        expect(args.some((a) => a.startsWith("core.hooksPath="))).toBe(true);
        expect(args.indexOf("--no-optional-locks")).toBe(13);   // the 11-item prefix, then -c diff.autoRefreshIndex=false
        expect(args.slice(11, 14)).toEqual(REVIEW_GIT_PREFIX);
        expect(REVIEW_SUBCOMMANDS).toContain(subOf(args));
        expect(args.filter((a) => a === "--no-optional-locks")).toHaveLength(1);
      }
      for (const forbidden of ["add", "checkout", "stash", "update-index", "gc", "fetch", "commit", "reset", "clean", "apply", "config", "remote", "log", "show"]) expect(calls.some((a) => subOf(a) === forbidden)).toBe(false);
      expect(REVIEW_SUBCOMMANDS).toEqual(["rev-parse", "merge-base", "for-each-ref", "diff", "ls-files", "cat-file", "status"]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  test("diff calls use -M, literal top-anchored pathspecs after --, and -w only when asked", async () => {
    const { work, repo, calls, review } = await fakeRepo();
    try {
      await review.list(repo, { scope: "working-tree" });
      const plainList = calls.filter((a) => subOf(a) === "diff"); expect(plainList.length).toBe(2);
      for (const a of plainList) { expect(a).toContain("-M"); expect(a).not.toContain("-w"); expect(a).not.toContain("--no-renames"); expect(a).toContain("-z"); expect(a.at(-1)).toBe("--"); expect(a.at(-2)).toBe("HEAD"); }
      expect(plainList.some((a) => a.includes("--numstat"))).toBe(true); expect(plainList.some((a) => a.includes("--raw"))).toBe(true);
      calls.length = 0;
      await review.list(repo, { scope: "working-tree", ignoreWhitespace: true });
      for (const a of calls.filter((x) => subOf(x) === "diff")) expect(a).toContain("-w");
      calls.length = 0;
      const nasty = "--output=x.txt";
      await review.patch(repo, { scope: "working-tree", file: nasty, oldFile: "old/--help", ignoreWhitespace: true });
      const diff = calls.find((a) => subOf(a) === "diff")!;
      for (const flag of ["-M", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all", "-U3", "-w", "--src-prefix=a/", "--dst-prefix=b/"]) expect(diff).toContain(flag);
      const dashes = diff.indexOf("--"); expect(dashes).toBeGreaterThan(0);
      expect(diff.slice(dashes + 1)).toEqual([`:(literal,top)${nasty}`, ":(literal,top)old/--help"]);
      for (const a of diff.slice(0, dashes)) expect(a.includes("output=x")).toBe(false);
      const lsFiles = calls.find((a) => subOf(a) === "ls-files")!; expect(lsFiles.slice(lsFiles.indexOf("--") + 1)).toEqual([`:(literal,top)${nasty}`]);
      calls.length = 0;
      await review.patch(repo, { scope: "branch", file: "a.ts", from: OID, to: OID2 });
      const branchDiff = calls.find((a) => subOf(a) === "diff")!; expect(branchDiff.slice(branchDiff.indexOf("-U3"), branchDiff.indexOf("--") + 1).slice(-3)).toEqual([OID, OID2, "--"]); expect(branchDiff).not.toContain("-w");
      calls.length = 0;
      await review.contents(repo, { scope: "working-tree", file: "dir/a.ts", oldFile: "dir/b.ts" });
      expect(calls.filter((a) => subOf(a) === "cat-file").map((a) => a.slice(a.indexOf("cat-file") + 1))).toEqual([["-s", "HEAD:dir/b.ts"], ["blob", "HEAD:dir/b.ts"]]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  test("base, from, to and file values git could read as options or revisions are refused before git runs", async () => {
    const { work, repo, calls, review } = await fakeRepo();
    try {
      for (const base of [...NO_FLAGS, "-x", "v1..v2", "main^", "a b", "x".repeat(300)]) expect(await review.list(repo, { scope: "branch", base })).toEqual({ available: false, reason: "bad-base" });
      for (const bad of [...NO_FLAGS, "abc1234", "A".repeat(40), OID + "0", ""]) {
        expect(await review.patch(repo, { scope: "branch", file: "a.ts", from: bad, to: OID })).toEqual({ available: false, reason: "bad-commit" });
        expect(await review.patch(repo, { scope: "branch", file: "a.ts", from: OID, to: bad })).toEqual({ available: false, reason: "bad-commit" });
        expect(await review.contents(repo, { scope: "branch", file: "a.ts", from: bad, to: OID })).toEqual({ available: false, reason: "bad-commit" });
      }
      for (const file of ["../x", "/abs", "a/../../b", ".env", "config/x.json", "a/node_modules/x", "", "a\\b", "C:/x", "a//b", "id_rsa"]) {
        expect(await review.patch(repo, { scope: "working-tree", file })).toEqual({ available: false, reason: "bad-file" });
        expect(await review.contents(repo, { scope: "working-tree", file })).toEqual({ available: false, reason: "bad-file" });
        expect(await review.patch(repo, { scope: "branch", file: "a.ts", oldFile: file, from: OID, to: OID })).toEqual({ available: false, reason: "bad-file" });
      }
      expect(calls).toEqual([]);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  test("a tag name or an unknown ref is a bad base, and git is asked only for refs/heads and refs/remotes", async () => {
    const work = await rootTemp("sightr-review-badbase-"); const repo = join(work, "repo"); await mkdir(join(repo, ".git"), { recursive: true });
    const calls: string[][] = [];
    const fake: GitRunner = async (args) => { calls.push(args); const sub = subOf(args); if (sub === "rev-parse" && args.includes("--show-toplevel")) return ok(repo); if (sub === "rev-parse" && args.includes("--symbolic-full-name")) return ok("", { code: 1 }); return ok("a".repeat(40)); };
    try {
      expect(await createFolderReview(work, fake).list(repo, { scope: "branch", base: "v1.0" })).toEqual({ available: false, reason: "bad-base" });
      const asked = calls.filter((a) => a.includes("--symbolic-full-name")).map((a) => a.at(-1));
      expect(asked).toEqual(["refs/heads/v1.0", "refs/remotes/v1.0"]);
      expect(calls.some((a) => subOf(a) === "merge-base" || subOf(a) === "diff")).toBe(false);
    } finally { await rm(work, { recursive: true, force: true }); }
  });
});

// ── concurrency, single flight, deadlines, 304 ────────────────────────────────────────────────────────

describe("review concurrency", () => {
  /** A fake runner over `n` fake repos (each a folder with .git). `hold` blocks every non-toplevel call until released. */
  async function farm(n: number, mode: { delayMs?: number; hold?: boolean } = {}) {
    const work = await rootTemp("sightr-review-farm-"); const repos: string[] = [];
    for (let i = 0; i < n; i++) { const r = join(work, `r${i}`); await mkdir(join(r, ".git"), { recursive: true }); repos.push(r); }
    const stats = { started: 0, running: 0, max: 0, perRepoMax: 0, calls: [] as string[][] }; const perRepo = new Map<string, number>(); const waiters: Array<() => void> = [];
    const fake: GitRunner = async (args, cwd) => {
      stats.calls.push(args); stats.started++; stats.running++; stats.max = Math.max(stats.max, stats.running);
      const n2 = (perRepo.get(cwd) ?? 0) + 1; perRepo.set(cwd, n2); stats.perRepoMax = Math.max(stats.perRepoMax, n2);
      try {
        if (mode.hold) await new Promise<void>((r) => waiters.push(r));
        if (mode.delayMs) await sleep(mode.delayMs);
        if (subOf(args) === "rev-parse" && args.includes("--show-toplevel")) return ok(cwd + "\n");
        return ok("", { code: 1 });   // no HEAD: the request ends with no-commits
      } finally { stats.running--; perRepo.set(cwd, perRepo.get(cwd)! - 1); }
    };
    return { work, repos, stats, fake, release: () => { while (waiters.length) waiters.shift()!(); } };
  }

  test("10 identical requests share one set of processes", async () => {
    const f = await farm(1, { delayMs: 15 });
    try {
      const review = createFolderReview(f.work, f.fake);
      const results = await Promise.all(Array.from({ length: 10 }, () => review.list(f.repos[0]!, { scope: "working-tree" })));
      expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1); expect(results[0]).toEqual({ available: false, reason: "no-commits" });
      const single = f.stats.started;
      const f2 = await farm(1, { delayMs: 15 }); try { await createFolderReview(f2.work, f2.fake).list(f2.repos[0]!, { scope: "working-tree" }); expect(single).toBe(f2.stats.started); } finally { await rm(f2.work, { recursive: true, force: true }); }
      // A request after the flight ended starts a new one.
      await review.list(f.repos[0]!, { scope: "working-tree" }); expect(f.stats.started).toBe(single * 2);
      // Different arguments do not share.
      await Promise.all([review.list(f.repos[0]!, { scope: "working-tree", ignoreWhitespace: true }), review.list(f.repos[0]!, { scope: "working-tree" })]); expect(f.stats.started).toBe(single * 4);
    } finally { await rm(f.work, { recursive: true, force: true }); }
  }, 30_000);

  test("8 distinct requests never run more than 4 git processes at once", async () => {
    const f = await farm(8, { delayMs: 25 });
    try {
      const review = createFolderReview(f.work, f.fake);
      await Promise.all(f.repos.map((r) => review.list(r, { scope: "working-tree" })));
      expect(f.stats.max).toBeLessThanOrEqual(REVIEW_MAX_GIT); expect(f.stats.max).toBe(REVIEW_MAX_GIT); expect(f.stats.started).toBe(16);
    } finally { await rm(f.work, { recursive: true, force: true }); }
  }, 30_000);

  test("one repo never runs more than 2 processes at once", async () => {
    const f = await farm(1, { delayMs: 25 });
    try {
      const review = createFolderReview(f.work, f.fake);
      await Promise.all(Array.from({ length: 8 }, (_, i) => review.patch(f.repos[0]!, { scope: "branch", file: `f${i}.txt`, from: "a".repeat(40), to: "b".repeat(40) })));
      expect(f.stats.perRepoMax).toBe(2); expect(f.stats.max).toBe(2);
    } finally { await rm(f.work, { recursive: true, force: true }); }
  }, 30_000);

  test("past the queue the next request is answered busy, and the rest finish once slots free", async () => {
    const f = await farm(REVIEW_MAX_GIT + REVIEW_QUEUE_MAX + 1, { hold: true });
    try {
      const review = createFolderReview(f.work, f.fake);
      const answers: unknown[] = []; const all = f.repos.map((r) => review.list(r, { scope: "working-tree" }).then((x) => { answers.push(x); return x; }));
      await sleep(150);
      expect(f.stats.running).toBe(REVIEW_MAX_GIT);
      expect(answers).toEqual([{ available: false, reason: "busy" }]);   // 4 running + 32 queued; the 37th is turned away at once
      for (let i = 0; i < 80; i++) { f.release(); await sleep(15); }
      const finished = await Promise.all(all);
      expect(finished.filter((r) => JSON.stringify(r) === JSON.stringify({ available: false, reason: "no-commits" }))).toHaveLength(REVIEW_MAX_GIT + REVIEW_QUEUE_MAX);
      expect(f.stats.max).toBeLessThanOrEqual(REVIEW_MAX_GIT);
    } finally { f.release(); await rm(f.work, { recursive: true, force: true }); }
  }, 30_000);

  test("a process that hangs answers timeout at the request deadline; one the runner killed answers timeout", async () => {
    const work = await rootTemp("sightr-review-hang-"); const repo = join(work, "repo"); await mkdir(join(repo, ".git"), { recursive: true });
    try {
      const hung: GitRunner = () => new Promise<GitRun>(() => {});
      const started = Date.now();
      expect(await createFolderReview(work, hung, { deadlineMs: 150 }).list(repo, { scope: "working-tree" })).toEqual({ available: false, reason: "timeout" });
      expect(Date.now() - started).toBeLessThan(2000);
      const killed: GitRunner = async () => ok("", { code: -1, timedOut: true });
      expect(await createFolderReview(work, killed).list(repo, { scope: "working-tree" })).toEqual({ available: false, reason: "timeout" });
      expect(await createFolderReview(work, killed).patch(repo, { scope: "working-tree", file: "a.txt" })).toEqual({ available: false, reason: "timeout" });
      const gone: GitRunner = async () => ok("", { code: -1, failed: true });
      expect(await createFolderReview(work, gone).branches(repo)).toEqual({ available: false, reason: "git-unavailable" });
      // A process waiting for a slot gives up at the deadline too.
      const gate = createGate(1, 1, 4); let release!: () => void;
      const first = gate.schedule("r", Date.now() + 5000, () => new Promise<string>((r) => { release = () => r("done"); }));
      expect(await gate.schedule("r", Date.now() + 60, async () => "never")).toBe("timeout");
      expect(gate.queued).toBe(0); release(); expect(await first).toBe("done"); expect(gate.running).toBe(0);
      expect(await gate.schedule("r", Date.now() - 1, async () => "late")).toBe("timeout");
    } finally { await rm(work, { recursive: true, force: true }); }
  }, 30_000);

  test("output past the byte cap stops the real process and says so", async () => {
    const dir = await rootTemp("sightr-review-overflow-");
    try {
      await writeFile(join(dir, "big.txt"), "x".repeat(300_000));
      const run = await spawnGit(["cat-file", "-p", "HEAD"], dir, { maxStdoutBytes: 10 });
      expect(run.code).not.toBe(0);   // not a repo: the bound is only a ceiling
      const p = await Bun.spawn(["git", "init", "-q"], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited; expect(p).toBe(0);
      const added = await gitIn(dir)("add", "big.txt"); void added;
      await gitIn(dir)("commit", "-qm", "x");
      const capped = await spawnGit(["cat-file", "blob", "HEAD:big.txt"], dir, { maxStdoutBytes: 1000 });
      expect(capped.overflow).toBe(true); expect(capped.stdout.length).toBe(1000);
      const whole = await spawnGit(["cat-file", "blob", "HEAD:big.txt"], dir, { maxStdoutBytes: 1_000_000 });
      expect(whole.overflow).toBeUndefined(); expect(whole.stdout.length).toBe(300_000);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);
});

// ── a real repository: the working tree ───────────────────────────────────────────────────────────────

describe("review, working tree (real git)", () => {
  let work = "", repo = "", git: ReturnType<typeof gitIn>, headOid = "";
  const calls: string[][] = [];
  const huge = lines(60_000, "huge");
  beforeAll(async () => {
    work = await rootTemp("sightr-review-wt-"); repo = join(work, "repo"); await mkdir(join(repo, "config"), { recursive: true }); git = gitIn(repo);
    await git("init", "-q", "-b", "main");
    const w = (name: string, text: string | Uint8Array) => writeFile(join(repo, name), text);
    await w("ren-old.txt", lines(12, "ren").join("\n") + "\n"); await w("keep.txt", "keep\n"); await w("deleted.txt", "bye\nbye\n"); await w("mv-old.txt", lines(8, "mv").join("\n") + "\n");
    await w("bin.dat", new Uint8Array([1, 2, 3, 0, 4])); await w("crlf-clean.txt", "one\ntwo\n"); await w("café.txt", "before\n"); await w("huge.txt", huge.join("\n") + "\n");
    await w(".env", "SECRET=1\n"); await w("config/x.json", "{}\n"); await w("ws.txt", "a\n  b\nc\n"); await w("mix.txt", "x\ny\n");
    await w("tabs.txt", "p\n"); await w("tracked-big.txt", "y\n");
    await git("add", "-A"); await git("commit", "-qm", "base"); headOid = await git("rev-parse", "HEAD");
    await git("mv", "ren-old.txt", "ren-new.txt"); await appendFile(join(repo, "ren-new.txt"), "tail\n");
    await w("bin.dat", new Uint8Array([1, 2, 3, 0, 5, 6])); await w("crlf-clean.txt", "one\r\ntwo\r\n"); await w("café.txt", "after\n");
    await unlink(join(repo, "deleted.txt")); await rename(join(repo, "mv-old.txt"), join(repo, "mv-new.txt"));
    const edited = huge.slice(); for (let i = 0; i < edited.length; i += 10) edited[i] = `CHANGED ${i} ${"y".repeat(35)}`; await w("huge.txt", edited.join("\n") + "\n");
    await w(".env", "SECRET=2\n"); await w("config/x.json", '{"a":1}\n'); await w("ws.txt", "a\n    b\nc\n"); await w("mix.txt", "x\n y\nz\n");
    await w("new.txt", "n1\nn2\nn3"); await w("new.bin", new Uint8Array([0, 1, 2])); await w("big-untracked.txt", "z".repeat(2 * 1024 * 1024));
    await w("new.crlf", "c1\r\nc2\r\n"); await w(".hidden-new", "x");
    if (CAN_SYMLINK) { await symlink(join(repo, "keep.txt"), join(repo, "link-tracked-new")); }
  }, 60_000);
  afterAll(async () => { await rm(work, { recursive: true, force: true }); });

  test("lists every change once: renames, binary, deleted, untracked; hidden paths are counted and never named", async () => {
    const review = reviewer(work, "false", calls);
    const list = asList(await review.list(repo, { scope: "working-tree" })); const f = byPath(list);
    expect(list).toMatchObject({ available: true, scope: "working-tree" });
    expect(f["ren-new.txt"]).toMatchObject({ kind: "renamed", oldPath: "ren-old.txt", added: 1, removed: 0 });
    expect(f["bin.dat"]).toMatchObject({ kind: "modified", binary: true, added: 0, removed: 0 });
    expect(f["deleted.txt"]).toMatchObject({ kind: "deleted", added: 0, removed: 2 });
    expect(f["café.txt"]).toMatchObject({ kind: "modified", added: 1, removed: 1 });
    expect(f["huge.txt"]).toMatchObject({ kind: "modified" });
    expect(f["mv-old.txt"]).toMatchObject({ kind: "deleted" }); expect(f["mv-new.txt"]).toMatchObject({ kind: "untracked", added: 8, removed: 0 });   // an unstaged mv is delete + untracked
    expect(f["new.txt"]).toMatchObject({ kind: "untracked", added: 3, removed: 0 });
    expect(f["new.bin"]).toMatchObject({ kind: "untracked", binary: true, added: 0 });
    expect(f["big-untracked.txt"]).toMatchObject({ kind: "untracked", tooLarge: true, added: 0, removed: 0 });
    expect(f["new.crlf"]).toMatchObject({ kind: "untracked", added: 2 });
    expect(f["keep.txt"]).toBeUndefined();
    if (CAN_SYMLINK) expect(f["link-tracked-new"]).toMatchObject({ kind: "untracked", binary: true, added: 0 });
    expect(list.hidden).toBe(3);   // .env, config/x.json, .hidden-new
    const text = JSON.stringify(list);
    for (const leak of [".env", "config", "SECRET", ".hidden-new", work, repo]) expect(text).not.toContain(leak);
    expect(list.files.every((x) => /^[0-9a-f]{16}$/.test(x.rev))).toBe(true); expect(list.diffHash).toMatch(/^[0-9a-f]{32}$/); expect(list.truncated).toBe(false);
    expect(list.files.map((x) => x.path).filter((p) => p.endsWith("/"))).toEqual([]);
  }, 60_000);

  test("every git call the review made was allowlisted, read-only and carried --no-optional-locks", () => {
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const args of calls) { expect(args.indexOf("--no-optional-locks")).toBe(13); expect(args.slice(11, 13)).toEqual(["-c", "diff.autoRefreshIndex=false"]); expect(REVIEW_SUBCOMMANDS).toContain(subOf(args)); }
  });

  test("autocrlf=true folds a CRLF checkout away; autocrlf=false shows it as a whole-file edit", async () => {
    expect(byPath(asList(await reviewer(work, "true").list(repo, { scope: "working-tree" })))["crlf-clean.txt"]).toBeUndefined();
    expect(byPath(asList(await reviewer(work, "false").list(repo, { scope: "working-tree" })))["crlf-clean.txt"]).toMatchObject({ kind: "modified", added: 2, removed: 2 });
  }, 60_000);

  test("ignoreWhitespace: git leaves a whitespace-only edit out of the list (so nothing is flagged), a mixed edit keeps only the real change", async () => {
    const review = reviewer(work);
    const plain = byPath(asList(await review.list(repo, { scope: "working-tree" }))); expect(plain["ws.txt"]).toMatchObject({ added: 1, removed: 1 }); expect(plain["mix.txt"]).toMatchObject({ added: 2, removed: 1 });
    const w = byPath(asList(await review.list(repo, { scope: "working-tree", ignoreWhitespace: true })));
    expect(w["ws.txt"]).toBeUndefined();   // verified at build: `git diff -w --numstat/--raw` drops it entirely
    expect(w["mix.txt"]).toMatchObject({ added: 1, removed: 0 }); expect(w["mix.txt"]).not.toHaveProperty("whitespaceOnly");
    expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "ws.txt", ignoreWhitespace: true })).patch).toBe("");
    const mixed = asPatch(await review.patch(repo, { scope: "working-tree", file: "mix.txt", ignoreWhitespace: true })).patch;
    expect(mixed).toContain("+z"); expect(mixed).not.toContain("+ y"); expect(mixed).not.toContain("-y");
    expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "ws.txt" })).patch).toContain("+    b");
  }, 60_000);

  test("a patch is one file, with the quoted header of a non-ASCII name accepted; a rename patch carries both names", async () => {
    const review = reviewer(work); const p = asPatch(await review.patch(repo, { scope: "working-tree", file: "café.txt" }));
    expect(p.patch).toContain('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"'); expect(p.patch).toContain("-before\n+after\n"); expect(p.truncated).toBe(false); expect(p.diffHash).toMatch(/^[0-9a-f]{32}$/);
    const r = asPatch(await review.patch(repo, { scope: "working-tree", file: "ren-new.txt", oldFile: "ren-old.txt" }));
    expect(r.patch).toContain("rename from ren-old.txt"); expect(r.patch).toContain("rename to ren-new.txt"); expect(r.patch).toContain("+tail");
    expect(p.patch + r.patch).not.toContain("SECRET");
    expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "keep.txt" })).patch).toBe("");   // unchanged
    expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "no-such.txt" })).patch).toBe("");
    expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "bin.dat" })).patch).toContain("Binary files");
    expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "deleted.txt" })).patch).toContain("deleted file mode");
  }, 60_000);

  test("hidden files are never diffed or read, whatever the scope", async () => {
    const review = reviewer(work);
    for (const file of [".env", "config/x.json", ".hidden-new"]) {
      expect(await review.patch(repo, { scope: "working-tree", file })).toEqual({ available: false, reason: "bad-file" });
      expect(await review.contents(repo, { scope: "working-tree", file })).toEqual({ available: false, reason: "bad-file" });
      expect(await review.patch(repo, { scope: "branch", file, from: headOid, to: headOid })).toEqual({ available: false, reason: "bad-file" });
    }
  }, 60_000);

  test("untracked files get a synthesized addition patch, binary and over-size ones do not", async () => {
    const review = reviewer(work);
    expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "new.txt" })).patch).toBe("diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,3 @@\n+n1\n+n2\n+n3\n\\ No newline at end of file\n");
    expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "new.bin" })).patch).toContain("Binary files /dev/null and b/new.bin differ");
    expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "big-untracked.txt" }))).toMatchObject({ patch: "", truncated: true });
    expect(asPatch(await reviewer(work, "true").patch(repo, { scope: "working-tree", file: "new.crlf" })).patch).toContain("+c1\n+c2\n");
    expect(asPatch(await reviewer(work, "false").patch(repo, { scope: "working-tree", file: "new.crlf" })).patch).toContain("+c1\r\n");
  }, 60_000);

  test("a 3 MB file edit is cut at a hunk boundary and still parses", async () => {
    const p = asPatch(await reviewer(work).patch(repo, { scope: "working-tree", file: "huge.txt" }));
    expect(p.truncated).toBe(true); expect(Buffer.byteLength(p.patch)).toBeLessThanOrEqual(FILE_PATCH_CAP_BYTES); expect(Buffer.byteLength(p.patch)).toBeGreaterThan(FILE_PATCH_CAP_BYTES / 2);
    expect(p.patch.endsWith("\n")).toBe(true); expect(hunksAreWhole(p.patch)).toBe(true); expect(p.patch.startsWith("diff --git a/huge.txt b/huge.txt\n")).toBe(true);
    expect((p.patch.match(/^@@ /gm) ?? []).length).toBeGreaterThan(1000);
  }, 60_000);

  test("diffHash is stable on an unchanged tree and changes when a line is swapped with equal counts", async () => {
    const review = reviewer(work);
    const a = asList(await review.list(repo, { scope: "working-tree" })), b = asList(await review.list(repo, { scope: "working-tree" }));
    expect(b.diffHash).toBe(a.diffHash); expect(b.files.map((x) => x.rev)).toEqual(a.files.map((x) => x.rev));
    const before = byPath(a)["café.txt"]!;
    await writeFile(join(repo, "café.txt"), "other\n");   // same size and counts as "after\n"
    const future = new Date(Date.now() + 5000); await utimes(join(repo, "café.txt"), future, future);
    const c = asList(await review.list(repo, { scope: "working-tree" })); const after = byPath(c)["café.txt"]!;
    expect(after).toMatchObject({ added: before.added, removed: before.removed }); expect(after.rev).not.toBe(before.rev); expect(c.diffHash).not.toBe(a.diffHash);
    expect(byPath(c)["ren-new.txt"]!.rev).toBe(byPath(a)["ren-new.txt"]!.rev);
    // An untracked file's rev follows its content.
    const n1 = byPath(c)["new.txt"]!.rev; await writeFile(join(repo, "new.txt"), "n1\nn2\nXX"); expect(byPath(asList(await review.list(repo, { scope: "working-tree" })))["new.txt"]!.rev).not.toBe(n1);
    await writeFile(join(repo, "café.txt"), "after\n"); await writeFile(join(repo, "new.txt"), "n1\nn2\nn3");
  }, 60_000);

  test("contents: old and new sides for modified, renamed, deleted, untracked, binary, too-large and crlf", async () => {
    const review = reviewer(work, "false");
    expect(asContents(await review.contents(repo, { scope: "working-tree", file: "café.txt" }))).toMatchObject({ old: { state: "text", text: "before\n", crlf: false }, new: { state: "text", text: "after\n", crlf: false } });
    const ren = asContents(await review.contents(repo, { scope: "working-tree", file: "ren-new.txt", oldFile: "ren-old.txt" }));
    expect(ren.old).toMatchObject({ state: "text" }); expect((ren.new as { text: string }).text.endsWith("tail\n")).toBe(true); expect((ren.old as { text: string }).text.startsWith("ren-0 ")).toBe(true);
    expect(asContents(await review.contents(repo, { scope: "working-tree", file: "deleted.txt" }))).toMatchObject({ old: { state: "text", text: "bye\nbye\n" }, new: { state: "absent" } });
    expect(asContents(await review.contents(repo, { scope: "working-tree", file: "new.txt" }))).toMatchObject({ old: { state: "absent" }, new: { state: "text", text: "n1\nn2\nn3" } });
    expect(asContents(await review.contents(repo, { scope: "working-tree", file: "bin.dat" }))).toMatchObject({ old: { state: "binary", bytes: 5 }, new: { state: "binary", bytes: 6 } });
    expect(asContents(await review.contents(repo, { scope: "working-tree", file: "new.bin" }))).toMatchObject({ old: { state: "absent" }, new: { state: "binary", bytes: 3 } });
    expect(asContents(await review.contents(repo, { scope: "working-tree", file: "big-untracked.txt" }))).toMatchObject({ old: { state: "absent" }, new: { state: "too-large", bytes: 2 * 1024 * 1024 } });
    expect(asContents(await review.contents(repo, { scope: "working-tree", file: "huge.txt" }))).toMatchObject({ old: { state: "too-large" }, new: { state: "too-large" } });
    expect(asContents(await review.contents(repo, { scope: "working-tree", file: "nothing.txt" }))).toMatchObject({ old: { state: "absent" }, new: { state: "absent" } });
    // Line endings: autocrlf=false returns the disk bytes (CRLF kept); autocrlf=true folds to match the patch.
    expect(asContents(await review.contents(repo, { scope: "working-tree", file: "crlf-clean.txt" }))).toMatchObject({ old: { state: "text", text: "one\ntwo\n", crlf: false }, new: { state: "text", text: "one\r\ntwo\r\n", crlf: true } });
    expect(asContents(await reviewer(work, "true").contents(repo, { scope: "working-tree", file: "crlf-clean.txt" }))).toMatchObject({ new: { state: "text", text: "one\ntwo\n", crlf: false } });
    const patchLines = asPatch(await reviewer(work, "false").patch(repo, { scope: "working-tree", file: "crlf-clean.txt" })).patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
    expect(patchLines).toEqual(["one\r", "two\r"]);   // the expansion text and the patch agree line for line
    const a = asContents(await review.contents(repo, { scope: "working-tree", file: "café.txt" })), b = asContents(await review.contents(repo, { scope: "working-tree", file: "café.txt" }));
    expect(a.diffHash).toBe(b.diffHash);
  }, 60_000);

  test("contents never follows a symlink out of the file's place", async () => {
    if (!CAN_SYMLINK) return;
    const outside = await rootTemp("sightr-review-outside-"); await writeFile(join(outside, "secret.txt"), "outside-secret");
    try {
      await symlink(join(outside, "secret.txt"), join(repo, "escape-link")); await symlink(outside, join(repo, "escape-dir"));
      const review = reviewer(work);
      const c = asContents(await review.contents(repo, { scope: "working-tree", file: "escape-link" })); expect(c.new).toEqual({ state: "absent" });
      expect(asContents(await review.contents(repo, { scope: "working-tree", file: "escape-dir/secret.txt" })).new).toEqual({ state: "absent" });
      const patch = asPatch(await review.patch(repo, { scope: "working-tree", file: "escape-link" })).patch; expect(patch).not.toContain("outside-secret");
      const list = asList(await review.list(repo, { scope: "working-tree" })); expect(JSON.stringify(list)).not.toContain("outside-secret");
      expect(byPath(list)["escape-link"]).toMatchObject({ kind: "untracked", binary: true });
    } finally { await rm(join(repo, "escape-link"), { force: true }); await rm(join(repo, "escape-dir"), { force: true }); await rm(outside, { recursive: true, force: true }); }
  }, 60_000);

  // A directory junction (no privilege needed on Windows) stands in for a symlinked folder that points out of the root.
  test("a folder link out of the repo is never listed, diffed or read", async () => {
    const outside = await rootTemp("sightr-review-junction-"); await writeFile(join(outside, "secret.txt"), "outside-secret\n");
    try {
      await symlink(outside, join(repo, "escape-dir"), "junction");
      const review = reviewer(work);
      const list = asList(await review.list(repo, { scope: "working-tree" }));
      expect(JSON.stringify(list)).not.toContain("secret.txt"); expect(list.files.some((f) => f.path.startsWith("escape-dir"))).toBe(false);
      expect(asContents(await review.contents(repo, { scope: "working-tree", file: "escape-dir/secret.txt" })).new).toEqual({ state: "absent" });
      expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "escape-dir/secret.txt" })).patch).not.toContain("outside-secret");
    } finally { await rm(join(repo, "escape-dir"), { recursive: true, force: true }).catch(() => {}); await rm(outside, { recursive: true, force: true }); }
  }, 60_000);

  test("a folder link that stays inside the repo but points at .git is not readable either", async () => {
    try {
      await symlink(join(repo, ".git"), join(repo, "dotgit-link"), "junction");
      const review = reviewer(work);
      expect(asContents(await review.contents(repo, { scope: "working-tree", file: "dotgit-link/HEAD" })).new).toEqual({ state: "absent" });
      expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "dotgit-link/HEAD" })).patch).toBe("");
      expect(JSON.stringify(asList(await review.list(repo, { scope: "working-tree" })))).not.toContain("dotgit-link");
    } finally { await rm(join(repo, "dotgit-link"), { recursive: true, force: true }).catch(() => {}); }
  }, 60_000);

  test("no reply holds the temp root or a git message", async () => {
    const review = reviewer(work); const all = JSON.stringify([await review.list(repo, { scope: "working-tree" }), await review.patch(repo, { scope: "working-tree", file: "café.txt" }), await review.contents(repo, { scope: "working-tree", file: "café.txt" }), await review.branches(repo)]);
    expect(all).not.toContain(work.replaceAll("\\", "\\\\")); expect(all).not.toContain(tmpdir().replaceAll("\\", "\\\\")); expect(all.toLowerCase()).not.toContain("fatal");
  }, 60_000);

  test("hooks, pager and external diff stay off: a hook that would write a file never runs", async () => {
    const marker = join(work, "hook-ran"); await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    for (const name of ["post-checkout", "post-index-change", "reference-transaction", "fsmonitor-watchman"]) await writeFile(join(repo, ".git", "hooks", name), `#!/bin/sh\necho x > "${marker.replaceAll("\\", "/")}"\n`);
    await reviewer(work).list(repo, { scope: "working-tree" });
    expect(await readFile(marker, "utf8").catch(() => "absent")).toBe("absent");
  }, 60_000);
});

describe("review, repo states (real git)", () => {
  test("a repo with no commits answers no-commits; a folder that is not a repo says so; outside the root is refused", async () => {
    const work = await rootTemp("sightr-review-states-"); const repo = join(work, "repo"); await mkdir(repo, { recursive: true }); await mkdir(join(work, "plain"));
    try {
      await gitIn(repo)("init", "-q", "-b", "main"); await writeFile(join(repo, "a.txt"), "a\n");
      const review = reviewer(work);
      expect(await review.list(repo, { scope: "working-tree" })).toEqual({ available: false, reason: "no-commits" });
      expect(await review.list(repo, { scope: "branch" })).toEqual({ available: false, reason: "no-commits" });
      expect(await review.patch(repo, { scope: "working-tree", file: "a.txt" })).toEqual({ available: false, reason: "no-commits" });
      expect(await review.branches(repo)).toEqual({ available: false, reason: "no-commits" });
      expect(await review.list(join(work, "plain"), { scope: "working-tree" })).toEqual({ available: false, reason: "not-a-repo" });
      expect(await review.list(join(tmpdir(), "elsewhere"), { scope: "working-tree" })).toEqual({ available: false, reason: "outside-root" });
      expect(await review.patch(join(work, "plain"), { scope: "working-tree", file: "a.txt" })).toEqual({ available: false, reason: "not-a-repo" });
    } finally { await rm(work, { recursive: true, force: true }); }
  }, 60_000);

  test("a list over 500 files is capped and says so", async () => {
    const work = await rootTemp("sightr-review-cap-"); const repo = join(work, "repo"); await mkdir(repo, { recursive: true });
    try {
      const git = gitIn(repo); await git("init", "-q", "-b", "main"); await writeFile(join(repo, "a.txt"), "a\n"); await git("add", "-A"); await git("commit", "-qm", "i");
      for (let i = 0; i < 520; i++) await writeFile(join(repo, `u${String(i).padStart(3, "0")}.txt`), "x\n");
      const list = asList(await reviewer(work).list(repo, { scope: "working-tree" }));
      expect(list.files).toHaveLength(500); expect(list.truncated).toBe(true);
    } finally { await rm(work, { recursive: true, force: true }); }
  }, 60_000);
});

// ── a real repository: branches ───────────────────────────────────────────────────────────────────────

describe("review, branch scope and the branch list (real git)", () => {
  let work = "", repo = "", git: ReturnType<typeof gitIn>; let c1 = "", r1 = "", w1 = "";
  beforeAll(async () => {
    work = await rootTemp("sightr-review-br-"); const up = join(work, "up.git"); repo = join(work, "repo"); git = gitIn(repo);
    await mkdir(up); await gitIn(up)("init", "-q", "--bare", "-b", "main"); await mkdir(repo);
    await git("init", "-q", "-b", "main"); await git("remote", "add", "origin", up);
    await writeFile(join(repo, "a.txt"), "one\n"); await writeFile(join(repo, "gone.txt"), "x\n"); await git("add", "-A"); await git("commit", "-qm", "c1"); c1 = await git("rev-parse", "HEAD");
    await git("push", "-q", "-u", "origin", "main"); await git("remote", "set-head", "origin", "main"); await git("tag", "v1");
    await git("checkout", "-q", "-b", "release"); await writeFile(join(repo, "r.txt"), "r\n"); await git("add", "-A"); await git("commit", "-qm", "r1"); r1 = await git("rev-parse", "HEAD");
    await git("checkout", "-q", "-b", "work"); await writeFile(join(repo, "a.txt"), "one\ntwo\n"); await writeFile(join(repo, ".env"), "SECRET=1\n"); await git("mv", "gone.txt", "moved.txt"); await writeFile(join(repo, "moved.txt"), "x\ny\n");
    await git("add", "-A"); await git("commit", "-qm", "w1"); w1 = await git("rev-parse", "HEAD");
    await writeFile(join(repo, "a.txt"), "one\ntwo\nUNCOMMITTED\n");
  }, 60_000);
  afterAll(async () => { await rm(work, { recursive: true, force: true }); });

  test("default base, picked local base and picked remote-tracking base give different (or equal) merge-bases", async () => {
    const review = reviewer(work);
    const def = asList(await review.list(repo, { scope: "branch" }));
    expect(def).toMatchObject({ available: true, scope: "branch", base: "origin/main", baseIsDefault: true, from: c1, to: w1, hidden: 1 });
    expect(def.files.map((f) => f.path).sort()).toEqual(["a.txt", "moved.txt", "r.txt"]);
    expect(byPath(def)["moved.txt"]).toMatchObject({ kind: "renamed", oldPath: "gone.txt" });
    const rel = asList(await review.list(repo, { scope: "branch", base: "release" }));
    expect(rel).toMatchObject({ base: "release", from: r1, to: w1 }); expect(rel).not.toHaveProperty("baseIsDefault"); expect(rel.from).not.toBe(def.from);
    expect(rel.files.map((f) => f.path).sort()).toEqual(["a.txt", "moved.txt"]);
    const remote = asList(await review.list(repo, { scope: "branch", base: "origin/main" })); expect(remote).toMatchObject({ base: "origin/main", from: c1 }); expect(remote).not.toHaveProperty("baseIsDefault");
    for (const text of [JSON.stringify(def), JSON.stringify(rel)]) { expect(text).not.toContain("SECRET"); expect(text).not.toContain(".env"); expect(text).not.toContain(work.replaceAll("\\", "\\\\")); }
    // Committed work only: the uncommitted edit is not in the branch patch.
    const p = asPatch(await review.patch(repo, { scope: "branch", file: "a.txt", from: def.from!, to: def.to! })); expect(p.patch).toContain("+two"); expect(p.patch).not.toContain("UNCOMMITTED");
    const r = asPatch(await review.patch(repo, { scope: "branch", file: "moved.txt", oldFile: "gone.txt", from: def.from!, to: def.to! })); expect(r.patch).toContain("rename from gone.txt");
    const wt = asPatch(await review.patch(repo, { scope: "working-tree", file: "a.txt" })); expect(wt.patch).toContain("+UNCOMMITTED");
  }, 60_000);

  test("a tag, an unknown name and a hidden-looking name as base are bad-base", async () => {
    const review = reviewer(work);
    for (const base of ["v1", "nope", "tags/v1", "config/x", "refs/heads/main"]) expect(await review.list(repo, { scope: "branch", base })).toEqual({ available: false, reason: "bad-base" });
  }, 60_000);

  test("branch contents read both sides from the two oids, not from the disk", async () => {
    const review = reviewer(work); const c = asContents(await review.contents(repo, { scope: "branch", file: "a.txt", from: c1, to: w1 }));
    expect(c).toMatchObject({ old: { state: "text", text: "one\n" }, new: { state: "text", text: "one\ntwo\n" } });
    expect(asContents(await review.contents(repo, { scope: "branch", file: "moved.txt", oldFile: "gone.txt", from: c1, to: w1 }))).toMatchObject({ old: { text: "x\n" }, new: { text: "x\ny\n" } });
    expect(asContents(await review.contents(repo, { scope: "branch", file: "gone.txt", from: c1, to: w1 }))).toMatchObject({ old: { state: "text", text: "x\n" }, new: { state: "absent" } });
    expect(asContents(await review.contents(repo, { scope: "branch", file: "r.txt", from: c1, to: r1 }))).toMatchObject({ old: { state: "absent" }, new: { state: "text", text: "r\n" } });
    expect(await review.patch(repo, { scope: "branch", file: "a.txt", from: "f".repeat(40), to: w1 })).toEqual({ available: false, reason: "bad-commit" });
  }, 60_000);

  test("the branch scope's hash is known before any diff runs: a matching If-None-Match runs no diff process", async () => {
    const rec: string[][] = []; const review = reviewer(work, "false", rec);
    const first = asList(await review.list(repo, { scope: "branch" })); expect(rec.some((a) => subOf(a) === "diff")).toBe(true);
    rec.length = 0;
    const again = await review.list(repo, { scope: "branch", ifNoneMatch: `"${first.diffHash}"` });
    expect(again).toEqual({ notModified: true, diffHash: first.diffHash }); expect(rec.some((a) => subOf(a) === "diff")).toBe(false);
    expect(rec.map(subOf).filter((s) => s !== "rev-parse" && s !== "merge-base" && s !== "status")).toEqual([]);
    const other = asList(await review.list(repo, { scope: "branch", ignoreWhitespace: true, ifNoneMatch: `"${first.diffHash}"` })); expect(other.available).toBe(true);
    expect(other.diffHash).not.toBe(first.diffHash);
    expect(asList(await review.list(repo, { scope: "branch" })).diffHash).toBe(first.diffHash);   // an uncommitted edit does not move it
    await writeFile(join(repo, "a.txt"), "one\ntwo\nCHANGED\n");
    expect(asList(await review.list(repo, { scope: "branch" })).diffHash).toBe(first.diffHash);
  }, 60_000);

  test("branches lists local and remote, hides origin/HEAD and hidden names, marks the current one", async () => {
    const out = (await reviewer(work).branches(repo)) as Extract<ReviewBranches, { available: true }>;
    expect(out).toMatchObject({ available: true, current: "work", defaultBase: "origin/main", truncated: false });
    expect(out).not.toHaveProperty("detached");
    expect(out.branches.map((b) => [b.name, b.remote, b.current ?? false]).sort()).toEqual([["main", false, false], ["origin/main", true, false], ["release", false, false], ["work", false, true]]);
    expect(out.branches.every((b) => b.time > 1_600_000_000)).toBe(true);
    expect(JSON.stringify(out)).not.toContain("HEAD");
    expect(out.branches[0]!.time).toBeGreaterThanOrEqual(out.branches.at(-1)!.time);   // newest first
  }, 60_000);

  test("a detached HEAD is reported; the list caps at 200 and marks truncated; hidden branch names are dropped", async () => {
    const dir = await rootTemp("sightr-review-many-"); const r2 = join(dir, "repo"); await mkdir(r2);
    try {
      const g = gitIn(r2); await g("init", "-q", "-b", "main"); await writeFile(join(r2, "a.txt"), "a\n"); await g("add", "-A"); await g("commit", "-qm", "i"); const oid = await g("rev-parse", "HEAD");
      const refs = Array.from({ length: 230 }, (_, i) => `${oid} refs/heads/b${String(i).padStart(3, "0")}`).concat([`${oid} refs/heads/config/secret`, `${oid} refs/heads/vendor/x`]);
      await appendFile(join(r2, ".git", "packed-refs"), refs.join("\n") + "\n");
      await g("checkout", "-q", "--detach");
      const out = (await reviewer(dir).branches(r2)) as Extract<ReviewBranches, { available: true }>;
      expect(out.branches).toHaveLength(200); expect(out.truncated).toBe(true); expect(out.detached).toBe(true); expect(out).not.toHaveProperty("current");
      expect(JSON.stringify(out)).not.toContain("config/secret"); expect(JSON.stringify(out)).not.toContain("vendor");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);

  test("a repo with no other branch to compare has no default base", async () => {
    const dir = await rootTemp("sightr-review-nobase-"); const r2 = join(dir, "repo"); await mkdir(r2);
    try {
      const g = gitIn(r2); await g("init", "-q", "-b", "main"); await writeFile(join(r2, "a.txt"), "a\n"); await g("add", "-A"); await g("commit", "-qm", "i");
      expect(await reviewer(dir).list(r2, { scope: "branch" })).toEqual({ available: false, reason: "no-base" });
      expect(await reviewer(dir).branches(r2)).toMatchObject({ available: true, current: "main" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
});

// ── review fixes: the index is never written, rev follows both sides, pipes held open, hidden renames, Windows aliases ─────

describe("review never writes the index", () => {
  test("a stale mtime on an unchanged tracked file does not make list, patch or contents rewrite .git/index or take index.lock", async () => {
    const work = await rootTemp("sightr-review-index-"); const repo = join(work, "repo"); await mkdir(repo);
    try {
      const git = gitIn(repo); await git("init", "-q", "-b", "main");
      await writeFile(join(repo, "stale.txt"), "same\n"); await writeFile(join(repo, "edited.txt"), "one\n"); await git("add", "-A"); await git("commit", "-qm", "i");
      await writeFile(join(repo, "edited.txt"), "one\ntwo\n");
      const old = new Date(Date.now() - 3 * 86_400_000);
      const makeStale = async () => { await utimes(join(repo, "stale.txt"), old, old); };
      await makeStale();
      const indexPath = join(repo, ".git", "index");
      const before = { bytes: await readFile(indexPath), mtimeMs: (await stat(indexPath)).mtimeMs };
      let sawLock = false, running = true;
      const watch = (async () => { while (running) { if (existsSync(join(repo, ".git", "index.lock"))) sawLock = true; await sleep(1); } })();
      const review = reviewer(work);
      try {
        const list = asList(await review.list(repo, { scope: "working-tree" }));
        expect(list.files.map((f) => f.path)).toEqual(["edited.txt"]);   // the stale-but-identical file is not a change
        expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "stale.txt" })).patch).toBe("");
        expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "edited.txt" })).patch).toContain("+two");
        expect(asContents(await review.contents(repo, { scope: "working-tree", file: "stale.txt" }))).toMatchObject({ old: { text: "same\n" }, new: { text: "same\n" } });
        await review.list(repo, { scope: "working-tree", ignoreWhitespace: true });
      } finally { running = false; await watch; }
      expect(sawLock).toBe(false);
      expect(await readFile(indexPath)).toEqual(before.bytes); expect((await stat(indexPath)).mtimeMs).toBe(before.mtimeMs);
      // Control: the same staleness, read by a plain `git diff` (no flag), does rewrite the index. Without this the check above could pass vacuously.
      await makeStale();
      await spawnGit(["diff", "--numstat", "HEAD"], repo);
      expect((await readFile(indexPath)).equals(before.bytes)).toBe(false);
    } finally { await rm(work, { recursive: true, force: true }); }
  }, 60_000);
});

describe("a stale mtime never makes a file look changed (text or binary)", () => {
  test("an untouched binary and an untouched text file with older mtimes are not listed; a really changed binary is; list and patch agree", async () => {
    const work = await rootTemp("sightr-review-stalebin-"); const repo = join(work, "repo"); await mkdir(repo);
    try {
      const g = gitIn(repo); await g("init", "-q", "-b", "main");
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
      await writeFile(join(repo, "logo.png"), png); await writeFile(join(repo, "real.bin"), new Uint8Array([9, 9, 0, 9])); await writeFile(join(repo, "t.txt"), "t\n"); await writeFile(join(repo, "edited.txt"), "e\n");
      await g("add", "-A"); await g("commit", "-qm", "i");
      await writeFile(join(repo, "real.bin"), new Uint8Array([9, 9, 0, 8, 7])); await writeFile(join(repo, "edited.txt"), "e\nf\n");
      const old = new Date(Date.now() - 86_400_000); for (const f of ["logo.png", "real.bin", "t.txt", "edited.txt"]) await utimes(join(repo, f), old, old);
      const review = reviewer(work); const indexBefore = (await stat(join(repo, ".git", "index"))).mtimeMs;
      const list = asList(await review.list(repo, { scope: "working-tree" }));
      expect(list.files.map((f) => f.path).sort()).toEqual(["edited.txt", "real.bin"]);
      expect(byPath(list)["real.bin"]).toMatchObject({ kind: "modified", binary: true });
      for (const f of ["logo.png", "t.txt"]) expect(asPatch(await review.patch(repo, { scope: "working-tree", file: f })).patch).toBe("");   // the patch agrees: nothing to show
      expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "real.bin" })).patch).toContain("Binary files");
      expect(asPatch(await review.patch(repo, { scope: "working-tree", file: "edited.txt" })).patch).toContain("+f");
      expect((await stat(join(repo, ".git", "index"))).mtimeMs).toBe(indexBefore);
      // Whitespace mode takes the same path.
      expect(asList(await review.list(repo, { scope: "working-tree", ignoreWhitespace: true })).files.map((f) => f.path).sort()).toEqual(["edited.txt", "real.bin"]);
    } finally { await rm(work, { recursive: true, force: true }); }
  }, 60_000);
});

describe("review rev follows both sides of a file", () => {
  test("branch: a one-line swap in a new commit with equal counts changes that file's rev, an untouched file keeps its rev", async () => {
    const work = await rootTemp("sightr-review-revbr-"); const repo = join(work, "repo"); await mkdir(repo);
    try {
      const g = gitIn(repo); await g("init", "-q", "-b", "main"); await writeFile(join(repo, "a.txt"), "one\ntwo\n"); await writeFile(join(repo, "b.txt"), "b\n"); await g("add", "-A"); await g("commit", "-qm", "c1");
      await g("checkout", "-q", "-b", "work"); await writeFile(join(repo, "a.txt"), "one\nTWO\n"); await writeFile(join(repo, "b.txt"), "b\nb2\n"); await g("add", "-A"); await g("commit", "-qm", "w1");
      const review = reviewer(work); const first = asList(await review.list(repo, { scope: "branch", base: "main" }));
      await writeFile(join(repo, "a.txt"), "one\nTHREE\n"); await g("add", "-A"); await g("commit", "-qm", "w2");
      const second = asList(await review.list(repo, { scope: "branch", base: "main" }));
      expect(byPath(second)["a.txt"]).toMatchObject({ added: byPath(first)["a.txt"]!.added, removed: byPath(first)["a.txt"]!.removed });   // same counts, same paths
      expect(byPath(second)["a.txt"]!.rev).not.toBe(byPath(first)["a.txt"]!.rev);
      expect(byPath(second)["b.txt"]!.rev).toBe(byPath(first)["b.txt"]!.rev);
      expect(second.to).not.toBe(first.to); expect(second.diffHash).not.toBe(first.diffHash);
      expect(asList(await review.list(repo, { scope: "branch", base: "main" })).files.map((f) => f.rev)).toEqual(second.files.map((f) => f.rev));
    } finally { await rm(work, { recursive: true, force: true }); }
  }, 60_000);

  test("working tree: moving HEAD under an unchanged disk file changes its rev; a file the new commit did not touch keeps it", async () => {
    const work = await rootTemp("sightr-review-revwt-"); const repo = join(work, "repo"); await mkdir(repo);
    try {
      const g = gitIn(repo); await g("init", "-q", "-b", "main"); await writeFile(join(repo, "f.txt"), "a\n"); await writeFile(join(repo, "g.txt"), "g\n"); await g("add", "-A"); await g("commit", "-qm", "c1");
      await writeFile(join(repo, "f.txt"), "b\n"); await writeFile(join(repo, "g.txt"), "g\ng2\n");
      const when = new Date(Date.now() - 60_000); await utimes(join(repo, "f.txt"), when, when); await utimes(join(repo, "g.txt"), when, when);
      const review = reviewer(work); const first = asList(await review.list(repo, { scope: "working-tree" }));
      const fStat = await stat(join(repo, "f.txt"));
      // A new commit changes f.txt's HEAD blob; the disk file is put back byte for byte with the same size and mtime.
      await writeFile(join(repo, "f.txt"), "c\n"); await g("add", "f.txt"); await g("commit", "-qm", "c2");
      await writeFile(join(repo, "f.txt"), "b\n"); await utimes(join(repo, "f.txt"), fStat.atime, fStat.mtime);
      expect((await stat(join(repo, "f.txt"))).mtimeMs).toBe(fStat.mtimeMs); expect((await stat(join(repo, "f.txt"))).size).toBe(fStat.size);
      const second = asList(await review.list(repo, { scope: "working-tree" }));
      expect(byPath(second)["f.txt"]).toMatchObject({ added: 1, removed: 1 }); expect(byPath(first)["f.txt"]).toMatchObject({ added: 1, removed: 1 });
      expect(byPath(second)["f.txt"]!.rev).not.toBe(byPath(first)["f.txt"]!.rev);
      expect(byPath(second)["g.txt"]!.rev).toBe(byPath(first)["g.txt"]!.rev);
      expect(asList(await review.list(repo, { scope: "working-tree" })).files.map((f) => f.rev)).toEqual(second.files.map((f) => f.rev));
    } finally { await rm(work, { recursive: true, force: true }); }
  }, 60_000);
});

describe("a killed process does not hold its slot", () => {
  /** A process whose pipes a grandchild keeps open: stdout and/or stderr never close, and it dies when killed. */
  function stub(opts: { stdout?: string; hangStdout?: boolean; hangStderr?: boolean; exitsAfterMs?: number }): BoundedProc & { killed: () => boolean } {
    const open = (text = "") => new ReadableStream<Uint8Array>({ start(c) { if (text) c.enqueue(new TextEncoder().encode(text)); } });
    const closed = (text: string) => new ReadableStream<Uint8Array>({ start(c) { if (text) c.enqueue(new TextEncoder().encode(text)); c.close(); } });
    let killed = false; let die!: (n: number) => void; const exited = new Promise<number>((r) => { die = r; });
    if (opts.exitsAfterMs !== undefined) setTimeout(() => die(0), opts.exitsAfterMs);
    return { stdout: opts.hangStdout ? open(opts.stdout) : closed(opts.stdout ?? ""), stderr: opts.hangStderr ? open() : closed(""), exited, kill: () => { killed = true; die(137); }, killed: () => killed };
  }

  test("after the timeout kill, the pipes get a short grace and are then cut", async () => {
    expect(KILL_GRACE_MS).toBeLessThanOrEqual(500);
    for (const hang of [{ hangStdout: true, hangStderr: true }, { hangStdout: true }, { hangStderr: true }]) {
      const proc = stub({ ...hang, stdout: "partial" }); const t0 = Date.now();
      const run = await collectBounded(proc, 1000, 40, 120);
      expect(run.timedOut).toBe(true); expect(proc.killed()).toBe(true);
      expect(Date.now() - t0).toBeLessThan(1500);   // nowhere near the 45 s a held pipe took
      if (!hang.hangStdout) expect(run.stdout).toBe("partial");
    }
  });
  test("a process that exits normally but whose stderr stays open is also cut, and keeps what it printed", async () => {
    const proc = stub({ stdout: "done\n", hangStderr: true, exitsAfterMs: 5 }); const t0 = Date.now();
    const run = await collectBounded(proc, 1000, 5000, 100);
    expect(run).toMatchObject({ code: 0, stdout: "done\n", timedOut: false }); expect(Date.now() - t0).toBeLessThan(1500);
    expect(run.overflow).toBeUndefined();   // a cut stderr alone costs nothing: stdout was complete
  });
  test("a clean exit whose stdout is still open when the grace runs out is flagged as cut, never complete", async () => {
    const proc = stub({ stdout: "half a rec", hangStdout: true, exitsAfterMs: 5 }); const t0 = Date.now();
    const run = await collectBounded(proc, 1000, 5000, 100);
    expect(run).toMatchObject({ code: 0, stdout: "half a rec", timedOut: false, overflow: true }); expect(Date.now() - t0).toBeLessThan(1500);
    expect((await collectBounded(stub({ stdout: "whole\n", exitsAfterMs: 5 }), 1000, 5000, 100)).overflow).toBeUndefined();
  });
  test("stdout past the cap kills the process and the slot is still freed when stderr hangs", async () => {
    const proc = stub({ stdout: "x".repeat(500), hangStderr: true }); const t0 = Date.now();
    const run = await collectBounded(proc, 100, 5000, 100);
    expect(run.overflow).toBe(true); expect(run.stdout).toHaveLength(100); expect(proc.killed()).toBe(true); expect(Date.now() - t0).toBeLessThan(1500);
  });
  test("the request answers timeout and the gate slot is released within the grace period", async () => {
    const work = await rootTemp("sightr-review-grace-"); const repo = join(work, "repo"); await mkdir(join(repo, ".git"), { recursive: true });
    try {
      const runner: GitRunner = async (_args, _cwd, limits) => collectBounded(stub({ hangStdout: true, hangStderr: true }), limits?.maxStdoutBytes ?? 1000, 30, 80);
      const review = createFolderReview(work, runner); const t0 = Date.now();
      expect(await review.list(repo, { scope: "working-tree" })).toEqual({ available: false, reason: "timeout" });
      expect(Date.now() - t0).toBeLessThan(1500); expect(review.gate.running).toBe(0);
      expect(await review.patch(repo, { scope: "working-tree", file: "a.txt" })).toEqual({ available: false, reason: "timeout" }); expect(review.gate.running).toBe(0);
    } finally { await rm(work, { recursive: true, force: true }); }
  });

  /** Every call answers like a quick git, except the ones `hang` picks: those never close their pipes (a clean filter running under them). */
  async function hangOn(hang: (args: string[]) => boolean, partial?: (args: string[]) => string | undefined) {
    const work = await rootTemp("sightr-review-hang2-"); const repo = join(work, "repo"); await mkdir(join(repo, ".git"), { recursive: true });
    const oid = "a".repeat(40);
    const runner: GitRunner = async (args, _cwd, limits) => {
      const sub = subOf(args);
      if (hang(args)) return collectBounded(stub({ hangStdout: true, hangStderr: true }), limits?.maxStdoutBytes ?? 1000, 30, 80);
      const cut = partial?.(args); if (cut !== undefined) return collectBounded(stub({ stdout: cut, hangStdout: true, exitsAfterMs: 2 }), limits?.maxStdoutBytes ?? 1000, 1000, 60);
      if (sub === "rev-parse" && args.includes("--show-toplevel")) return ok(repo + "\n");
      if (sub === "rev-parse" && args.includes("--symbolic-full-name")) return ok(args.at(-1) + "\n");
      if (sub === "rev-parse" || sub === "merge-base") return ok(oid + "\n");
      if (sub === "status") return ok("# branch.head work\0# branch.oid " + oid + "\0");
      if (sub === "cat-file" && args.includes("-s")) return ok("3\n");
      if (sub === "cat-file") return ok("abc");
      return ok("");
    };
    return { work, repo, review: createFolderReview(work, runner, { autocrlf: async () => [] }) };
  }
  const answersTimeoutAndFreesSlot = async (h: Awaited<ReturnType<typeof hangOn>>, call: () => Promise<unknown>) => {
    const t0 = Date.now();
    try { expect(await call()).toEqual({ available: false, reason: "timeout" }); expect(Date.now() - t0).toBeLessThan(1500); expect(h.review.gate.running).toBe(0); }
    finally { await rm(h.work, { recursive: true, force: true }); }
  };
  test("status that never closes (branches, and the default-base branch list) answers timeout and frees the slot", async () => {
    const h1 = await hangOn((a) => subOf(a) === "status"); await answersTimeoutAndFreesSlot(h1, () => h1.review.branches(h1.repo));
    const h2 = await hangOn((a) => subOf(a) === "status"); await answersTimeoutAndFreesSlot(h2, () => h2.review.list(h2.repo, { scope: "branch" }));
  });
  test("merge-base, cat-file -s and rev-parse that never close answer timeout and free the slot", async () => {
    const h1 = await hangOn((a) => subOf(a) === "merge-base"); await answersTimeoutAndFreesSlot(h1, () => h1.review.list(h1.repo, { scope: "branch", base: "release" }));
    const h2 = await hangOn((a) => subOf(a) === "cat-file" && a.includes("-s")); await answersTimeoutAndFreesSlot(h2, () => h2.review.contents(h2.repo, { scope: "working-tree", file: "a.txt" }));
    const h3 = await hangOn((a) => subOf(a) === "rev-parse" && a.includes("--symbolic-full-name")); await answersTimeoutAndFreesSlot(h3, () => h3.review.list(h3.repo, { scope: "branch", base: "release" }));
  });
  test("a clean exit with a cut stdout is a failure for a one-answer call but a truncated list for a list call", async () => {
    // rev-parse HEAD printed half an oid and kept its pipe open: never read as an answer.
    const h1 = await hangOn(() => false, (a) => subOf(a) === "rev-parse" && !a.includes("--show-toplevel") ? "aaaaaaaa" : undefined);
    await answersTimeoutAndFreesSlot(h1, () => h1.review.list(h1.repo, { scope: "working-tree" }));
    // numstat/raw/ls-files cut mid-record: the whole records before the cut are kept and the list says truncated.
    const o = "1".repeat(40), n = "2".repeat(40);
    const h2 = await hangOn(() => false, (a) => a.includes("--numstat") ? "1\t1\ta.txt\0" + "2\t2\tb.t" : a.includes("--raw") ? `:100644 100644 ${o} ${n} M\0a.txt\0:100644 100644 ${o} ${n} M\0b.t` : undefined);
    try {
      const list = asList(await h2.review.list(h2.repo, { scope: "branch", base: "release" }));
      expect(list.truncated).toBe(true); expect(list.files.map((f) => f.path)).toEqual(["a.txt"]);
      expect(h2.review.gate.running).toBe(0);
    } finally { await rm(h2.work, { recursive: true, force: true }); }
  });
});

describe("a rename with a hidden side is counted, never listed", () => {
  test("old side hidden (config/ -> moved.txt) and new side hidden (plain.txt -> .hid/plain.txt), in both scopes", async () => {
    const work = await rootTemp("sightr-review-hidrename-"); const repo = join(work, "repo"); await mkdir(join(repo, "config"), { recursive: true });
    try {
      const g = gitIn(repo); const body = (tag: string) => Array.from({ length: 14 }, (_, i) => `${tag} line ${i}`).join("\n") + "\n";
      await g("init", "-q", "-b", "main"); await writeFile(join(repo, "config", "old.txt"), body("old")); await writeFile(join(repo, "plain.txt"), body("plain")); await writeFile(join(repo, "keep.txt"), "k\n"); await g("add", "-A"); await g("commit", "-qm", "c1");
      await g("checkout", "-q", "-b", "work"); await g("mv", "config/old.txt", "moved.txt"); await mkdir(join(repo, ".hid")); await g("mv", "plain.txt", ".hid/plain.txt");
      const review = reviewer(work);
      const check = (list: Extract<ReviewDiffPreview, { available: true }>) => {
        expect(list.files).toEqual([]); expect(list.hidden).toBe(2);
        const text = JSON.stringify(list); for (const leak of ["moved.txt", "config", "old.txt", ".hid", "plain.txt"]) expect(text).not.toContain(leak);
      };
      check(asList(await review.list(repo, { scope: "working-tree" })));   // staged renames
      await g("commit", "-qm", "w1");
      check(asList(await review.list(repo, { scope: "branch", base: "main" })));
      // And their patches are not reachable by naming either side.
      expect(await review.patch(repo, { scope: "working-tree", file: "moved.txt", oldFile: "config/old.txt" })).toEqual({ available: false, reason: "bad-file" });
      expect(await review.patch(repo, { scope: "working-tree", file: ".hid/plain.txt", oldFile: "plain.txt" })).toEqual({ available: false, reason: "bad-file" });
    } finally { await rm(work, { recursive: true, force: true }); }
  }, 60_000);
});

describe("Windows name aliases do not get past the path check", () => {
  const win = process.platform === "win32";
  /** The 8.3 short name of `longName` inside `dir`, or null when the volume has none. */
  function shortNameOf(dir: string, longName: string): string | null {
    const out = Bun.spawnSync(["cmd", "/c", "dir", "/x", "/a", dir]).stdout.toString();
    for (const line of out.split(/\r?\n/)) { const m = /(\S+~\d+)\s+(\S.*?)\s*$/.exec(line); if (m && m[2] === longName) return m[1]!; }
    return null;
  }
  (win ? test : test.skip)("trailing dot, trailing space, NUL, CON and 8.3 aliases read nothing (and an alias of a hidden name is not read)", async () => {
    const work = await rootTemp("sightr-review-alias-"); const repo = join(work, "repo"); await mkdir(join(repo, ".hiddendir"), { recursive: true });
    try {
      const g = gitIn(repo); await g("init", "-q", "-b", "main");
      await writeFile(join(repo, "a.txt"), "alpha\n"); await writeFile(join(repo, ".env"), "ENV-SECRET\n"); await writeFile(join(repo, ".hiddendir", "s.txt"), "HIDDEN-SECRET\n");
      await g("add", "-A"); await g("commit", "-qm", "i");
      await writeFile(join(repo, "a.txt"), "beta\n"); await writeFile(join(repo, ".env"), "ENV-SECRET-2\n"); await writeFile(join(repo, ".hiddendir", "s.txt"), "HIDDEN-SECRET-2\n");
      const review = reviewer(work);
      // Sanity: the real name does read, so "absent" below is the alias being refused.
      expect(asContents(await review.contents(repo, { scope: "working-tree", file: "a.txt" })).new).toMatchObject({ state: "text", text: "beta\n" });
      const aliases = ["a.txt.", "a.txt ", "a.txt..", "NUL", "CON", "nul.txt"];
      const short = [shortNameOf(repo, ".env"), shortNameOf(repo, ".hiddendir")];
      if (short[0] === null || short[1] === null) console.warn("skipping the 8.3 short-name aliases: this volume has no short names for .env / .hiddendir (8.3 name creation is off)");
      if (short[0]) aliases.push(short[0]); if (short[1]) aliases.push(`${short[1]}/s.txt`);
      for (const file of aliases) {
        const c = await review.contents(repo, { scope: "working-tree", file });
        const p = await review.patch(repo, { scope: "working-tree", file });
        const text = JSON.stringify([c, p]);
        expect(text).not.toContain("beta"); expect(text).not.toContain("SECRET");
        if (c.available) { expect(c.new).toEqual({ state: "absent" }); expect(c.old).toEqual({ state: "absent" }); }
        if (p.available) expect(p.patch).toBe("");
      }
    } finally { await rm(work, { recursive: true, force: true }); }
  }, 60_000);
  if (!win) test("name aliases are Windows-only", () => { console.warn("skipping the Windows name-alias test: not Windows"); });
});


