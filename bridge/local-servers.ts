import { guard } from "./access.ts";
import type { Config } from "./config.ts";
import { json, text } from "./responses.ts";

/** How a shell-out is invoked. Tests pass a fake; the route uses {@link powershellRun}. */
export type ShellRun = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface LocalServer {
  port: number;
  /** From the fixed map, or "" when the port isn't known. */
  name: string;
}

export interface LocalServersBody {
  host: string;
  servers: LocalServer[];
}

/** Known loopback listeners. Anything else is listed with an empty name. */
export const LOCAL_SERVER_NAMES: Readonly<Record<number, string>> = {
  3080: "local models",
  4877: "node",
  8787: "sightr",
  9222: "chrome devtools",
  9333: "chrome",
  18787: "thickapi",
  32400: "plex",
};

/** `tailscale serve` owns 443. It is not a server this tab should open. */
const SERVE_PORT = 443;

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

const HOST_TTL_MS = 60_000;
const SHELL_TIMEOUT_MS = 5_000;

const LISTENERS_COMMAND = "Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort | ConvertTo-Json -Compress";

/**
 * `powershell.exe -NoProfile -Command`, the same spawn the control script uses for a Windows
 * shell-out (`scripts/ctl`). A timeout kills the process so a hung query can't pin the request.
 */
export const powershellRun: ShellRun = async (cmd, args, opts = {}) => {
  try {
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : undefined;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (timer) clearTimeout(timer);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 127, stdout: "", stderr: String(error) };
  }
};

/**
 * Keep loopback listeners, drop wildcard binds and port 443, dedupe, sort, and name known ports.
 * `Get-NetTCPConnection | ConvertTo-Json` emits one object or an array; either is fine.
 */
export function parseListeners(stdout: string): LocalServer[] | null {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const ports = new Set<number>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const address = String((row as { LocalAddress?: unknown }).LocalAddress ?? "");
    const port = Number((row as { LocalPort?: unknown }).LocalPort);
    if (!LOOPBACK.has(address)) continue;
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === SERVE_PORT) continue;
    ports.add(port);
  }
  return [...ports].sort((a, b) => a - b).map((port) => ({ port, name: LOCAL_SERVER_NAMES[port] ?? "" }));
}

/** `Self.DNSName` with the trailing dot stripped. "" when Tailscale isn't reachable or unnamed. */
export function parseDnsName(stdout: string): string {
  try {
    const name = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName ?? "";
    return String(name).replace(/\.$/, "");
  } catch {
    return "";
  }
}

export interface LocalServersDeps {
  run?: ShellRun;
  now?: () => number;
}

/**
 * GET /api/local-servers. Read-only: the same access check as every other bridge route, and
 * nothing written to the audit log — it reads no operator content.
 *
 * The Tailscale name is cached and refreshed at most once a minute. A failed listener query
 * returns the last good list rather than emptying the tab. If the name can't be read, both
 * fields come back empty with status 200 so the tab can say Tailscale isn't running.
 */
export function createLocalServersRoute(deps: LocalServersDeps = {}) {
  const run = deps.run ?? powershellRun;
  const now = deps.now ?? Date.now;
  let host = "";
  let hostAt = 0;
  let servers: LocalServer[] = [];

  async function refreshHost(): Promise<string> {
    const at = now();
    if (host && at - hostAt < HOST_TTL_MS) return host;
    hostAt = at;
    try {
      const result = await run("tailscale", ["status", "--json"], { timeoutMs: SHELL_TIMEOUT_MS });
      if (result.code === 0) host = parseDnsName(result.stdout);
    } catch {
      // Leave the cached name. A miss on the first read stays "".
    }
    return host;
  }

  async function refreshServers(): Promise<LocalServer[]> {
    try {
      const result = await run("powershell.exe", ["-NoProfile", "-Command", LISTENERS_COMMAND], { timeoutMs: SHELL_TIMEOUT_MS });
      if (result.code !== 0) return servers;
      const parsed = parseListeners(result.stdout);
      if (parsed === null) return servers;
      servers = parsed;
    } catch {
      // Last good list. A miss on the first read stays [].
    }
    return servers;
  }

  return async function localServersRoute(req: Request, cfg: Config): Promise<Response> {
    if (req.method !== "GET") return text("method not allowed", 405);
    const denied = guard(req, cfg, "read");
    if (denied) return denied;
    const [name, list] = await Promise.all([refreshHost(), refreshServers()]);
    // No name means the phone has nothing it can open. Don't hand it a list of ports it can't reach.
    const body: LocalServersBody = name ? { host: name, servers: list } : { host: "", servers: [] };
    return json(body, req.headers.get("accept-encoding"));
  };
}
