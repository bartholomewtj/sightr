import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";
import type { Run } from "./types.ts";
import { bridgeProcesses, parseOwningPids, selfProcessIds, stopAllBridges, stopRecorded, waitPortFree, type WinProc } from "./win-processes.ts";

test("walks process parents with a cycle guard and a 16-cap", () => {
  const cycle: WinProc[] = [{ ProcessId: 4, ParentProcessId: 3, CommandLine: null }, { ProcessId: 3, ParentProcessId: 4, CommandLine: null }];
  expect(selfProcessIds(cycle, 4)).toEqual([4, 3]);
  const chain: WinProc[] = [];
  for (let i = 20; i >= 1; i--) chain.push({ ProcessId: i, ParentProcessId: i - 1, CommandLine: null });
  expect(selfProcessIds(chain, 20)).toHaveLength(16);
});

test("matches this checkout, launchers, relative listener, and never self", () => {
  const root = String.raw`C:\x`;
  const vbs = String.raw`C:\x\exec-bridge.vbs`;
  const procs: WinProc[] = [
    { ProcessId: 1, ParentProcessId: 0, CommandLine: String.raw`bun.exe run C:\x\bridge\index.ts` },
    { ProcessId: 2, ParentProcessId: 0, CommandLine: "bun.exe run C:/x/bridge/index.ts" },
    { ProcessId: 3, ParentProcessId: 0, CommandLine: "powershell -File sightr-ctl.ps1 _exec-bridge" },
    { ProcessId: 4, ParentProcessId: 0, CommandLine: `wscript.exe //nologo ${vbs}` },
    { ProcessId: 5, ParentProcessId: 0, CommandLine: "bun run bridge/index.ts" },
    { ProcessId: 6, ParentProcessId: 0, CommandLine: "nginx" },
    { ProcessId: 7, ParentProcessId: 0, CommandLine: "bun run other/bridge/index.ts" },
  ];
  expect(bridgeProcesses(procs, { pluginRoot: root, vbsPath: vbs, selfIds: [1], listeners: [5] }).map((p) => p.ProcessId).sort()).toEqual([2, 3, 4, 5]);
  expect(bridgeProcesses(procs, { pluginRoot: root, vbsPath: vbs, selfIds: [], listeners: [] }).map((p) => p.ProcessId).sort()).toEqual([1, 2, 3, 4]);
  expect(bridgeProcesses(procs, { pluginRoot: root, vbsPath: vbs, selfIds: [], listeners: [6] }).map((p) => p.ProcessId)).not.toContain(6);
});

test("stopAllBridges tree-kills launchers, kills bridges, then waits for the port", async () => {
  const calls: string[] = [];
  let polls = 0;
  const run: Run = async (_c, args) => {
    const joined = args.join(" ");
    calls.push(joined);
    if (joined.includes("Get-CimInstance")) {
      return {
        code: 0,
        stdout: JSON.stringify([
          { ProcessId: 4101, ParentProcessId: 0, CommandLine: String.raw`bun.exe run C:\x\bridge\index.ts` },
          { ProcessId: 4102, ParentProcessId: 0, CommandLine: "powershell -File sightr-ctl.ps1 _exec-bridge" },
          { ProcessId: 4103, ParentProcessId: 0, CommandLine: String.raw`wscript.exe //nologo C:\x\exec-bridge.vbs` },
        ]),
        stderr: "",
      };
    }
    if (joined.includes("Get-NetTCPConnection")) {
      polls++;
      return { code: 0, stdout: polls < 3 ? JSON.stringify({ OwningProcess: 4101 }) : "[]", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await stopAllBridges({ pluginRoot: String.raw`C:\x`, vbsPath: String.raw`C:\x\exec-bridge.vbs`, port: "8787", selfIds: [] }, run, async () => {});
  expect(calls.some((c) => c.includes("Stop-Process -Id 4101"))).toBe(true);
  expect(calls.some((c) => c.includes("taskkill /PID 4102 /T /F"))).toBe(true);
  expect(calls.some((c) => c.includes("taskkill /PID 4103 /T /F"))).toBe(true);
  expect(polls).toBeGreaterThanOrEqual(3);
});

test("a remaining foreign listener throws naming the pid and #41", async () => {
  const run: Run = async (_c, args) => {
    if (args.join(" ").includes("Get-NetTCPConnection")) return { code: 0, stdout: JSON.stringify({ OwningProcess: 777 }), stderr: "" };
    if (args.join(" ").includes("Get-CimInstance")) return { code: 0, stdout: "[]", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  await expect(waitPortFree({ port: "8787" }, run, async () => {})).rejects.toThrow(/777/);
  await expect(waitPortFree({ port: "8787" }, run, async () => {})).rejects.toThrow(/#41/);
});

test("port occupancy query is loopback LISTEN only (not IPv6-any or TimeWait)", async () => {
  let command = "";
  const run: Run = async (_c, args) => {
    command = args.join(" ");
    return { code: 0, stdout: "[]", stderr: "" };
  };
  await waitPortFree({ port: "8787" }, run, async () => {});
  expect(command).toContain("-State Listen");
  expect(command).toContain("-LocalAddress @('127.0.0.1','::1')");
  expect(command).not.toContain("0.0.0.0");
});

test("stopRecorded throws on a malformed record and only kills matching command lines", async () => {
  const d = await mkdtemp(path.join(tmpdir(), "sightr-"));
  const file = path.join(d, "sightr-processes");
  await writeFile(file, "not-a-record");
  await expect(stopRecorded({ processFile: file }, { pluginRoot: String.raw`C:\x`, vbsPath: "v" }, async () => ({ code: 0, stdout: "[]", stderr: "" }))).rejects.toThrow(/invalid Sightr process ownership state/);
  await writeFile(file, "11|12");
  const killed: string[] = [];
  const run: Run = async (_c, args) => {
    if (args.join(" ").includes("Get-CimInstance")) {
      return { code: 0, stdout: JSON.stringify([
        { ProcessId: 11, ParentProcessId: 0, CommandLine: "powershell -File sightr-ctl.ps1 _exec-bridge" },
        { ProcessId: 12, ParentProcessId: 0, CommandLine: "notepad" },
      ]), stderr: "" };
    }
    killed.push(args.join(" "));
    return { code: 0, stdout: "", stderr: "" };
  };
  await stopRecorded({ processFile: file }, { pluginRoot: String.raw`C:\x`, vbsPath: "vbs" }, run);
  expect(killed.some((c) => c.includes("11"))).toBe(true);
  expect(killed.some((c) => c.includes("12"))).toBe(false);
  await expect(access(file)).rejects.toThrow();
});

test("parseOwningPids reads a single object or an array", () => {
  expect(parseOwningPids(JSON.stringify({ OwningProcess: 7 }))).toEqual([7]);
  expect(parseOwningPids(JSON.stringify([{ OwningProcess: 1 }, { OwningProcess: 2 }]))).toEqual([1, 2]);
  expect(parseOwningPids("null")).toEqual([]);
});
