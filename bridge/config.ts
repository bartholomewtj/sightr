import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { resolveStateDir } from "./beacon/paths.ts";
import type { JournalRoots } from "./journal/registry.ts";
import { AGENTS } from "../shared/agents.ts";
import { parseAuditContent, type AuditContent } from "./audit.ts";

// All bridge configuration, resolved once at startup. Env-driven so the Task Scheduler job and the
// plugin launcher can configure it without code changes. Defaults are safe for a single-user,
// tailnet-only deployment.

/**
 * Read an integer env var, falling back to `fallback` (with one warning line) on anything invalid:
 * an empty/unset value, non-integer garbage (`parseInt("123abc")` used to sneak `123` through — a
 * strict regex rejects it), or a value outside the optional `[min, max]` bounds. Keeping bad config
 * from silently becoming a nonsense number (a negative poll interval, port 0) is the whole point.
 */
function envInt(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    console.warn(`[config] ${name}="${raw}" is not an integer — using default ${fallback}`);
    return fallback;
  }
  const n = Number(trimmed);
  const { min, max } = opts;
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    console.warn(`[config] ${name}=${n} is out of the allowed range — using default ${fallback}`);
    return fallback;
  }
  return n;
}

function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A journal root setting: a list of directories, or `fallback` when unset.
 *
 * Comma-separated, like every other list Sightr reads ({@link envList}) — deliberately NOT `PATH`'s
 * separator, which is `:` on Unix and `;` on Windows and would make the same setting mean different
 * things on the two platforms this bridge supports. One path stays one path, so an existing value
 * parses to exactly what it always meant.
 */
function envRoots(name: string, fallback: string): string[] {
  const list = envList(name);
  return list.length > 0 ? list : [fallback];
}

/**
 * Read a boolean env var. Empty/unset → `fallback`. `off`/`0`/`false`/`no` → false; `on`/`1`/`true`/
 * `yes` → true (case-insensitive); anything else falls back with a warning. Used for feature toggles
 * that default on, where a typo silently flipping the feature would be surprising.
 */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["off", "0", "false", "no"].includes(v)) return false;
  if (["on", "1", "true", "yes"].includes(v)) return true;
  console.warn(`[config] ${name}="${raw}" is not a boolean — using default ${fallback}`);
  return fallback;
}

export function readWorkRoot(env: Record<string, string | undefined> = process.env): string {
  const raw = env.SIGHTR_WORK_ROOT?.trim();
  if (!raw) return "";
  const expanded = raw.startsWith("~/") || raw.startsWith("~\\") ? join(homedir(), raw.slice(2)) : raw === "~" ? homedir() : raw;
  return resolve(expanded);
}

export interface Config {
  /** Path to Herdr's control socket. A non-Herdr-launched daemon must discover this itself. */
  socketPath: string;
  /** TCP port the bridge listens on (loopback only). `tailscale serve` proxies to it. */
  port: number;
  /**
   * Bind host. Loopback is REQUIRED, not merely the default — `loadConfig` refuses a non-loopback
   * value unless {@link allowNonLoopbackBind} is set, because binding wide makes the Tailscale
   * identity check, the device header and the same-origin gate all client-forgeable
   * (see README.md → Architecture).
   */
  host: string;
  /**
   * Escape hatch for {@link host}: permit a bind that is not loopback (`SIGHTR_ALLOW_NON_LOOPBACK_BIND=1`).
   * Without it the bridge refuses to start on a wide bind rather than warning and carrying on — a
   * warning in a log nobody reads is not a control, and the bind is what every write gate rests on
   * (issue #4). Setting it also disables the peer-address check in server.ts, because a deliberate
   * wide bind means non-loopback peers are the point; one switch, not two.
   */
  allowNonLoopbackBind: boolean;
  /** Poll cadence for the state engine, ms. Also the fast fallback cadence when the event stream is down. */
  pollMs: number;
  /**
   * Relaxed safety-net poll cadence, ms, used while the events.subscribe stream is healthy. Events
   * poke immediate re-polls, so this interval only backstops a missed poke — a miss costs at most
   * one of these, never correctness. Falls back to {@link pollMs} the moment the stream drops.
   */
  pollIdleMs: number;
  /**
   * Debounce window before a blocked/done transition becomes a push, ms. An agent that resolves
   * within this window (you handled it at your desk) never notifies; one that fires is retracted
   * when it later resolves. See NotificationCoordinator. 0 = notify on the next tick (no debounce).
   */
  notifyDelayMs: number;
  /** How many lines of scrollback to pull for the agent detail view. */
  readLines: number;
  /**
   * Serve agent conversation history from the agent's own on-disk session log. This is the only
   * way to get scrollback for most agent panes at all — they run on the terminal's alternate
   * screen, which has no scrollback ring, so Herdr retains nothing behind the viewport (see
   * journal/claude.ts). Off disables the feature and its route wholesale, for every harness.
   */
  transcript: boolean;
  /**
   * Where each harness keeps its session logs — one directory or several, searched in order. Every
   * read is confined to the root it was found under, after symlink resolution, so these double as the
   * security boundary for a feature that touches the filesystem — override only to relocate (or add)
   * a non-default agent home, never from a request.
   */
  journalRoots: JournalRoots;
  /** Key sequence sent to submit a reply after the text (agent-dependent; see HERDR_API.md). */
  submitKeys: string[];
  /**
   * Where the operator's Agent-commands rows live — `commands.toml` in the same dir as their
   * `.env`. Read at request time behind an mtime check (bridge/operator-commands.ts), so it is
   * resolved here but never read here.
   */
  commandsFile: string;
  /**
   * Where the operator's Keys-tray preset rows live — `keys.toml`, the sibling of `commands.toml`
   * in the same dir, read the same way (bridge/operator-keys.ts) and likewise never read here.
   */
  keysFile: string;
  /**
   * Tailscale identity gate. If set, requests must carry a `Tailscale-User-Login` header (injected by
   * `tailscale serve`) matching this login. A mismatching login is rejected, and so is an ABSENT one
   * — `tailscale serve` injects no identity for TAGGED nodes, so tolerating an absent header handed
   * every tagged node on the tailnet full write access (issue #2). Under SIGHTR_SKIP_SERVE=1 nothing
   * injects the header at all, so only the mismatch check applies there. Set
   * {@link trustedUserOptional} to restore the old tolerance for host-local callers.
   */
  trustedUser: string;
  /**
   * Opt out of the fail-closed half of {@link trustedUser} (SIGHTR_TRUSTED_USER_OPTIONAL=1): a
   * request with no `Tailscale-User-Login` passes again. For host-local callers that bypass
   * `tailscale serve` — `curl` on the host, `scripts/capture-fixture.sh`, the vite dev proxy. It
   * re-opens the tagged-node hole, so it is off by default and warned about at startup.
   */
  trustedUserOptional: boolean;
  /**
   * Per-device authorisation. Name of a request header carrying an opaque device identifier,
   * injected by a trusted upstream reverse proxy. Empty = the feature is off (no behaviour change).
   * When set, devices whose header value isn't in {@link deviceAllowlist} are read-only. See
   * `deviceAuth()` in server.ts for the full matrix. The header is trusted only because the bridge
   * binds loopback behind the proxy — a direct client can't set it (same trust basis as trustedUser).
   */
  deviceHeader: string;
  /**
   * Device identifiers permitted to perform sensitive actions (typing into agent terminals,
   * structural creates). Everything else carrying the header is read-only. To revoke a device,
   * drop its value from this list and restart. Ignored when {@link deviceHeader} is empty.
   */
  deviceAllowlist: string[];
  /**
   * Exact request origins allowed in addition to the request's own Host (e.g. your MagicDNS https
   * origin, or `http://localhost:5173` for the vite dev proxy). There is no implicit loopback exemption.
   */
  allowedOrigins: string[];
  /**
   * Additional allowed Host headers (`host` or `host:port` values) beyond loopback and the
   * discovered {@link tailscaleHosts}. Host validation is fail-closed by default: any request whose
   * `Host` header isn't a loopback form, one of these, a discovered Tailscale host, or a host
   * parsed from {@link allowedOrigins} is rejected before the Origin check. Required under
   * `SIGHTR_SKIP_SERVE=1` (where Sightr discovers no Tailscale hosts) to name your public domain.
   */
  publicHosts: string[];
  /**
   * Additional push-service hosts allowed for Web Push endpoints (extends {@link DEFAULT_PUSH_HOSTS}).
   * Entries are matched as an exact hostname or dot-suffix (e.g. `push.example.com` covers
   * `a.push.example.com`). Only needed when running a self-hosted push service.
   */
  pushAllowedHosts: string[];
  /**
   * Hosts this bridge is actually published on, discovered by `sightr-ctl.ps1` from
   * `tailscale status --json` (Self.DNSName + Self.TailscaleIPs) and injected as
   * SIGHTR_TAILSCALE_HOSTS. Operators don't set this — it exists so the Host allowlist can be
   * fail-closed by default without every tailnet deployment needing SIGHTR_PUBLIC_HOSTS. Matched
   * with or without a port. Empty under SIGHTR_SKIP_SERVE=1: the operator owns that ingress and
   * must pin {@link publicHosts} themselves.
   */
  tailscaleHosts: string[];
  /**
   * Escape hatch that turns Host validation OFF entirely (SIGHTR_ALLOW_ANY_HOST=1), restoring the
   * pre-0.31 behaviour where any Host passed as long as Origin matched it. That is the DNS-rebinding
   * hole (issue #3) — a hostile page rebinds to 127.0.0.1 and sends Host==Origin==evil.example.
   * Only for a deployment whose real Host genuinely can't be enumerated. Warned about at startup.
   */
  allowAnyHost: boolean;
  /** Web Push (VAPID). All three required to enable push; otherwise push is disabled. */
  vapidPublic: string;
  vapidPrivate: string;
  vapidSubject: string;
  /** Where to persist push subscriptions and other runtime state. */
  stateDir: string;
  /** Absolute opt-in root for the Files tab; empty disables it. */
  workRoot: string;
  /**
   * Whether `tailscale serve` is bypassed (SIGHTR_SKIP_SERVE=1) because an operator-run reverse
   * proxy (Caddy/Nginx) fronts the loopback bridge instead. The bridge itself handles every request
   * identically either way — this flag only informs the startup warnings: without `tailscale serve`
   * in front, the `Tailscale-User-Login` header is never injected, so {@link trustedUser} is inert
   * and per-device auth ({@link deviceHeader}) becomes the way to gate writes (README.md → Configuration, SIGHTR_SKIP_SERVE).
   */
  skipServe: boolean;
  /** Whether the write-level audit trail is on (SIGHTR_AUDIT=0 turns it off). */
  audit: boolean;
  /** How much of a value's content the trail keeps: "preview" (default) or "none". */
  auditContent: AuditContent;
  /**
   * Whether the bridge reads the identity files Claude's own hooks write (`<stateDir>/beacons`).
   *
   * On by default: an operator who has never installed the hooks has an absent directory, which
   * costs one failed `readdir` per poll and changes nothing. The switch exists so a beacon directory
   * behaving badly can be taken out of the loop without uninstalling anybody's hooks.
   */
  beacons: boolean;
}

/**
 * Whether a bind host keeps the listener on loopback. Loopback is the trust basis for every write
 * gate in the bridge — the Tailscale identity header, the device header and the same-origin check
 * are all client-settable values that only mean anything because `tailscale serve` (or a local
 * reverse proxy) is the only thing that can reach the port. Bound wide, all three are decoration.
 *
 * Accepts every spelling of loopback, not just the two the old startup warning knew about: the
 * whole 127.0.0.0/8 block, `localhost`, and IPv6 `::1` in bare, bracketed and expanded form.
 * Rejects the wildcards (`0.0.0.0`, `::`), LAN addresses, and any hostname.
 *
 * Pure + exported so the table of accepted/rejected spellings is unit-tested.
 */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost") return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * herdr's default socket location: `~/.config/herdr/herdr.sock` on Unix, `%APPDATA%\herdr\herdr.sock`
 * on Windows (the Windows beta keeps its config root under AppData\Roaming). Pure so both branches
 * are unit-testable on any platform.
 */
export function defaultSocketPath(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "herdr", "herdr.sock");
  }
  return join(home, ".config", "herdr", "herdr.sock");
}

function journalRootsFromDescriptors(): JournalRoots {
  const home = homedir();
  const roots: JournalRoots = {};
  for (const agent of AGENTS) {
    if (!("journal" in agent)) continue;
    const spec = agent.journal;
    // Each harness's own home var is honoured first; the Sightr override takes a list too.
    const homeEnv = "homeEnv" in spec ? spec.homeEnv : undefined;
    const base = homeEnv
      ? (process.env[homeEnv] ?? join(home, ...spec.homeDefault))
      : join(home, ...spec.homeDefault);
    roots[agent.id] = envRoots(spec.rootEnv, join(base, ...spec.subdir));
  }
  return roots;
}

export function loadConfig(): Config {
  // Resolved by bridge/beacon/paths.ts, which the beacon EMITTER also calls — it runs outside this
  // process and has to land in the same directory, and two copies of the rule would drift.
  const stateDir = resolveStateDir(process.env, homedir());

  const submitKeys = envList("SIGHTR_SUBMIT_KEYS");

  const host = process.env.SIGHTR_HOST ?? "127.0.0.1";
  const allowNonLoopbackBind = envBool("SIGHTR_ALLOW_NON_LOOPBACK_BIND", false);
  // Fail at boot, not with a warning. A bridge bound off-loopback has no working write gate at all
  // (issue #4), so starting it is worse than not starting it — the operator sees a stopped service
  // and a one-line reason, instead of an open one and a line in sightr-error.log.
  if (!isLoopbackBindHost(host) && !allowNonLoopbackBind) {
    throw new Error(
      `SIGHTR_HOST=${host} is not a loopback address. Sightr binds loopback only: the ` +
        `Tailscale-User-Login header, SIGHTR_DEVICE_HEADER and the same-origin gate are all ` +
        `client-settable and mean nothing on a wide bind, so binding here would hand write access ` +
        `to anything that can reach the port. Use 127.0.0.1 (the default) and put your ingress in ` +
        `front of it — see README → Variants. If you truly mean to bind wide and have another ` +
        `control in front, set SIGHTR_ALLOW_NON_LOOPBACK_BIND=1.`,
    );
  }
  // The operator's config dir — where their `.env` lives, and now their `commands.toml` beside it.
  // Resolved exactly the way scripts/sightr-ctl.ps1 resolves it MINUS the `herdr` shell-out: the
  // launcher passes HERDR_PLUGIN_CONFIG_DIR into the Task Scheduler job precisely so this
  // process never has to ask the CLI, and the two entry points must not disagree about which dir
  // that is. ~/.config/sightr is the same last-resort default the shim ends on.
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR ?? join(homedir(), ".config", "sightr");

  // SIGHTR_CLAUDE_ROOT predates the per-harness split and remains Claude's legacy override.
  const journalRoots = journalRootsFromDescriptors();

  return {
    socketPath: process.env.HERDR_SOCKET_PATH ?? defaultSocketPath(),
    port: envInt("SIGHTR_PORT", 8787, { min: 1, max: 65535 }),
    host,
    allowNonLoopbackBind,
    pollMs: envInt("SIGHTR_POLL_MS", 1500, { min: 250 }),
    pollIdleMs: envInt("SIGHTR_POLL_IDLE_MS", 12_000, { min: 1000 }),
    notifyDelayMs: envInt("SIGHTR_NOTIFY_DELAY_MS", 30_000, { min: 0 }),
    readLines: envInt("SIGHTR_READ_LINES", 200, { min: 1 }),
    transcript: envBool("SIGHTR_TRANSCRIPT", true),
    journalRoots,
    submitKeys: submitKeys.length ? submitKeys : ["Enter"],
    commandsFile: join(configDir, "commands.toml"),
    keysFile: join(configDir, "keys.toml"),
    trustedUser: process.env.SIGHTR_TRUSTED_USER ?? "",
    trustedUserOptional: envBool("SIGHTR_TRUSTED_USER_OPTIONAL", false),
    deviceHeader: (process.env.SIGHTR_DEVICE_HEADER ?? "").trim(),
    deviceAllowlist: envList("SIGHTR_DEVICE_ALLOWLIST"),
    allowedOrigins: envList("SIGHTR_ALLOWED_ORIGINS"),
    publicHosts: envList("SIGHTR_PUBLIC_HOSTS"),
    pushAllowedHosts: envList("SIGHTR_PUSH_ALLOWED_HOSTS"),
    tailscaleHosts: envList("SIGHTR_TAILSCALE_HOSTS"),
    allowAnyHost: envBool("SIGHTR_ALLOW_ANY_HOST", false),
    vapidPublic: process.env.SIGHTR_VAPID_PUBLIC ?? "",
    vapidPrivate: process.env.SIGHTR_VAPID_PRIVATE ?? "",
    vapidSubject: process.env.SIGHTR_VAPID_SUBJECT ?? "mailto:admin@example.com",
    stateDir,
    workRoot: readWorkRoot(),
    skipServe: envBool("SIGHTR_SKIP_SERVE", false),
    audit: envBool("SIGHTR_AUDIT", true),
    auditContent: parseAuditContent(process.env.SIGHTR_AUDIT_CONTENT),
    beacons: envBool("SIGHTR_BEACONS", true),
  };
}
