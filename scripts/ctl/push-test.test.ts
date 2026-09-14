import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushTest } from "./push-test.ts";
test("push-test forwards arguments and the VAPID secret", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sightr-ctl-push-")); await writeFile(join(dir, ".env"), "SIGHTR_VAPID_PRIVATE=super-secret\n");
  let call: { args: string[]; env?: Record<string,string> } | undefined;
  const run = async (_cmd: string, args: string[], opts?: { env?: Record<string,string> }) => { call = { args, env: opts?.env }; return { code: 0, stdout: "", stderr: "" }; };
  await pushTest(["Title", "Body", "pane"], { HERDR_PLUGIN_CONFIG_DIR: dir }, run, async () => "C:/bun/bun.exe");
  expect(call?.args?.[0]).toBe("run"); expect(call?.args?.[1]?.replaceAll("\\", "/")).toContain("scripts/push-test.ts"); expect(call?.args?.slice(2)).toEqual(["Title", "Body", "pane"]);
  expect(call?.env?.SIGHTR_VAPID_PRIVATE).toBe("super-secret");
});
test("push-test refuses when Bun is unavailable", async () => {
  let spawned = false; const run = async () => { spawned = true; return { code: 0, stdout: "", stderr: "" }; };
  await expect(pushTest([], { HERDR_PLUGIN_CONFIG_DIR: ".tmp-no-push" }, run, async () => "")).rejects.toThrow("bun not found");
  expect(spawned).toBe(false);
});
