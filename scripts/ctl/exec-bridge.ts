import path from "node:path";
import os from "node:os";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { openSync } from "node:fs";
import { resolvePaths } from "./paths.ts";
import { loadEnv } from "./env.ts";
import { resolveBun } from "./bun.ts";
import { realRun, type Run } from "./types.ts";
import { selfHosts } from "./tailscale.ts";
import { stopAllBridges } from "./win-processes.ts";
import { snapshotProbeHeaders } from "./status.ts";

export type ExecChild = { pid: number; exited: Promise<number>; kill?: () => void };
export type ExecSpawn = (cmd: string[], opts: { cwd: string; env: Record<string, string>; stdout?: any; stderr?: any }) => ExecChild;
export type ExecIo = {
  spawn?: ExecSpawn;
  sleep?: (ms: number) => Promise<void>;
  /** Resolves true when the bridge answers HTTP on the port (any status code counts). */
  probe?: (port: number, env: Record<string, string>) => Promise<boolean>;
  watchdog?: Partial<Watchdog>;
};

/**
 * How the supervisor decides a live bridge process has stopped working. Probes start after
 * `graceMs` (the bridge builds the visualiser UI on first start), repeat every `intervalMs`, and
 * `failures` misses in a row mean restart. Defaults give a wedged bridge about a minute.
 */
export type Watchdog = { graceMs: number; intervalMs: number; failures: number };
export const WATCHDOG: Watchdog = { graceMs: 60_000, intervalMs: 15_000, failures: 4 };

function defaultSpawn(cmd: string[], opts: { cwd: string; env: Record<string, string>; stdout?: any; stderr?: any }): ExecChild {
  const child = Bun.spawn(cmd, opts);
  return { pid: child.pid ?? 0, exited: child.exited, kill: () => child.kill() };
}

// A TCP connect is not enough: a wedged bridge still accepts connections on its listen socket and
// then never answers (seen live 2026-09-06 — port open, every request hung, Herdr itself fine). Ask
// for a real response. 401/403 still count: the bridge is alive, it just refused the probe.
async function defaultProbe(port: number, env: Record<string, string>): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/snapshot`, { signal: AbortSignal.timeout(5000), headers: snapshotProbeHeaders(env) });
    return true;
  } catch {
    return false;
  }
}

export async function prepareBridgeEnv(argv: string[], env: Record<string, string | undefined>, run: Run) {
  let cfg = env.HERDR_PLUGIN_CONFIG_DIR, socket = env.HERDR_SOCKET_PATH;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config-dir") cfg = argv[++i];
    else if (argv[i] === "--socket") socket = argv[++i];
  }
  const base = await resolvePaths({ ...env, HERDR_PLUGIN_CONFIG_DIR: cfg }, run);
  let vals: Record<string, string> = {};
  try { vals = Object.fromEntries((await loadEnv(base.envFile)).values); } catch { /* absent */ }
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const roaming = env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const effective: Record<string, string> = {
    ...(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>),
    ...vals,
    HERDR_PLUGIN_CONFIG_DIR: cfg ?? base.configDir,
    HERDR_SOCKET_PATH: socket || env.HERDR_SOCKET_PATH || vals.HERDR_SOCKET_PATH || path.join(roaming, "herdr", "herdr.sock"),
    SIGHTR_PORT: env.SIGHTR_PORT ?? vals.SIGHTR_PORT ?? "8787",
    SIGHTR_TAILSCALE_HOSTS: env.SIGHTR_SKIP_SERVE === "1" ? "" : (env.SIGHTR_TAILSCALE_HOSTS ?? vals.SIGHTR_TAILSCALE_HOSTS ?? await selfHosts(run)),
  };
  if (!effective.HERDR_PLUGIN_STATE_DIR) effective.HERDR_PLUGIN_STATE_DIR = path.join(local, "herdr", "plugins", "herdr.sightr");
  const bun = await resolveBun(effective);
  if (!bun) throw new Error("error: bun not found on PATH");
  return { base, effective, bun, bridge: path.join(base.pluginRoot, "bridge/index.ts") };
}

/**
 * Watch one bridge process until it exits or stops answering. Resolves `true` when the watchdog
 * gave up on it (the caller kills it); `false` when the process ended on its own first.
 */
export async function watchBridge(
  child: ExecChild,
  port: number,
  env: Record<string, string>,
  io: { sleep: (ms: number) => Promise<void>; probe: (port: number, env: Record<string, string>) => Promise<boolean> },
  cfg: Watchdog = WATCHDOG,
): Promise<boolean> {
  let exited = false;
  void child.exited.then(() => { exited = true; });
  await io.sleep(cfg.graceMs);
  let misses = 0;
  while (!exited) {
    const ok = await io.probe(port, env);
    if (exited) break;
    misses = ok ? 0 : misses + 1;
    if (misses >= cfg.failures) return true;
    await io.sleep(cfg.intervalMs);
  }
  return false;
}

// Supervisor loop run by the scheduled task: spawn the bridge, record `<self pid>|<child pid>` so stop
// can find both, rotate the log pair on a crash, and respawn after 5s. A clean exit (code 0) ends the
// loop. A bridge that is alive but no longer answers HTTP is killed and treated as a crash.
export async function execBridge(argv: string[], env: Record<string, string | undefined> = process.env, run: Run = realRun, io: ExecIo = {}) {
  const spawn = io.spawn ?? defaultSpawn;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const probe = io.probe ?? defaultProbe;
  const watchdog = { ...WATCHDOG, ...io.watchdog };
  const { base, effective, bun, bridge } = await prepareBridgeEnv(argv, env, run);
  const port = Number(effective.SIGHTR_PORT ?? "8787");
  await mkdir(base.configDir, { recursive: true });
  const processFile = path.join(base.configDir, "sightr-processes");
  const log = path.join(base.configDir, "sightr.log");
  const errorLog = path.join(base.configDir, "sightr-error.log");
  await stopAllBridges({ pluginRoot: base.pluginRoot, vbsPath: path.join(base.configDir, "exec-bridge.vbs"), port: effective.SIGHTR_PORT ?? "8787" }, run);
  while (true) {
    await writeFile(processFile, `${process.pid}|0`);
    const out = openSync(log, "a");
    const err = openSync(errorLog, "a");
    const child = spawn([bun, "run", bridge], { cwd: base.pluginRoot, env: effective, stdout: out, stderr: err });
    await writeFile(processFile, `${process.pid}|${child.pid}`);
    const hung = await Promise.race([
      child.exited.then(() => false),
      watchBridge(child, port, effective, { sleep, probe }, watchdog),
    ]);
    if (hung) {
      // The port must be free before the respawn, so make sure the old process is really gone.
      try { child.kill?.(); } catch { /* already gone */ }
      const gone = await Promise.race([child.exited.then(() => true), sleep(5000).then(() => false)]);
      if (!gone) await run("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${child.pid} -Force`]);
    }
    const code = hung ? 1 : await child.exited;
    await writeFile(processFile, `${process.pid}|0`);
    if (code === 0) return 0;
    try { await rename(log, path.join(base.configDir, "sightr-previous.log")); } catch { /* first crash */ }
    try { await rename(errorLog, path.join(base.configDir, "sightr-error-previous.log")); } catch { /* first crash */ }
    if (hung) {
      await appendFile(
        errorLog,
        `[supervisor] ${new Date().toISOString()} bridge pid ${child.pid} stopped answering on 127.0.0.1:${port} (${watchdog.failures} probes) — killed and restarting\n`,
      );
    }
    await sleep(5000);
  }
}
