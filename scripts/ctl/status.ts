import { resolvePaths } from "./paths.ts";
import { getVersion } from "./version.ts";
import { bridgeUrl, inboundBlocked, serveStatus } from "./tailscale.ts";
import { selectSupervisor } from "./supervisor/index.ts";
import { realRun, type Run } from "./types.ts";
import { loadEnv } from "./env.ts";
import { hardenConfig } from "./perms.ts";
export interface Facts { ready:boolean; herdrReady:boolean; service:string; version:string; port:string|number; skipServe:boolean; publicUrl?:string; url:string; blocked:boolean; }
export function renderStatus(f: Facts): string {
 const tailnet = f.blocked ? `    tailnet   ${f.url}  (unreachable from other devices)` : !f.ready ? `    tailnet   ${f.url}  (unverified — the bridge isn't answering locally yet)` : `    tailnet   ${f.url}`;
 const lines=["", f.ready&&f.herdrReady?`  ✓ Sightr is running  ·  v${f.version}`:f.ready?`  ⚠ Sightr is running but cannot reach Herdr  ·  v${f.version}`:`  ⚠ Sightr isn't answering on :${f.port} yet (v${f.version}) — check 'sightr-ctl.ps1 logs'`,`    service   ${f.service}`,`    local     http://127.0.0.1:${f.port}`, f.skipServe ? `    proxy     ${f.publicUrl ?? "(SIGHTR_SKIP_SERVE=1 — set SIGHTR_PUBLIC_URL to your reverse-proxy URL)"}` : tailnet];
 if(f.blocked) lines.push("", "    ⚠ this node's packet filter admits no peer, so no other device can reach that URL —", "      the front door itself is published fine. Either your tailnet policy grants this node nothing, or no other device has joined the tailnet yet.", "      Check the policy (https://login.tailscale.com/admin/acls on Tailscale; your policy file on Headscale).", "      ('tailscale ping' will still succeed — disco pings bypass ACLs.)");
 if(f.skipServe) lines.push("", "  serve config: skipped (SIGHTR_SKIP_SERVE=1)");
 return lines.join("\n");
}
async function loadEnvIfPresent(file:string):Promise<Record<string,string>> { try { const parsed=await loadEnv(file); parsed.warnings.forEach(x=>console.error(x)); return Object.fromEntries(parsed.values); } catch { return {}; } }
/**
 * "Answering" means an HTTP response, not an open port: a wedged bridge keeps accepting TCP connects
 * and never replies (live 2026-09-06), which a bare connect reported as running. Any status counts —
 * 401/403 are the bridge refusing the probe, not the bridge being down. `waitMs` is how long to keep
 * retrying; `start` passes a longer budget because a Task Scheduler launch can take 10-30 s to listen.
 */
export const STATUS_WAIT_MS = 5000;
export async function ready(port:number, env:Record<string,string|undefined>={}, waitMs=STATUS_WAIT_MS):Promise<boolean>{ const until=Date.now()+waitMs; for(;;){ try{ await fetch(`http://127.0.0.1:${port}/api/snapshot`,{signal:AbortSignal.timeout(2000),headers:snapshotProbeHeaders(env)}); return true; }catch{} if(Date.now()>=until) return false; await Bun.sleep(500); } }

export type SnapshotGet = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/** Loopback /api/snapshot has no identity exemption (serve proxies from 127.0.0.1), so the probe must send the configured login. */
export function snapshotProbeHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const user = env.SIGHTR_TRUSTED_USER?.trim();
  return user ? { "Tailscale-User-Login": user } : {};
}

/** 401 (reconnect lock) and 403 (identity/host gate) mean the bridge refused the probe — not that Herdr is down. */
export function herdrFromSnapshot(status: number, body?: { bridge?: string }): boolean {
  if (status === 401 || status === 403) return true;
  return body?.bridge === "connected";
}

export async function probeHerdr(
  port: number,
  env: Record<string, string | undefined> = {},
  get: SnapshotGet = fetch,
): Promise<boolean> {
  try {
    const res = await get(`http://127.0.0.1:${port}/api/snapshot`, {
      signal: AbortSignal.timeout(1000),
      headers: snapshotProbeHeaders(env),
    });
    let body: { bridge?: string } | undefined;
    if (res.ok) {
      try { body = await res.json() as { bridge?: string }; } catch { /* not JSON */ }
    }
    return herdrFromSnapshot(res.status, body);
  } catch {
    return false;
  }
}

export async function status(env:Record<string,string|undefined>=process.env,run:Run=realRun,opts:{waitMs?:number}={}){const p=await resolvePaths(env,run);const parsed=await loadEnvIfPresent(p.envFile); const effective={...env,...parsed}; await hardenConfig(p.configDir,p.envFile,run,env); const port=Number(effective.SIGHTR_PORT??8787);const r=await ready(port,effective,opts.waitMs);const hr=await probeHerdr(port,effective); const s=selectSupervisor(effective);const url=await bridgeUrl(effective,run);const blocked=effective.SIGHTR_SKIP_SERVE==="1"?false:await inboundBlocked(run);console.log(renderStatus({ready:r,herdrReady:hr,service:await s.describe(run),version:await getVersion(p),port,skipServe:effective.SIGHTR_SKIP_SERVE==="1",publicUrl:effective.SIGHTR_PUBLIC_URL,url,blocked})); if(!effective.SIGHTR_SKIP_SERVE) console.log(`\n  serve config:\n${await serveStatus(run)}`); return 0;}
