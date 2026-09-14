import type { Run } from "./types.ts";

export async function selfDnsName(run: Run): Promise<string> {
  const r = await run("tailscale", ["status", "--json"]);
  if (r.code !== 0) return "";
  try { return String((JSON.parse(r.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName ?? "").replace(/\.$/, ""); } catch { return ""; }
}
export async function selfHosts(run: Run): Promise<string> {
  const r = await run("tailscale", ["status", "--json"]);
  if (r.code !== 0) return "";
  try {
    const self = (JSON.parse(r.stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }).Self;
    if (!self) return "";
    return [String(self.DNSName ?? "").replace(/\.$/, ""), ...(self.TailscaleIPs ?? []).map(ip => ip.includes(":") ? `[${ip}]` : ip)].filter(Boolean).join(",");
  } catch { return ""; }
}
export async function hasTailscale(run: Run): Promise<boolean> { return (await run("tailscale", ["version"])).code !== 127; }
export async function bridgeUrl(env: Record<string,string|undefined>, run: Run): Promise<string> {
  const port = env.SIGHTR_PORT ?? "8787";
  if (env.SIGHTR_SKIP_SERVE === "1") return env.SIGHTR_PUBLIC_URL ?? `http://127.0.0.1:${port} (SIGHTR_SKIP_SERVE=1; public URL unset)`;
  const name = await selfDnsName(run);
  if (!name) return `http://127.0.0.1:${port} (Tailscale name unavailable)`;
  return env.SIGHTR_SERVE_MODE === "http" ? `http://${name}:${port}` : `https://${name}`;
}
export async function inboundBlocked(run: Run): Promise<boolean> {
  // Loopback readiness cannot see the tailnet packet filter. Only an explicitly empty filter is definite proof of unreachable peers; all uncertainty is deliberately silent.
  const result = await run("tailscale", ["debug", "netmap"], { timeoutMs: 3000 });
  if (result.code !== 0) return false;
  try { const filter = (JSON.parse(result.stdout) as {PacketFilter?: unknown}).PacketFilter; return Array.isArray(filter) && filter.length === 0; } catch { return false; }
}
export async function serveStatus(run: Run): Promise<string> { const r = await run("tailscale", ["serve", "status"]); if (r.code !== 0) return "    (unavailable)"; return r.stdout.trim() ? r.stdout.trim().split(/\r?\n/).map(x => `    ${x}`).join("\n") : "    (unavailable)"; }
