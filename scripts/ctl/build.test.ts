import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, swapDist } from "./build.ts";
import { type Run } from "./types.ts";

const env = { SKIP_VERSION_CHECK: "1", SKIP_TYPECHECK: "1", PATH: "" };
type Call = { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> };
function failingBuild(calls: Call[] = []): Run {
  return async (cmd, args, opts) => { calls.push({ cmd, args, cwd: opts?.cwd, env: opts?.env }); return { code: args.includes("build") ? 2 : 0, stdout: "", stderr: "" }; };
}

test("build keeps frozen-lockfile installs first and ordered", async () => {
  const calls: Call[] = [];
  await expect(build(env, failingBuild(calls))).rejects.toThrow("error: command failed");
  const installs = calls.filter(x => x.args[0] === "install");
  expect(installs.slice(0, 2).map(x => x.args)).toEqual([["install", "--frozen-lockfile"], ["install", "--frozen-lockfile"]]);
  expect(installs[0]?.cwd).toBe(path.resolve(import.meta.dir, "../.."));
  expect(installs[1]?.cwd).toBe(path.join(path.resolve(import.meta.dir, "../.."), "web"));
});
test("SKIP flags omit gates and typecheck runs when enabled", async () => {
  const skipped: Call[] = [];
  await expect(build({ ...env, SKIP_TYPECHECK: "1" }, failingBuild(skipped))).rejects.toThrow();
  expect(skipped.some(x => x.args.includes("typecheck"))).toBe(false);
  const enabled: Call[] = [];
  await expect(build({ SKIP_VERSION_CHECK: "1" }, failingBuild(enabled))).rejects.toThrow();
  const types = enabled.filter(x => x.args[0] === "run" && x.args[1] === "typecheck");
  expect(types).toHaveLength(2);
  expect(types[0]?.cwd).toBe(path.resolve(import.meta.dir, "../.."));
  expect(types[1]?.cwd).toBe(path.join(path.resolve(import.meta.dir, "../.."), "web"));
  expect(enabled.some(isGate)).toBe(false);
});
const isGate = (x: Call) => x.args[0]?.endsWith("check-version.ts") === true;
test("version gate runs before installs when enabled", async () => {
  const calls: Call[] = [];
  await expect(build({ SKIP_TYPECHECK: "1", PATH: "" }, failingBuild(calls))).rejects.toThrow();
  const gate = calls.findIndex(isGate);
  const install = calls.findIndex(x => x.args[0] === "install");
  expect(calls.filter(isGate)).toHaveLength(1); expect(gate).toBeGreaterThanOrEqual(0); expect(gate).toBeLessThan(install);
});
test(".env is never passed to children", async () => {
  const d = await mkdtemp(path.join(tmpdir(), "sightr-")); await writeFile(path.join(d, ".env"), "SIGHTR_VAPID_PRIVATE=s3cret-key-12345");
  const seen: Call[] = [];
  await expect(build({ ...env, HERDR_PLUGIN_CONFIG_DIR: d }, failingBuild(seen))).rejects.toThrow();
  expect(JSON.stringify(seen)).not.toContain("s3cret-key-12345");
});
test("failed build leaves no dist-backup", async () => {
  const calls: Call[] = []; await expect(build(env, failingBuild(calls))).rejects.toThrow("error: command failed");
  await expect(access(path.join(path.resolve(import.meta.dir, "../.."), "web/dist-backup"))).rejects.toThrow();
});
test("swapDist replaces live dist and restores it on failure", async () => {
  const d = await mkdtemp(path.join(tmpdir(), "sightr-"));
  await mkdir(path.join(d, "dist")); await writeFile(path.join(d, "dist", "marker"), "old");
  await mkdir(path.join(d, "dist-staging")); await writeFile(path.join(d, "dist-staging", "marker"), "new");
  await swapDist(d); expect(await Bun.file(path.join(d, "dist/marker")).text()).toBe("new"); await expect(access(path.join(d, "dist-backup"))).rejects.toThrow();
  const d2 = await mkdtemp(path.join(tmpdir(), "sightr-")); await mkdir(path.join(d2, "dist")); await writeFile(path.join(d2, "dist/marker"), "old");
  await expect(swapDist(d2)).rejects.toThrow(); expect(await Bun.file(path.join(d2, "dist/marker")).text()).toBe("old");
});
test("swapDist supports a first build", async () => { const d = await mkdtemp(path.join(tmpdir(), "sightr-")); await mkdir(path.join(d, "dist-staging")); await swapDist(d); await access(path.join(d, "dist")); });
test("missing bun is reported before running commands", async () => { let calls = 0; await expect(build(env, async () => { calls++; return { code: 0, stdout: "", stderr: "" }; }, async () => "")).rejects.toMatchObject({ message: "error: bun not found on PATH", exitCode: 1 }); expect(calls).toBe(0); });
