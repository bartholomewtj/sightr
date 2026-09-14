import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";
import type { Run } from "../types.ts";
import { formatCommandArgument, taskSchedulerSupervisor } from "./taskscheduler.ts";
import type { Paths } from "../paths.ts";
import type { ServiceSpec } from "./index.ts";

const secret = "super-secret-signing-key";

async function dir() {
  const d = await mkdtemp(path.join(tmpdir(), "sightr-"));
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, ".env"), `SIGHTR_VAPID_PRIVATE=${secret}\n`);
  return d;
}
function spec(d: string, env: Record<string, string | undefined> = {}): ServiceSpec {
  const paths: Paths = { pluginRoot: d, configDir: d, envFile: path.join(d, ".env"), webDist: path.join(d, "dist"), buildInfo: path.join(d, "info") };
  return { paths, env: { SIGHTR_TASK_NAME: "herdr.sightr-test", ...env }, bun: path.join(d, "bun.exe"), port: "8787", socket: String.raw`\\.\pipe\sightr-test`, hosts: "" };
}

test("formats Windows command arguments safely", () => {
  expect(formatCommandArgument("C:/Program Files/bun.exe")).toBe('"C:/Program Files/bun.exe"');
});

test("install writes a hidden wscript task and a vbs with _exec-bridge, no secret", async () => {
  const d = await dir();
  const calls: string[] = [];
  const run: Run = async (_c, args) => { calls.push(args.join(" ")); return { code: 0, stdout: "", stderr: "" }; };
  await taskSchedulerSupervisor({ SIGHTR_TASK_NAME: "herdr.sightr-test" }).install(spec(d), run);
  const ps = calls.join("\n");
  expect(ps).toContain("wscript.exe");
  expect(ps).toContain("//nologo");
  expect(ps).toContain("exec-bridge.vbs");
  expect(ps).toContain("RestartCount 999");
  expect(ps).toContain("[TimeSpan]::Zero");
  expect(ps).toContain("AtLogOn");
  expect(ps).toContain("-RunLevel Limited");
  const vbs = await readFile(path.join(d, "exec-bridge.vbs"), "utf8");
  expect(vbs).toContain("_exec-bridge");
  expect(vbs).toContain("powershell.exe");
  expect(vbs).toContain("-WindowStyle Hidden");
  expect(vbs).toContain(d);
  expect(vbs).toContain(String.raw`\\.\pipe\sightr-test`);
  expect(vbs).toContain(", 0, True)");
  expect(vbs).not.toContain(" bun.exe run ");
  expect(vbs).not.toContain(secret);
});

test("run level default is Limited; highest requires admin", async () => {
  const d = await dir();
  const run: Run = async () => ({ code: 0, stdout: "", stderr: "" });
  const calls: string[] = [];
  const rec: Run = async (_c, args) => { calls.push(args.join(" ")); return { code: 0, stdout: "", stderr: "" }; };
  await taskSchedulerSupervisor({ SIGHTR_TASK_NAME: "t", SIGHTR_TASK_RUN_LEVEL: "highest" }, () => true).install(spec(d, { SIGHTR_TASK_RUN_LEVEL: "highest" }), rec);
  expect(calls.join("\n")).toContain("-RunLevel Highest");
  await expect(taskSchedulerSupervisor({ SIGHTR_TASK_RUN_LEVEL: "highest" }, () => false).install(spec(d, { SIGHTR_TASK_RUN_LEVEL: "highest" }), run)).rejects.toThrow(/requires Administrator/);
  await expect(taskSchedulerSupervisor({ SIGHTR_TASK_RUN_LEVEL: "nope" }).install(spec(d, { SIGHTR_TASK_RUN_LEVEL: "nope" }), run)).rejects.toThrow(/limited' or 'highest/);
});

test("stop disables the task before killing, then stops it; uninstall unregisters and deletes the vbs", async () => {
  const d = await dir();
  const order: string[] = [];
  const run: Run = async (_c, args) => {
    const joined = args.join(" ");
    if (joined.includes("Disable-ScheduledTask")) order.push("disable");
    else if (joined.includes("Stop-ScheduledTask")) order.push("stop");
    else if (joined.includes("Unregister-ScheduledTask")) order.push("unregister");
    else if (joined.includes("Get-CimInstance") || joined.includes("Get-NetTCPConnection")) order.push("proc");
    return { code: 0, stdout: "[]", stderr: "" };
  };
  const sup = taskSchedulerSupervisor({ SIGHTR_TASK_NAME: "herdr.sightr-test" });
  const s = spec(d);
  await writeFile(path.join(d, "exec-bridge.vbs"), "placeholder");
  await sup.disableNow(s, run);
  expect(order[0]).toBe("disable");
  expect(order.includes("stop")).toBe(true);
  expect(order.indexOf("disable")).toBeLessThan(order.indexOf("stop"));
  await sup.remove(s, run);
  expect(order.includes("unregister")).toBe(true);
  await expect(access(path.join(d, "exec-bridge.vbs"))).rejects.toThrow();
});

test("install fails loudly when Register-ScheduledTask fails", async () => {
  const d = await dir();
  const run: Run = async (cmd) => cmd === "powershell" ? { code: 1, stdout: "", stderr: "Register-ScheduledTask : Access is denied." } : { code: 0, stdout: "", stderr: "" };
  await expect(taskSchedulerSupervisor({ SIGHTR_TASK_NAME: "herdr.sightr-test" }).install(spec(d), run)).rejects.toThrow(/could not register the scheduled task 'herdr.sightr-test'[\s\S]*Access is denied/);
});
