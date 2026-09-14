import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Run } from "./types.ts";
import { execBridge, prepareBridgeEnv, watchBridge, type ExecChild } from "./exec-bridge.ts";

const secret = "super-secret-signing-key";

async function dir() {
  const d = await mkdtemp(path.join(tmpdir(), "sightr-"));
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, ".env"), `SIGHTR_VAPID_PRIVATE=${secret}\nSIGHTR_PORT=9999\n`);
  await writeFile(path.join(d, "sightr.log"), "old-out");
  await writeFile(path.join(d, "sightr-error.log"), "old-err");
  return d;
}
const run: Run = async (cmd) => {
  if (cmd === "tailscale") return { code: 0, stdout: JSON.stringify({ Self: { DNSName: "host.example.", TailscaleIPs: ["100.64.0.1"] } }), stderr: "" };
  if (cmd === "herdr") return { code: 1, stdout: "", stderr: "" };
  return { code: 0, stdout: "[]", stderr: "" };
};

test("prepareBridgeEnv puts secrets in the child env and not on the parent", async () => {
  const d = await dir();
  const before = process.env.SIGHTR_VAPID_PRIVATE;
  const { effective } = await prepareBridgeEnv(["--config-dir", d, "--socket", "/tmp/herdr.sock"], { HERDR_PLUGIN_CONFIG_DIR: d }, run);
  expect(effective.SIGHTR_VAPID_PRIVATE).toBe(secret);
  expect(effective.SIGHTR_PORT).toBe("9999");
  expect(effective.HERDR_PLUGIN_CONFIG_DIR).toBe(d);
  expect(effective.HERDR_SOCKET_PATH).toBe("/tmp/herdr.sock");
  expect(effective.SIGHTR_TAILSCALE_HOSTS).toContain("host.example");
  expect(process.env.SIGHTR_VAPID_PRIVATE).toBe(before);
});

test("the supervisor loop rotates crash logs, records both pids, and stops on a clean exit", async () => {
  const d = await dir();
  let n = 0;
  const spawn = () => {
    n++;
    return { pid: 500 + n, exited: Promise.resolve(n === 1 ? 1 : 0) };
  };
  const code = await execBridge(["--config-dir", d], { HERDR_PLUGIN_CONFIG_DIR: d }, run, { spawn, sleep: async () => {} });
  expect(code).toBe(0);
  expect(n).toBe(2);
  expect(await readFile(path.join(d, "sightr-previous.log"), "utf8")).toContain("old-out");
  expect(await readFile(path.join(d, "sightr-error-previous.log"), "utf8")).toContain("old-err");
  expect(await readFile(path.join(d, "sightr-processes"), "utf8")).toBe(`${process.pid}|0`);
});

test("the spawned bridge gets the planted env", async () => {
  const d = await dir();
  let seen: Record<string, string> | undefined;
  const spawn = (_cmd: string[], opts: { env: Record<string, string> }) => {
    seen = opts.env;
    return { pid: 9, exited: Promise.resolve(0) };
  };
  expect(await execBridge([], { HERDR_PLUGIN_CONFIG_DIR: d, HERDR_SOCKET_PATH: String.raw`\\.\pipe\herdr-test` }, run, { spawn })).toBe(0);
  expect(seen?.SIGHTR_VAPID_PRIVATE).toBe(secret);
  expect(seen?.HERDR_PLUGIN_CONFIG_DIR).toBe(d);
  expect(seen?.HERDR_SOCKET_PATH).toBe(String.raw`\\.\pipe\herdr-test`);
});

/** A fake bridge process whose exit the test controls. */
function fakeChild(pid: number): ExecChild & { exit(code: number): void; killed: number } {
  let resolve!: (code: number) => void;
  const exited = new Promise<number>((r) => { resolve = r; });
  const child = { pid, exited, killed: 0, exit: (code: number) => resolve(code), kill() { child.killed++; resolve(137); } };
  return child;
}

test("the watchdog kills a bridge that stops answering and respawns it", async () => {
  const d = await dir();
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawn = () => {
    const c = fakeChild(700 + children.length);
    children.push(c);
    // The replacement exits cleanly so the loop ends.
    if (children.length === 2) c.exit(0);
    return c;
  };
  let probes = 0;
  const probe = async () => { probes++; return false; };
  const code = await execBridge(["--config-dir", d], { HERDR_PLUGIN_CONFIG_DIR: d }, run, {
    spawn, probe, sleep: async () => {}, watchdog: { graceMs: 0, intervalMs: 0, failures: 3 },
  });
  expect(code).toBe(0);
  expect(children.length).toBe(2);
  expect(children[0]!.killed).toBe(1);
  expect(probes).toBe(3);
  // Killing counts as a crash: the logs rotate and the fresh error log says why.
  expect(await readFile(path.join(d, "sightr-error-previous.log"), "utf8")).toContain("old-err");
  expect(await readFile(path.join(d, "sightr-error.log"), "utf8")).toContain("[supervisor]");
  expect(await readFile(path.join(d, "sightr-error.log"), "utf8")).toContain("pid 700");
});

test("a bridge that answers is left alone until it exits by itself", async () => {
  const d = await dir();
  let child: ReturnType<typeof fakeChild> | undefined;
  const spawn = () => { child = fakeChild(800); return child; };
  let probes = 0;
  const probe = async () => { probes++; if (probes === 5) child!.exit(0); return true; };
  const code = await execBridge(["--config-dir", d], { HERDR_PLUGIN_CONFIG_DIR: d }, run, {
    spawn, probe, sleep: async () => {}, watchdog: { graceMs: 0, intervalMs: 0, failures: 2 },
  });
  expect(code).toBe(0);
  expect(child!.killed).toBe(0);
  expect(probes).toBeGreaterThanOrEqual(5);
});

test("one good answer resets the miss count", async () => {
  const child = fakeChild(900);
  const answers = [false, true, false, true, false];
  let i = 0;
  const probe = async () => { const a = answers[i++]; if (a === undefined) { child.exit(0); return true; } return a; };
  const hung = await watchBridge(child, 1, {}, { sleep: async () => {}, probe }, { graceMs: 0, intervalMs: 0, failures: 2 });
  expect(hung).toBe(false);
  expect(i).toBe(answers.length + 1);
});

test("a bridge that exits during the grace period is not probed", async () => {
  const child = fakeChild(901);
  let probes = 0;
  const probe = async () => { probes++; return false; };
  const sleep = async () => { child.exit(1); await Promise.resolve(); };
  expect(await watchBridge(child, 1, {}, { sleep, probe }, { graceMs: 1, intervalMs: 1, failures: 1 })).toBe(false);
  expect(probes).toBe(0);
});
