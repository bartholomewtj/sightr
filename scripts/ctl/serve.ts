import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Run } from "./types.ts";
import { CtlError, realRun } from "./types.ts";
import { resolvePaths } from "./paths.ts";
import { hasTailscale, selfDnsName } from "./tailscale.ts";

export type HandlerRecord = { mode: "http" | "https"; port: string; hostPort: string; proxy: string };
export type ServeIo = { remove: (p: string) => Promise<void> };
const defaultIo: ServeIo = { remove: (p) => rm(p, { force: true }) };
const rec = (p: string) => p + "/tailscale-managed-handler";

export function parseHandlerRecord(raw: string): HandlerRecord | { error: string } {
  const x = raw.trim().split("|");
  const m = x[0]?.match(/^(http|https):(\d+)$/);
  if (x.length !== 3 || !m || x[1] === undefined || x[2] === undefined) {
    return { error: `error: invalid managed Tailscale handler state: ${raw.trim()}` };
  }
  const mode = m[1] as "http" | "https";
  const port = m[2]!;
  if (mode === "https" && port !== "443") return { error: `error: invalid managed Tailscale handler state: ${raw.trim()}` };
  if (!x[1]!.endsWith(`:${port}`)) return { error: `error: managed Tailscale HostPort does not match its listener: ${raw.trim()}` };
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(x[2]!)) return { error: `error: invalid managed Tailscale proxy target: ${raw.trim()}` };
  return { mode, port, hostPort: x[1]!, proxy: x[2]! };
}
export function formatHandlerRecord(r: HandlerRecord) {
  return `${r.mode}:${r.port}|${r.hostPort}|${r.proxy}\n`;
}

function tcp(s: any, p: string) { return s?.TCP?.[p] ?? s?.TCP?.[Number(p)]; }
function webProxy(s: any, host: string): string | undefined {
  const h = s?.Web?.[host]?.Handlers;
  if (!h) return;
  const v = h["/"] ?? h[Object.keys(h)[0] ?? ""];
  return typeof v?.Proxy === "string" ? v.Proxy : undefined;
}
export function rootFingerprint(status: unknown, hostPort: string, port: string) {
  const t = tcp(status, port);
  if (!t) return "absent";
  const k = t.HTTP ? "http" : t.HTTPS ? "https" : "other";
  const p = webProxy(status, hostPort);
  return p ? `${k}|proxy:${p}` : `${k}|other`;
}
function foregroundProtocol(s: any, listener: string): string | undefined {
  if (!s?.Foreground) return;
  const f = Array.isArray(s.Foreground) ? s.Foreground : Object.values(s.Foreground);
  for (const item of f) {
    const t = tcp(item, listener);
    if (t?.HTTP) return "http";
    if (t?.HTTPS) return "https";
    const nested = foregroundProtocol(item, listener);
    if (nested) return nested;
  }
  return;
}
export function rootAvailability(status: any, port: string, protocol: "http" | "https", expected: string) {
  const listener = protocol === "https" ? "443" : port;
  if (foregroundProtocol(status, listener)) return "occupied";
  const t = tcp(status, listener);
  if (t && ((t.HTTP && protocol !== "http") || (t.HTTPS && protocol !== "https"))) return "protocol-mismatch";
  const hosts = Object.keys(status?.Web ?? {}).filter((h) => h.endsWith(`:${listener}`));
  const targets = hosts.map((h) => webProxy(status, h)).filter(Boolean);
  if (targets.length === 0 && !t) return "free";
  if (targets.length === 0) return t ? "occupied" : "free";
  return targets.every((x) => x === expected) ? "adoptable" : "occupied";
}

export async function stopServe(
  paths: { configDir: string },
  _env: Record<string, string | undefined>,
  run: Run,
  io: ServeIo = defaultIo,
): Promise<number> {
  const file = rec(paths.configDir);
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch { console.log("tailscale serve: no Sightr-managed mapping recorded"); return 0; }
  const parsed = parseHandlerRecord(raw);
  if ("error" in parsed) throw new CtlError(parsed.error);
  const st = await run("tailscale", ["serve", "status", "--json"]);
  if (st.code !== 0) throw new CtlError("error: cannot inspect the managed Tailscale root; retained ownership state");
  let fp: string;
  try { fp = rootFingerprint(JSON.parse(st.stdout || "{}"), parsed.hostPort, parsed.mode === "https" ? "443" : parsed.port); }
  catch { throw new CtlError("error: cannot inspect the managed Tailscale root; retained ownership state"); }
  if (fp === "absent") {
    try { await io.remove(file); }
    catch { throw new CtlError("error: managed Tailscale root is absent but ownership state could not be removed"); }
    console.log("tailscale serve: managed root is already absent; cleared stale ownership state");
    return 0;
  }
  if (fp !== `${parsed.mode}|proxy:${parsed.proxy}`) {
    throw new CtlError("error: managed Tailscale root was replaced; refusing to remove the current handler");
  }
  const off = await run("tailscale", ["serve", parsed.mode === "http" ? `--http=${parsed.port}` : "--https=443", "--set-path=/", "off"]);
  if (off.code !== 0 && !/handler does not exist/i.test(off.stdout + off.stderr)) {
    throw new CtlError(`error: failed to remove Sightr's ${parsed.mode} mapping`);
  }
  try { await io.remove(file); }
  catch { throw new CtlError("error: Tailscale root was removed but ownership state could not be removed"); }
  console.log("tailscale serve: removed Sightr's managed mapping");
  return 0;
}

export async function serve(env: Record<string, string | undefined> = process.env, run: Run = realRun, io: ServeIo = defaultIo): Promise<number> {
  const paths = await resolvePaths(env, run);
  await mkdir(paths.configDir, { recursive: true });
  const port = env.SIGHTR_PORT ?? "8787";
  const mode: "http" | "https" = env.SIGHTR_SERVE_MODE === "http" ? "http" : "https";
  if (env.SIGHTR_SKIP_SERVE === "1") {
    await stopServe(paths, env, run, io);
    console.log(`tailscale serve skipped (SIGHTR_SKIP_SERVE=1) — bridge is on 127.0.0.1:${port} only`);
    return 0;
  }
  await stopServe(paths, env, run, io);
  if (!await hasTailscale(run)) throw new CtlError("error: tailscale not found; cannot publish the tailnet front door");
  const name = await selfDnsName(run);
  if (!name) throw new CtlError("error: cannot determine Tailscale hostname; refusing to publish an untrackable root mount");
  const st = await run("tailscale", ["serve", "status", "--json"]);
  if (st.code !== 0) throw new CtlError(`error: cannot inspect Tailscale serve status; refusing to overwrite the root mount on :${port}`);
  let json: any;
  try { json = JSON.parse(st.stdout || "{}"); }
  catch { throw new CtlError(`error: invalid Tailscale serve status; refusing to overwrite the root mount on :${port}`); }
  const proxy = `http://127.0.0.1:${port}`;
  const listener = mode === "https" ? "443" : port;
  const a = rootAvailability(json, port, mode, proxy);
  if (a === "protocol-mismatch") throw new CtlError(`error: Tailscale serve :${port} already uses the opposite listener protocol`);
  if (a === "occupied") throw new CtlError(`error: Tailscale serve already has an unowned root mount on :${port}; refusing to overwrite it`);
  if (a === "adoptable") console.log(`tailscale serve: adopting the existing Sightr root mount on :${port}`);
  await writeFile(rec(paths.configDir), formatHandlerRecord({ mode, port: listener, hostPort: `${name}:${listener}`, proxy }));
  const args = mode === "http" ? ["serve", "--bg", `--http=${port}`, "--set-path=/", port] : ["serve", "--bg", "--set-path=/", port];
  const x = await run("tailscale", args);
  if (x.code !== 0) {
    await rm(rec(paths.configDir), { force: true });
    if (mode === "http") console.error("note: tailscale serve failed (it may need an Administrator PowerShell):");
    else console.error("note: tailscale serve (https) failed — on Headscale/.internal domains use SIGHTR_SERVE_MODE=http:");
    console.error(x.stdout || x.stderr);
    return 1;
  }
  console.log(`tailscale serve (${mode}) → tailnet :${mode === "https" ? "443" : port} -> 127.0.0.1:${port}`);
  return 0;
}

export async function unserve(env: Record<string, string | undefined> = process.env, run: Run = realRun, io: ServeIo = defaultIo) {
  await stopServe(await resolvePaths(env, run), env, run, io);
  return 0;
}
