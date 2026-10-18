import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Run, ThreadEvent, TurnItem } from "../../shared/v2/contracts.ts";
import { ageTree, fingerprint, fixtureEnv, gitDirChanges, gitIn, makeRepo, rmrf, tempRoot, writeFiles } from "../test/git-fixtures.ts";
import { createProject, createThread, project, thread } from "../test/thread-fixtures.ts";
import { spawnGit, type GitRunner } from "../workdir-git.ts";
import { checkpointRef, createCheckpointGit, type CheckpointGit, type CheckpointGitOptions } from "./checkpoint-git.ts";
import { APPROX_LAG_MS, CHECKPOINT_KEEP_RUNS, createCheckpointService, END_WINDOW_MS, MAX_STORE_PACKS, START_WINDOW_MS, type CheckpointServiceDeps } from "./checkpoints.ts";
import type { EventDraft } from "./events.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";

// Real git processes: under a loaded full run one test can pass bun's 5 s default.
setDefaultTimeout(60_000);
const roots: string[] = [];
const stores: ThreadStore[] = [];
afterAll(async () => { for (const s of stores) { try { s.close(); } catch { /* closed */ } } for (const r of roots) await rmrf(r); });
const LF_ONLY = async () => new Map([["core.autocrlf", "false"]]);
const DAY = 24 * 60 * 60 * 1000;

interface Rig {
  work: string; state: string; store: ThreadStore; svc: ReturnType<typeof createCheckpointService>; git: CheckpointGit;
  repo: Awaited<ReturnType<typeof makeRepo>>; clock: { t: number }; calls: string[][]; cwd: Map<string, string | null>;
  start(threadId?: string, ordinal?: number, over?: Partial<Run>): Promise<Run>;
  end(run: Run, at?: number, status?: "completed" | "failed" | "interrupted"): Promise<void>;
}

async function rig(opts: { enabled?: boolean; files?: Record<string, string>; git?: Partial<CheckpointGitOptions>; svc?: Partial<CheckpointServiceDeps>; threads?: Array<{ id: string; harness?: string }>; wrapGit?: (g: CheckpointGit) => CheckpointGit } = {}): Promise<Rig> {
  const work = await tempRoot("sightr-cps-"); roots.push(work);
  const state = join(work, "state");
  const clock = { t: 10 * DAY };
  const store = openThreadStore(":memory:", { now: () => clock.t, log: () => {} }); stores.push(store);
  const repo = await makeRepo(work, "repo", opts.files ?? { "a.txt": "one\n" });
  const calls: string[][] = [];
  const counting: GitRunner = (args, cwd, limits) => { calls.push(args); return spawnGit(args, cwd, limits); };
  const git = createCheckpointGit({ stateDir: state, workRoot: work, globalConfig: LF_ONLY, settleDelayMs: 5, now: () => clock.t, run: counting, ...opts.git });
  const cwd = new Map<string, string | null>();
  store.append([createProject(project("w1"))]);
  for (const t of opts.threads ?? [{ id: "t1" }]) {
    store.append([createThread(thread(t.id, { harness: t.harness ?? "claude", paneId: `p-${t.id}` }))]);
    cwd.set(`p-${t.id}`, repo.root);
  }
  const svc = createCheckpointService({ store, stateDir: state, workRoot: work, enabled: opts.enabled ?? true, git: opts.wrapGit ? opts.wrapGit(git) : git, now: () => clock.t, log: () => {}, paneCwd: (paneId) => cwd.get(paneId) ?? null, ...opts.svc });
  svc.start();
  const r: Rig = {
    work, state, store, svc, git, repo, clock, calls, cwd,
    async start(threadId = "t1", ordinal = 1, over = {}) {
      const run: Run = { id: `${threadId}-run-${ordinal}`, threadId, ordinal, status: "running", startedAt: clock.t, ...over };
      store.append([{ type: "run.started", threadId, payload: { run } }]);
      await svc.idle();
      return run;
    },
    async end(run, at = clock.t, status = "completed") {
      store.append([{ type: "run.ended", threadId: run.threadId, payload: { runId: run.id, status, completedAt: at } }]);
      await svc.idle();
    },
  };
  return r;
}
const captured = (store: ThreadStore) => store.eventsAfter(0, { types: ["checkpoint.captured"] }) as Array<Extract<ThreadEvent, { type: "checkpoint.captured" }>>;
const storeGit = async (r: Rig) => { const info = (await createCheckpointGit({ stateDir: r.state, globalConfig: LF_ONLY }).resolveRepo(r.repo.root))!; return { info, git: gitIn(info.store, { GIT_DIR: info.store }) }; };
const refs = async (r: Rig) => { const { info, git } = await storeGit(r); return existsSync(info.store) ? (await git("for-each-ref", "--format=%(refname)")).split("\n").filter(Boolean).sort() : []; };

describe("checkpoints: run flow", () => {
  test("run.started then run.ended: one start and one end ref, one captured per phase, one summary item, Run.checkpoint filled, nothing private on the wire", async () => {
    const r = await rig({ files: { "a.txt": "one\n", "b.txt": "b\n" } });
    await ageTree(join(r.repo.root, ".git")); const before = await fingerprint(join(r.repo.root, ".git"));
    const run = await r.start();
    expect(r.store.getCheckpoint(run.id)?.checkpoint.status).toBe("pending");
    await writeFiles(r.repo.root, { "a.txt": "one\ntwo\n", "made-by-sed.txt": "s\n" });
    // The journal named a.txt; the other file was made by a shell.
    r.store.append([{ type: "turn-item.updated", threadId: "t1", payload: { item: { id: "fc1", threadId: "t1", runId: run.id, status: "completed", title: null, startedAt: null, completedAt: null, createdAt: 1, updatedAt: 1, type: "file_change", fileName: join(r.repo.root, "a.txt") } } }]);
    r.clock.t += 1000;
    await r.end(run);
    expect(gitDirChanges(before, await fingerprint(join(r.repo.root, ".git")))).toEqual([]);
    expect(await refs(r)).toEqual([checkpointRef("t1", 1, "end"), checkpointRef("t1", 1, "start")]);
    const events = captured(r.store);
    expect(events.map((e) => e.payload.phase)).toEqual(["start", "end"]);
    const end = events[1]!.payload.checkpoint;
    expect(end).toMatchObject({ runId: run.id, threadId: "t1", appRunOrdinal: 1, status: "ready", live: true, additions: 2, deletions: 0 });
    expect(end.files).toEqual([
      { path: "a.txt", kind: "modified", additions: 1, deletions: 0, authored: true },
      { path: "made-by-sed.txt", kind: "added", additions: 1, deletions: 0, authored: false },
    ]);
    // The wire form names no root, no store, no sha; the stored form does.
    const wire = JSON.stringify(r.store.eventsAfter(0, { types: ["checkpoint.captured", "checkpoint.expired"] }));
    for (const secret of [r.repo.root, r.repo.root.replaceAll("\\", "\\\\"), r.state.replaceAll("\\", "\\\\"), r.store.getCheckpoint(run.id)!.startCommit!, r.store.getCheckpoint(run.id)!.endCommit!]) expect(wire).not.toContain(secret);
    const stored = r.store.storedEventsAfter(0, { types: ["checkpoint.captured"] });
    expect((stored[1]!.payload as { endCommit?: string }).endCommit).toMatch(/^[0-9a-f]{40}$/);
    // One summary item, and the thread snapshot carries Run.checkpoint.
    const snap = r.store.snapshotThread("t1")!;
    const items = snap.items.filter((i): i is Extract<TurnItem, { type: "checkpoint" }> => i.type === "checkpoint");
    expect(items.map((i) => i.id)).toEqual([`checkpoint:${run.id}`]);
    expect(items[0]!.checkpoint.files.length).toBe(2);
    expect(snap.runs.find((x) => x.id === run.id)?.checkpoint).toMatchObject({ status: "ready", live: true });
    expect(JSON.stringify(snap)).not.toContain(r.store.getCheckpoint(run.id)!.endCommit!);
    // Patches were stored with the end event.
    expect(r.store.checkpointPatch(run.id, "a.txt")?.patch).toContain("+two");
  });

  test("refused names: an untracked .env is skipped, an edited tracked dot-file is counted hidden; neither is listed, stored or served", async () => {
    const r = await rig({ files: { "a.txt": "a\n", ".github/ci.yml": "on: push\n" } });
    const run = await r.start();
    await writeFiles(r.repo.root, { ".env": "TOKEN=1\n", ".github/ci.yml": "on: pull_request\n", "a.txt": "a\nb\n" });
    await r.end(run);
    const c = r.store.getCheckpoint(run.id)!.checkpoint;
    expect(c).toMatchObject({ status: "ready", hidden: 1, skipped: 1 });
    expect(c.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(r.store.checkpointPatch(run.id, ".env")).toBeNull();
    expect(r.store.checkpointPatch(run.id, ".github/ci.yml")).toBeNull();
    expect(await r.svc.patch({ threadId: "t1", runId: run.id, file: ".github/ci.yml", w: true })).toEqual({ available: false, reason: "bad-file" });
    expect(JSON.stringify(r.store.storedEventsAfter(0))).not.toContain("TOKEN");
  });

  test("a missed start gives absent start-missed and no end ref; a late end gives end-missed; a slow start is approximate", async () => {
    const r = await rig();
    const late = await r.start("t1", 1, { startedAt: r.clock.t - START_WINDOW_MS - 1 });
    expect(r.store.getCheckpoint(late.id)?.checkpoint).toMatchObject({ status: "absent", reason: "start-missed" });
    await r.end(late);
    expect(r.store.getCheckpoint(late.id)?.checkpoint).toMatchObject({ status: "absent", reason: "start-missed" });
    expect(await refs(r)).toEqual([]);

    const slow = await r.start("t1", 2, { startedAt: r.clock.t - APPROX_LAG_MS - 1 });
    expect(r.store.getCheckpoint(slow.id)?.checkpoint).toMatchObject({ status: "pending", approximate: true });
    await r.end(slow, r.clock.t - END_WINDOW_MS - 1);
    expect(r.store.getCheckpoint(slow.id)?.checkpoint).toMatchObject({ status: "absent", reason: "end-missed" });
    expect(await refs(r)).toEqual([checkpointRef("t1", 2, "start")]);
  });

  test("re-delivery adds no row, no event and moves no ref", async () => {
    const r = await rig();
    const run = await r.start();
    await writeFile(join(r.repo.root, "a.txt"), "changed\n");
    await r.end(run);
    const refsBefore = await refs(r); const { git } = await storeGit(r);
    const shas = await git("for-each-ref", "--format=%(objectname)");
    const n = captured(r.store).length;
    r.svc.onEvents([{ sequence: 0, type: "run.started", threadId: "t1", payload: { run }, ts: 0 }, { sequence: 0, type: "run.ended", threadId: "t1", payload: { runId: run.id, status: "completed", completedAt: r.clock.t }, ts: 0 }]);
    await r.svc.idle();
    expect(captured(r.store).length).toBe(n);
    expect(await refs(r)).toEqual(refsBefore);
    expect(await git("for-each-ref", "--format=%(objectname)")).toBe(shas);
    // A duplicate event appended directly changes nothing either.
    const row = r.store.getCheckpoint(run.id);
    r.store.append([{ type: "checkpoint.captured", threadId: "t1", payload: { checkpoint: { ...row!.checkpoint, files: [], status: "absent", reason: "git-failed" }, phase: "end" } }]);
    expect(r.store.getCheckpoint(run.id)?.checkpoint.status).toBe("ready");
  });

  test("a shell thread gets nothing; a cwd outside the work root, a folder that is not a repo and a bare repo are no-repo", async () => {
    const r = await rig({ threads: [{ id: "sh", harness: "shell" }, { id: "t2" }, { id: "t3" }, { id: "t4" }] });
    await r.end(await r.start("sh"));
    expect(r.store.getCheckpoint("sh-run-1")).toBeNull();
    const outside = await tempRoot("sightr-cps-out-"); roots.push(outside);
    const outRepo = await makeRepo(outside, "repo");
    r.cwd.set("p-t2", outRepo.root);
    const plain = join(r.work, "plain"); await mkdir(plain);
    r.cwd.set("p-t3", plain);
    const bare = join(r.work, "bare.git"); await mkdir(bare); await gitIn(bare)("init", "-q", "--bare");
    r.cwd.set("p-t4", bare);
    for (const t of ["t2", "t3", "t4"]) {
      const run = await r.start(t);
      expect(r.store.getCheckpoint(run.id)?.checkpoint).toMatchObject({ status: "absent", reason: "no-repo" });
      await r.end(run);
      expect(r.store.getCheckpoint(run.id)?.checkpoint).toMatchObject({ status: "absent", reason: "no-repo" });
    }
    expect(existsSync(join(r.state, "checkpoints"))).toBe(false);
  });

  test("SIGHTR_CHECKPOINTS=0 and a project switched off each give disabled and write no ref", async () => {
    const off = await rig({ enabled: false });
    const run = await off.start(); await off.end(run);
    expect(off.store.getCheckpoint(run.id)?.checkpoint).toMatchObject({ status: "absent", reason: "disabled" });
    expect(existsSync(join(off.state, "checkpoints"))).toBe(false);
    expect(off.calls).toEqual([]);
    expect((await off.svc.sweep()).expired).toEqual([]);

    const proj = await rig();
    proj.store.append([{ type: "project.upserted", payload: { project: { ...proj.store.getProject("w1")!, checkpoints: false } } }]);
    // A herd upsert without the field keeps the switch.
    proj.store.append([createProject(project("w1", { label: "renamed by herd" }))]);
    expect(proj.store.getProject("w1")?.checkpoints).toBe(false);
    const r2 = await proj.start(); await proj.end(r2);
    expect(proj.store.getCheckpoint(r2.id)?.checkpoint).toMatchObject({ status: "absent", reason: "disabled" });
    expect(await refs(proj)).toEqual([]);
  });

  test("two threads in one repo whose runs overlap are both snapshotted and both flagged shared", async () => {
    const r = await rig({ threads: [{ id: "t1" }, { id: "t2" }] });
    const a = await r.start("t1");
    r.clock.t += 100;
    const b = await r.start("t2");
    await writeFile(join(r.repo.root, "a.txt"), "both\n");
    r.clock.t += 100;
    await r.end(a);
    r.clock.t += 100;
    await r.end(b);
    expect(r.store.getCheckpoint(a.id)?.checkpoint).toMatchObject({ status: "ready", shared: true });
    expect(r.store.getCheckpoint(b.id)?.checkpoint).toMatchObject({ status: "ready", shared: true });
    r.clock.t += 100;
    const c = await r.start("t1", 2); await r.end(c);
    expect(r.store.getCheckpoint(c.id)?.checkpoint.shared).toBeUndefined();
  });
});

describe("checkpoints: run-scope review", () => {
  test("w=0 is served from SQLite with no git call, for an archived thread too; w=1 and contents are live; refused and unknown names are refused", async () => {
    const r = await rig({ files: { "a.txt": "x = 1\n" } });
    const run = await r.start();
    await writeFiles(r.repo.root, { "a.txt": "x  =  1\ny\n" });
    await r.end(run);
    r.store.append([{ type: "thread.archived", threadId: "t1", payload: { reason: "pane-closed", at: r.clock.t } }]);
    r.cwd.delete("p-t1");
    const n = r.calls.length;
    await ageTree(join(r.repo.root, ".git")); const printed = await fingerprint(join(r.repo.root, ".git"));
    const stored = await r.svc.patch({ threadId: "t1", runId: run.id, file: "a.txt", w: false });
    expect(r.calls.length).toBe(n);
    expect(stored).toMatchObject({ available: true, truncated: false });
    expect(stored.available && stored.patch).toContain("+y");
    const ws = await r.svc.patch({ threadId: "t1", runId: run.id, file: "a.txt", w: true });
    expect(ws.available && ws.patch).toContain("+y");
    expect(ws.available && ws.patch).not.toContain("+x  =  1");
    expect(r.calls.length).toBeGreaterThan(n);
    const both = await r.svc.contents({ threadId: "t1", runId: run.id, file: "a.txt" });
    expect(both).toMatchObject({ available: true, old: { state: "text", text: "x = 1\n" }, new: { state: "text", text: "x  =  1\ny\n" } });
    expect(gitDirChanges(printed, await fingerprint(join(r.repo.root, ".git")))).toEqual([]);
    expect(await r.svc.patch({ threadId: "t1", runId: run.id, file: "other.txt", w: false })).toEqual({ available: false, reason: "bad-file" });
    expect(await r.svc.patch({ threadId: "t1", runId: run.id, file: ".env", w: false })).toEqual({ available: false, reason: "bad-file" });
    expect(await r.svc.patch({ threadId: "t2", runId: run.id, file: "a.txt", w: false })).toEqual({ available: false, reason: "no-checkpoint" });
    expect(await r.svc.patch({ threadId: "t1", runId: "nope", file: "a.txt", w: false })).toEqual({ available: false, reason: "no-checkpoint" });
  });

  test("history rewritten and pruned in the real repo: the run's own trees and blobs keep its files serving; the next sweep's gc trips on a blob only the user's repo held, expires the run (event, live false), and stored patches still serve", async () => {
    const r = await rig({ files: { "a.txt": "base\n", "keep.txt": "keep\n" } });
    await ageTree(r.repo.root); await r.repo.git("update-index", "--really-refresh"); // stat-clean: no file is hashed at the start
    const run = await r.start();
    await writeFile(join(r.repo.root, "a.txt"), "base\nagent\n");
    await r.end(run);
    expect(r.store.getCheckpoint(run.id)?.checkpoint.live).toBe(true);
    // The operator rewrites history and prunes: every object of the old history leaves the real repo.
    const g = r.repo.git;
    const root = await g("rev-list", "--max-parents=0", "HEAD");
    const keepBlob = await g("rev-parse", "HEAD:keep.txt");
    await g("checkout", "-q", "--orphan", "fresh");
    await g("rm", "-rqf", "--cached", ".");
    await rm(join(r.repo.root, "a.txt")); await rm(join(r.repo.root, "keep.txt"));
    await writeFile(join(r.repo.root, "z.txt"), "z\n"); await g("add", "z.txt"); await g("commit", "-qm", "fresh");
    await g("branch", "-D", "main"); await g("reflog", "expire", "--expire=now", "--all"); await g("gc", "-q", "--prune=now");
    expect(await g("cat-file", "-t", root).catch(() => "gone")).toBe("gone");
    // The snapshots hold their trees and both sides of a.txt (its index blob was copied before the rehash),
    // so the run's file still serves, on every git version.
    expect(await r.svc.contents({ threadId: "t1", runId: run.id, file: "a.txt" })).toMatchObject({ available: true, old: { state: "text", text: "base\n" }, new: { state: "text", text: "base\nagent\n" } });
    expect(await r.svc.patch({ threadId: "t1", runId: run.id, file: "a.txt", w: true })).toMatchObject({ available: true });
    expect(r.store.getCheckpoint(run.id)?.checkpoint.live).toBe(true);
    // keep.txt (unchanged by the run) was never copied: only gc reaches it. An orphan ref gives the sweep a gc.
    const { info, git: sg } = await storeGit(r);
    expect(await sg("cat-file", "-t", keepBlob).catch(() => "not in the store")).toBe("not in the store");
    await sg("update-ref", "refs/checkpoints/ghost/1/start", r.store.getCheckpoint(run.id)!.startCommit!);
    expect((await r.svc.sweep(r.clock.t)).expired).toEqual([run.id]);
    expect(await r.git.gc({ store: info.store, objectsDir: info.objectsDir })).toBe(true);
    expect(await r.svc.contents({ threadId: "t1", runId: run.id, file: "a.txt" })).toEqual({ available: false, reason: "expired" });
    expect(await r.svc.patch({ threadId: "t1", runId: run.id, file: "a.txt", w: true })).toEqual({ available: false, reason: "expired" });
    expect(r.store.getCheckpoint(run.id)?.checkpoint.live).toBe(false);
    expect(r.store.eventsAfter(0, { types: ["checkpoint.expired"] }).length).toBe(1);
    const stored = await r.svc.patch({ threadId: "t1", runId: run.id, file: "a.txt", w: false });
    expect(stored.available && stored.patch).toContain("+agent");
    expect(r.store.getCheckpoint(run.id)?.checkpoint.status).toBe("ready");
    const item = r.store.getTurnItem(`checkpoint:${run.id}`) as Extract<TurnItem, { type: "checkpoint" }>;
    expect(item.checkpoint.live).toBe(false);
  });

  test("a store that lost its own objects fails the liveness check: the live read answers expired, the run expires (event, live false), stored patches still serve", async () => {
    const r = await rig({ files: { "a.txt": "base\n" } });
    const run = await r.start();
    await writeFile(join(r.repo.root, "a.txt"), "base\nagent\n");
    await r.end(run);
    const { info } = await storeGit(r);
    await rm(join(info.store, "objects"), { recursive: true, force: true });
    await mkdir(join(info.store, "objects", "pack"), { recursive: true }); await mkdir(join(info.store, "objects", "info"), { recursive: true });
    expect(await r.svc.contents({ threadId: "t1", runId: run.id, file: "a.txt" })).toEqual({ available: false, reason: "expired" });
    expect(r.store.getCheckpoint(run.id)?.checkpoint.live).toBe(false);
    expect(r.store.eventsAfter(0, { types: ["checkpoint.expired"] }).length).toBe(1);
    expect(await r.svc.patch({ threadId: "t1", runId: run.id, file: "a.txt", w: true })).toEqual({ available: false, reason: "expired" });
    const stored = await r.svc.patch({ threadId: "t1", runId: run.id, file: "a.txt", w: false });
    expect(stored.available && stored.patch).toContain("+agent");
  });
});

describe("checkpoints: retention", () => {
  async function storeSize(dir: string): Promise<number> {
    let n = 0;
    const walk = async (d: string) => { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else n += (await stat(p)).size; } };
    await walk(dir); return n;
  }

  test(`the ${CHECKPOINT_KEEP_RUNS + 1}st run, a 15-day-old run, an archived thread, a deleted thread and an orphan ref each lose exactly their refs; gc shrinks the store; the user's .git is unchanged`, async () => {
    const r = await rig({ threads: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] });
    await ageTree(join(r.repo.root, ".git")); const before = await fingerprint(join(r.repo.root, ".git"));
    const big = (i: number) => Array.from({ length: 2000 }, (_, k) => `${i}-${k}-${Math.random()}`).join("\n");
    // t1: 51 runs; the first one is also 15 days old.
    const runs: Run[] = [];
    for (let i = 1; i <= CHECKPOINT_KEEP_RUNS + 1; i++) {
      const run = await r.start("t1", i);
      await writeFile(join(r.repo.root, "a.txt"), big(i));
      await r.end(run);
      runs.push(run); r.clock.t += 1000;
    }
    // t2: archived 2 days ago. t3: deleted.
    const a2 = await r.start("t2"); await writeFile(join(r.repo.root, "b.txt"), big(100)); await r.end(a2);
    const a3 = await r.start("t3"); await writeFile(join(r.repo.root, "c.txt"), big(200)); await r.end(a3);
    r.store.append([{ type: "thread.archived", threadId: "t2", payload: { reason: "user", at: r.clock.t } }]);
    r.store.append([{ type: "thread.archived", threadId: "t3", payload: { reason: "user", at: r.clock.t } }, { type: "thread.deleted", threadId: "t3", payload: { at: r.clock.t } }]);
    // An orphan ref nobody knows.
    const { info, git } = await storeGit(r);
    await git("update-ref", "refs/checkpoints/ghost/1/start", r.store.getCheckpoint(runs[5]!.id)!.startCommit!);
    const sizeBefore = await storeSize(info.store);
    r.clock.t += 2 * DAY;
    const res = await r.svc.sweep(r.clock.t);
    expect(res.expired.sort()).toEqual([runs[0]!.id, a2.id].sort());
    const left = await refs(r);
    expect(left).not.toContain(checkpointRef("t1", 1, "start"));
    expect(left).toContain(checkpointRef("t1", 2, "start"));
    expect(left).toContain(checkpointRef("t1", CHECKPOINT_KEEP_RUNS + 1, "end"));
    expect(left.some((x) => x.includes("/t2/") || x.includes("/t3/") || x.includes("ghost"))).toBe(false);
    expect(left.length).toBe(2 * CHECKPOINT_KEEP_RUNS);
    expect(r.store.getCheckpoint(runs[0]!.id)?.checkpoint).toMatchObject({ status: "ready", live: false });
    expect(r.store.getCheckpoint(runs[0]!.id)?.checkpoint.files.length).toBeGreaterThan(0);
    expect(r.store.eventsAfter(0, { types: ["checkpoint.expired"] }).map((e) => (e.payload as { runId: string }).runId).sort()).toEqual([runs[0]!.id, a2.id].sort());
    expect(await storeSize(info.store)).toBeLessThan(sizeBefore);
    expect(gitDirChanges(before, await fingerprint(join(r.repo.root, ".git")))).toEqual([]);
    // A second sweep finds nothing more.
    expect((await r.svc.sweep(r.clock.t)).expired).toEqual([]);
  }, 120_000);

  test("past the per-store byte cap the oldest runs go first; the global patch cap prunes patch rows oldest run first and keeps the file lists", async () => {
    const r = await rig({ svc: { maxStoreBytes: 1, maxPatchStoreBytes: 0 } });
    const a = await r.start("t1", 1); await writeFile(join(r.repo.root, "a.txt"), "first\n"); await r.end(a);
    r.clock.t += 1000;
    const b = await r.start("t1", 2); await writeFile(join(r.repo.root, "a.txt"), "second\n"); await r.end(b);
    expect(r.store.checkpointPatchBytes()).toBeGreaterThan(0);
    const res = await r.svc.sweep(r.clock.t);
    expect(res.expired[0]).toBe(a.id);
    expect(res.patchRunsPruned).toBe(2);
    expect(r.store.checkpointPatch(a.id, "a.txt")).toBeNull();
    expect(r.store.getCheckpoint(a.id)?.checkpoint.files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  test("a store past its cap only through objects no run reaches is collected first: no live run goes", async () => {
    const r = await rig({ svc: { maxStoreBytes: 1024 * 1024 } });
    const a = await r.start("t1", 1); await writeFile(join(r.repo.root, "a.txt"), "first\n"); await r.end(a);
    r.clock.t += 1000;
    const b = await r.start("t1", 2); await writeFile(join(r.repo.root, "a.txt"), "second\n"); await r.end(b);
    // 2 MiB of incompressible bytes no ref reaches (what a settle round's trees or an expired run's blobs leave).
    const { info, git: sg } = await storeGit(r);
    await writeFile(join(r.work, "garbage.bin"), randomBytes(2 * 1024 * 1024));
    await sg("hash-object", "-w", join(r.work, "garbage.bin"));
    expect(await r.git.storeBytes(info.store)).toBeGreaterThan(1024 * 1024);
    const res = await r.svc.sweep(r.clock.t);
    expect(res.expired).toEqual([]);
    expect(await r.git.storeBytes(info.store)).toBeLessThan(1024 * 1024);
    expect(await refs(r)).toEqual([checkpointRef("t1", 1, "end"), checkpointRef("t1", 1, "start"), checkpointRef("t1", 2, "end"), checkpointRef("t1", 2, "start")].sort());
  });

  test(`a store holding more than ${MAX_STORE_PACKS} packs is gc'd at the sweep with no ref gone, into one pack, and every run stays live`, async () => {
    const r = await rig();
    const run = await r.start(); await writeFile(join(r.repo.root, "a.txt"), "x\n"); await r.end(run);
    const { info, git: sg } = await storeGit(r);
    for (let i = 0; i <= MAX_STORE_PACKS; i++) {
      await writeFile(join(r.work, "p.txt"), `pack ${i}\n`);
      const oid = await sg("hash-object", "-w", join(r.work, "p.txt"));
      const p = Bun.spawn(["git", "pack-objects", "-q", join(info.store, "objects", "pack", "pack")], { cwd: info.store, env: fixtureEnv({ GIT_DIR: info.store }), stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      p.stdin.write(`${oid}\n`); await p.stdin.end(); await p.exited;
    }
    expect(await r.git.packCount(info.store)).toBeGreaterThan(MAX_STORE_PACKS);
    expect((await r.svc.sweep(r.clock.t)).expired).toEqual([]);
    expect(await r.git.packCount(info.store)).toBe(1);
    expect(r.store.getCheckpoint(run.id)?.checkpoint.live).toBe(true);
    expect(await r.svc.patch({ threadId: "t1", runId: run.id, file: "a.txt", w: true })).toMatchObject({ available: true });
  });

  test("an orphan store (its repo is gone) is removed and its runs expire", async () => {
    const r = await rig();
    const run = await r.start(); await writeFile(join(r.repo.root, "a.txt"), "x\n"); await r.end(run);
    const { info } = await storeGit(r);
    expect(existsSync(info.store)).toBe(true);
    await rmrf(r.repo.root);
    const res = await r.svc.sweep(r.clock.t);
    expect(res.storesRemoved).toBe(1);
    expect(existsSync(info.store)).toBe(false);
    expect(res.expired).toEqual([run.id]);
    expect(r.store.getCheckpoint(run.id)?.checkpoint.live).toBe(false);
  });
});

describe("checkpoints: store", () => {
  test("replaying every event from empty reaches the same run_checkpoints table; a deleted run takes its patch rows", async () => {
    const r = await rig();
    const run = await r.start(); await writeFile(join(r.repo.root, "a.txt"), "changed\n"); await r.end(run);
    const skipped = await r.start("t1", 2, { startedAt: r.clock.t - START_WINDOW_MS - 5 }); await r.end(skipped);
    r.store.append([{ type: "checkpoint.expired", threadId: "t1", payload: { runId: run.id } }]);
    const replay = openThreadStore(":memory:", { now: () => r.clock.t, log: () => {} }); stores.push(replay);
    for (const e of r.store.storedEventsAfter(0)) {
      const draft = { type: e.type, ...(e.threadId !== undefined ? { threadId: e.threadId } : {}), payload: e.payload } as EventDraft;
      replay.append([draft]);
    }
    const dump = (s: ThreadStore) => s.listCheckpoints().map((c) => ({ ...c }));
    expect(dump(replay)).toEqual(dump(r.store));
    // Patches are not event-sourced: a replay has none (the live path, else expired).
    expect(replay.checkpointPatch(run.id, "a.txt")).toBeNull();
    expect(r.store.checkpointPatch(run.id, "a.txt")).not.toBeNull();
    r.store.append([{ type: "thread.archived", threadId: "t1", payload: { reason: "user", at: r.clock.t } }, { type: "thread.deleted", threadId: "t1", payload: { at: r.clock.t } }]);
    expect(r.store.getCheckpoint(run.id)).toBeNull();
    expect(r.store.checkpointPatchBytes()).toBe(0);
  });
});

describe("checkpoints: failures are recorded, never lost (T30 review)", () => {
  test("a throw while starting records the start as failed; a throw while ending records the end as failed, so no row stays pending", async () => {
    let failStart = true, failEnd = false;
    const r = await rig({
      wrapGit: (g) => ({
        ...g,
        resolveRepo: async (root: string) => { if (failStart) throw new Error("boom: resolve"); return g.resolveRepo(root); },
        snapshotLocked: async (info, req) => { if (failEnd && req.side === "end") throw new Error("boom: end"); return g.snapshotLocked(info, req); },
      }),
    });
    const a = await r.start("t1", 1);
    expect(r.store.getCheckpoint(a.id)?.checkpoint).toMatchObject({ status: "absent", reason: "git-failed" });
    await r.end(a);
    expect(r.store.getCheckpoint(a.id)?.checkpoint).toMatchObject({ status: "absent", reason: "git-failed" });
    failStart = false; failEnd = true;
    const b = await r.start("t1", 2);
    expect(r.store.getCheckpoint(b.id)?.checkpoint.status).toBe("pending");
    await r.end(b);
    const row = r.store.getCheckpoint(b.id)!;
    expect(row.checkpoint).toMatchObject({ status: "absent", reason: "git-failed" });
    expect(row.endAt).not.toBeNull();
  });

  test("a start whose run never ends is given up after a day: the sweep expires it and drops its ref", async () => {
    const r = await rig();
    const run = await r.start();
    expect(await refs(r)).toEqual([checkpointRef("t1", 1, "start")]);
    r.clock.t += 2 * 60 * 60 * 1000;
    expect((await r.svc.sweep(r.clock.t)).expired).toEqual([]);
    r.clock.t += 25 * 60 * 60 * 1000;
    expect((await r.svc.sweep(r.clock.t)).expired).toEqual([run.id]);
    expect(await refs(r)).toEqual([]);
    expect(r.store.getCheckpoint(run.id)?.checkpoint).toMatchObject({ status: "pending", live: false });
  });

  test("a start given up after a day whose run.ended then arrives: the end is absent start-missed, with no end snapshot taken", async () => {
    const snaps: string[] = [];
    const r = await rig({ wrapGit: (g) => ({ ...g, snapshotLocked: async (info, req) => { snaps.push(req.side); return g.snapshotLocked(info, req); } }) });
    const run = await r.start();
    r.clock.t += 25 * 60 * 60 * 1000;
    expect((await r.svc.sweep(r.clock.t)).expired).toEqual([run.id]);
    await r.end(run, r.clock.t); // inside the end window
    expect(snaps).toEqual(["start"]);
    expect(await refs(r)).toEqual([]);
    expect(r.store.getCheckpoint(run.id)?.checkpoint).toMatchObject({ status: "absent", reason: "start-missed" });
  });

  test("the temp-index folder is emptied at start before any snapshot makes its temp index", async () => {
    const order: string[] = [];
    const r = await rig({
      wrapGit: (g) => ({
        ...g,
        cleanTmp: async () => { await Bun.sleep(150); await g.cleanTmp(); order.push("cleaned"); },
        snapshotLocked: async (info, req) => { order.push(`snapshot ${req.side}`); return g.snapshotLocked(info, req); },
      }),
    });
    const run = await r.start(); // svc.start() ran inside rig(): the clean is still sleeping when run.started lands
    await writeFile(join(r.repo.root, "a.txt"), "two\n");
    await r.end(run);
    expect(order).toEqual(["cleaned", "snapshot start", "snapshot end"]);
    expect(r.store.getCheckpoint(run.id)?.checkpoint.status).toBe("ready");
  });

  test("history rewritten and pruned under live snapshots: the sweep's gc fails, the broken runs expire, and gc then succeeds", async () => {
    const r = await rig({ files: { "a.txt": "base\n", "keep.txt": "keep\n" } });
    // Files and index an hour old and stat-clean (not "racy"): the snapshot then names keep.txt's blob in
    // the real repo instead of hashing it again (its trees are the store's own).
    await ageTree(r.repo.root); await r.repo.git("update-index", "--really-refresh");
    const one = await r.start("t1", 1); await writeFile(join(r.repo.root, "a.txt"), "base\nmore\n"); await r.end(one);
    // The operator rewrites history and prunes: keep.txt's blob, which run 1 reads through the alternate (the run did not change it), is gone.
    const g = r.repo.git;
    await g("add", "-A"); await g("commit", "-qm", "wip");
    await g("checkout", "-q", "--orphan", "fresh"); await g("rm", "-rqf", "--cached", ".");
    await rm(join(r.repo.root, "a.txt")); await rm(join(r.repo.root, "keep.txt"));
    await writeFile(join(r.repo.root, "z.txt"), "z\n"); await g("add", "z.txt"); await g("commit", "-qm", "fresh");
    await g("branch", "-D", "main"); await g("reflog", "expire", "--expire=now", "--all"); await g("gc", "-q", "--prune=now");
    r.clock.t += 1000;
    const two = await r.start("t1", 2); await writeFile(join(r.repo.root, "z.txt"), "z2\n"); await r.end(two);
    expect(r.store.getCheckpoint(two.id)?.checkpoint.status).toBe("ready");
    // An orphan ref gives the sweep something to collect.
    const { info, git } = await storeGit(r);
    await git("update-ref", "refs/checkpoints/ghost/1/start", r.store.getCheckpoint(two.id)!.startCommit!);
    expect(await r.git.gc({ store: info.store, objectsDir: info.objectsDir })).toBe(false); // keep.txt's blob is gone
    const res = await r.svc.sweep(r.clock.t);
    expect(res.expired).toEqual([one.id]);
    expect(await refs(r)).toEqual([checkpointRef("t1", 2, "end"), checkpointRef("t1", 2, "start")]);
    expect(await r.git.gc({ store: info.store, objectsDir: info.objectsDir })).toBe(true);
    expect(await r.svc.patch({ threadId: "t1", runId: two.id, file: "z.txt", w: true })).toMatchObject({ available: true });
  });

  test("a run-scope read waiting on a busy store answers busy at its deadline, not after the store's long task", async () => {
    const r = await rig({ svc: { reviewDeadlineMs: 150 } });
    const run = await r.start(); await writeFile(join(r.repo.root, "a.txt"), "x\n"); await r.end(run);
    const { info } = await storeGit(r);
    let release!: () => void;
    const holding = r.git.queue.run(info.repoKey, () => new Promise<void>((res) => { release = res; })); // a long gc
    const t0 = Date.now();
    expect(await r.svc.patch({ threadId: "t1", runId: run.id, file: "a.txt", w: true })).toEqual({ available: false, reason: "busy" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    // The stored patch (w=0) needs no store at all.
    expect(await r.svc.patch({ threadId: "t1", runId: run.id, file: "a.txt", w: false })).toMatchObject({ available: true });
    release(); await holding;
    expect(await r.svc.patch({ threadId: "t1", runId: run.id, file: "a.txt", w: true })).toMatchObject({ available: true });
  });
});
