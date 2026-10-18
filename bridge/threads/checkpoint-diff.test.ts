import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeRepo, rmrf, tempRoot, writeFiles } from "../test/git-fixtures.ts";
import { DIFF_CAP_BYTES } from "../workdir-git.ts";
import { authoredMatcher, blobSide, capturePatches, commitsAlive, cutAtLine, diffRun, filePatch, MAX_CHECKPOINT_FILES, type RunDiff } from "./checkpoint-diff.ts";
import { createCheckpointGit } from "./checkpoint-git.ts";

// Real git processes: under a loaded full run one test can pass bun's 5 s default.
setDefaultTimeout(60_000);
const roots: string[] = [];
afterAll(async () => { for (const r of roots) await rmrf(r); });
const LF_ONLY = async () => new Map([["core.autocrlf", "false"]]);

/** A repo, a start snapshot, then `edit()`, then an end snapshot; the diff between the two. */
async function runOf(files: Record<string, string | Uint8Array>, edit: (root: string, git: (...a: string[]) => Promise<string>) => Promise<void>, before?: (root: string) => Promise<void>) {
  const work = await tempRoot("sightr-cpd-"); roots.push(work);
  const repo = await makeRepo(work, "repo", files);
  await before?.(repo.root);
  const git = createCheckpointGit({ stateDir: join(work, "state"), globalConfig: LF_ONLY, settleDelayMs: 5 });
  const info = (await git.resolveRepo(repo.root))!;
  const start = await git.snapshot(info, { threadId: "t1", ordinal: 1, side: "start" });
  if (!start.ok) throw new Error(`start: ${start.reason}`);
  await edit(repo.root, repo.git);
  const end = await git.snapshot(info, { threadId: "t1", ordinal: 1, side: "end" });
  if (!end.ok) throw new Error(`end: ${end.reason}`);
  const run = git.storeRunner(info);
  return { repo, info, git, run, start: start.commit, end: end.commit };
}
const listed = (d: RunDiff | { error: string }) => { if ("error" in d) throw new Error(d.error); return d; };

describe("checkpoint diff: pure helpers", () => {
  test("cutAtLine keeps whole lines under the cap", () => {
    expect(cutAtLine("a\nb\n", 10)).toEqual({ text: "a\nb\n", truncated: false });
    expect(cutAtLine("aaaa\nbbbb\ncccc\n", 12)).toEqual({ text: "aaaa\nbbbb\n", truncated: true });
  });
  test("authoredMatcher takes absolute journal paths inside the root and relative ones as suffixes", () => {
    const root = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
    const abs = process.platform === "win32" ? "C:\\work\\repo\\src\\a.ts" : "/work/repo/src/a.ts";
    const outside = process.platform === "win32" ? "C:\\other\\b.ts" : "/other/b.ts";
    const m = authoredMatcher(root, [abs, "./lib/c.ts", outside, ""]);
    expect(m("src/a.ts")).toBe(true);
    expect(m("lib/c.ts")).toBe(true);
    expect(m("pkg/lib/c.ts")).toBe(true);
    expect(m("b.ts")).toBe(false);
    expect(m("src/other.ts")).toBe(false);
  });
});

describe("checkpoint diff: two trees", () => {
  test("a file dirty before the run and unchanged by it is not listed; the run's edits are", async () => {
    const r = await runOf({ "a.txt": "a\n", "b.txt": "b\n" }, async (root) => { await writeFile(join(root, "b.txt"), "b\nmore\n"); }, async (root) => { await writeFile(join(root, "a.txt"), "dirty before\n"); });
    const d = listed(await diffRun(r.run, r.start, r.end));
    expect(d.files).toEqual([{ path: "b.txt", kind: "modified", additions: 1, deletions: 0 }]);
    expect([d.additions, d.deletions, d.hidden, d.truncated]).toEqual([1, 0, 0, false]);
  });

  test("added, deleted, a rename (a delete plus an add) and a binary file (0/0)", async () => {
    const r = await runOf({ "old.txt": "x\ny\n", "gone.txt": "g\n", "img.bin": new Uint8Array([0, 1, 2, 3]) }, async (root) => {
      await rm(join(root, "old.txt")); await writeFile(join(root, "new.txt"), "x\ny\n");
      await rm(join(root, "gone.txt"));
      await writeFile(join(root, "img.bin"), new Uint8Array([0, 9, 9, 9, 9]));
      await writeFile(join(root, "fresh.ts"), "export {};\n");
    });
    const d = listed(await diffRun(r.run, r.start, r.end));
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(by["new.txt"]).toEqual({ path: "new.txt", kind: "added", additions: 2, deletions: 0 });
    expect(by["old.txt"]).toEqual({ path: "old.txt", kind: "deleted", additions: 0, deletions: 2 });
    expect(by["gone.txt"]?.kind).toBe("deleted");
    expect(by["fresh.ts"]?.kind).toBe("added");
    expect(by["img.bin"]).toEqual({ path: "img.bin", kind: "modified", additions: 0, deletions: 0, binary: true });
  });

  test("an edit reverted within the run lists nothing; a commit the agent makes mid-run changes nothing", async () => {
    const reverted = await runOf({ "a.txt": "a\n" }, async (root) => { await writeFile(join(root, "a.txt"), "temp\n"); await writeFile(join(root, "a.txt"), "a\n"); });
    expect(listed(await diffRun(reverted.run, reverted.start, reverted.end)).files).toEqual([]);
    const committed = await runOf({ "a.txt": "a\n" }, async (root, git) => { await writeFile(join(root, "a.txt"), "a\nb\n"); await git("commit", "-qam", "agent commit"); });
    const d = listed(await diffRun(committed.run, committed.start, committed.end));
    expect(d.files).toEqual([{ path: "a.txt", kind: "modified", additions: 1, deletions: 0 }]);
  });

  test("authored marks paths the journal named; skipped paths are dropped from the list", async () => {
    const r = await runOf({ "a.txt": "a\n" }, async (root) => { await writeFiles(root, { "a.txt": "a2\n", "shell.txt": "s\n", "locked.txt": "l\n" }); });
    const d = listed(await diffRun(r.run, r.start, r.end, { authored: authoredMatcher(r.repo.root, [join(r.repo.root, "a.txt")]), skippedPaths: new Set(["locked.txt"]) }));
    expect(d.files.map((f) => [f.path, f.authored])).toEqual([["a.txt", true], ["shell.txt", false]]);
  });

  test(`past ${MAX_CHECKPOINT_FILES} files the list is cut and flagged; the totals still sum every file`, async () => {
    const r = await runOf({ "a.txt": "a\n" }, async (root) => {
      const files: Record<string, string> = {};
      for (let i = 0; i < MAX_CHECKPOINT_FILES + 3; i++) files[`f/${String(i).padStart(4, "0")}.txt`] = "x\n";
      await writeFiles(root, files);
    });
    const d = listed(await diffRun(r.run, r.start, r.end));
    expect(d.files.length).toBe(MAX_CHECKPOINT_FILES);
    expect(d.truncated).toBe(true);
    expect(d.additions).toBe(MAX_CHECKPOINT_FILES + 3);
  });
});

describe("checkpoint diff: patches and blobs", () => {
  test("a stored patch per file; a big file's patch is cut at a whole line and flagged; a binary stores ''", async () => {
    const big = Array.from({ length: 9000 }, (_, i) => `line ${i} ${"y".repeat(30)}`).join("\n") + "\n";
    const r = await runOf({ "a.txt": "a\n", "img.bin": new Uint8Array([0, 1]) }, async (root) => { await writeFiles(root, { "a.txt": "a\nb\n", "big.txt": big, "img.bin": new Uint8Array([0, 2]) }); });
    const d = listed(await diffRun(r.run, r.start, r.end));
    const rows = await capturePatches(r.run, r.start, r.end, d.files);
    const by = Object.fromEntries(rows.map((p) => [p.path, p]));
    expect(by["a.txt"]?.patch).toContain("+b");
    expect(by["a.txt"]?.patch).toContain("diff --git a/a.txt b/a.txt");
    expect(by["a.txt"]?.truncated).toBe(false);
    expect(by["big.txt"]?.truncated).toBe(true);
    expect(by["big.txt"]!.bytes).toBeLessThanOrEqual(DIFF_CAP_BYTES);
    expect(by["big.txt"]!.patch!.endsWith("\n")).toBe(true);
    expect(by["img.bin"]).toEqual({ path: "img.bin", patch: "", binary: true, truncated: false, bytes: 0 });
  });

  test("past the per-run byte cap a file keeps no stored patch (null, truncated); live patches still compute", async () => {
    const r = await runOf({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" }, async (root) => { await writeFiles(root, { "a.txt": "a\n1\n", "b.txt": "b\n2\n", "c.txt": "c\n3\n" }); });
    const d = listed(await diffRun(r.run, r.start, r.end));
    const rows = await capturePatches(r.run, r.start, r.end, d.files, { maxRunBytes: 250 });
    expect(rows.filter((p) => p.patch === null).length).toBeGreaterThan(0);
    expect(rows.filter((p) => p.patch !== null).length).toBeGreaterThan(0);
    for (const p of rows.filter((x) => x.patch === null)) {
      expect(p.truncated).toBe(true);
      const live = await filePatch(r.run, r.start, r.end, p.path, false);
      expect("patch" in live && live.patch).toContain("diff --git");
    }
    // A zero budget leaves every file to the live path.
    expect((await capturePatches(r.run, r.start, r.end, d.files, { budgetMs: 0 })).every((p) => p.patch === null)).toBe(true);
  });

  test("-w hides a whitespace-only change; blob sides read both commits; liveness sees both commits", async () => {
    const r = await runOf({ "a.txt": "x = 1\n" }, async (root) => { await writeFiles(root, { "a.txt": "x  =  1\n", "n.txt": "n\n" }); });
    const plain = await filePatch(r.run, r.start, r.end, "a.txt", false);
    const ws = await filePatch(r.run, r.start, r.end, "a.txt", true);
    expect("patch" in plain && plain.patch).toContain("+x  =  1");
    expect("patch" in ws && ws.patch).toBe("");
    expect(await blobSide(r.run, r.start, "a.txt")).toEqual({ state: "text", text: "x = 1\n", crlf: false });
    expect(await blobSide(r.run, r.start, "n.txt")).toEqual({ state: "absent" });
    expect(await blobSide(r.run, r.end, "n.txt")).toEqual({ state: "text", text: "n\n", crlf: false });
    expect(await commitsAlive(r.run, [r.start, r.end])).toBe(true);
    expect(await commitsAlive(r.run, [r.start, "0".repeat(40)])).toBe(false);
  });
});
