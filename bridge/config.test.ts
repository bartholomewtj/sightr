import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defaultSocketPath, isLoopbackBindHost, loadConfig } from "./config.ts";

// loadConfig is the deployment contract — env vars in, a resolved Config out. Pure (just reads
// process.env + homedir), so we drive it by mutating the environment and restoring it after.

const KEYS = [
  "SIGHTR_PORT",
  "SIGHTR_HOST",
  "SIGHTR_ALLOW_NON_LOOPBACK_BIND",
  "SIGHTR_POLL_MS",
  "SIGHTR_POLL_IDLE_MS",
  "SIGHTR_NOTIFY_DELAY_MS",
  "SIGHTR_READ_LINES",
  "SIGHTR_TRANSCRIPT",
  "SIGHTR_CLAUDE_ROOT",
  "SIGHTR_PI_ROOT",
  "SIGHTR_GROK_ROOT",
  "SIGHTR_CURSOR_ROOT",
  // Each harness's own home var participates in journal-root resolution, so the suite must own them
  // too — otherwise a developer with GROK_HOME set gets different results than CI.
  "PI_CODING_AGENT_DIR",
  "GROK_HOME",
  "SIGHTR_SUBMIT_KEYS",
  "SIGHTR_WORK_ROOT",
  "SIGHTR_TRUSTED_USER",
  "SIGHTR_TRUSTED_USER_OPTIONAL",
  "SIGHTR_DEVICE_HEADER",
  "SIGHTR_DEVICE_ALLOWLIST",
  "SIGHTR_ALLOWED_ORIGINS",
  "SIGHTR_PUBLIC_HOSTS",
  "SIGHTR_TAILSCALE_HOSTS",
  "SIGHTR_ALLOW_ANY_HOST",
  "SIGHTR_VAPID_PUBLIC",
  "SIGHTR_VAPID_PRIVATE",
  "SIGHTR_VAPID_SUBJECT",
  "SIGHTR_STATE_DIR",
  "SIGHTR_SKIP_SERVE",
  "SIGHTR_AUDIT",
  "SIGHTR_AUDIT_CONTENT",
  "HERDR_SOCKET_PATH",
  "HERDR_PLUGIN_STATE_DIR",
  "HERDR_PLUGIN_CONFIG_DIR",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("loadConfig", () => {
  test("uses safe single-user defaults", () => {
    const cfg = loadConfig();
    expect(cfg.port).toBe(8787);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.allowNonLoopbackBind).toBe(false);
    expect(cfg.pollMs).toBe(1500);
    expect(cfg.pollIdleMs).toBe(12_000);
    expect(cfg.readLines).toBe(200);
    // Transcript history defaults ON — it's the only scrollback a Claude pane can ever have.
    expect(cfg.transcript).toBe(true);
    // One root by default, and it is a list of one rather than a special case (collie#92).
    expect(cfg.journalRoots.claude).toHaveLength(1);
    expect(cfg.journalRoots.claude![0]).toEndWith(join(".claude", "projects"));
    expect(cfg.journalRoots.grok).toEqual([join(homedir(), ".grok", "sessions")]);
    expect(cfg.journalRoots.cursor).toEqual([join(homedir(), ".cursor", "projects")]);
    expect(Object.keys(cfg.journalRoots).sort()).toEqual(["claude", "cursor", "grok", "pi"]);
    expect(cfg.journalRoots.agy).toBeUndefined();
    expect(cfg.submitKeys).toEqual(["Enter"]);
    expect(cfg.trustedUser).toBe("");
    expect(cfg.trustedUserOptional).toBe(false);
    expect(cfg.allowedOrigins).toEqual([]);
    expect(cfg.notifyDelayMs).toBe(30_000);
    // Host-header validation is opt-in (empty = off, legacy behaviour).
    expect(cfg.publicHosts).toEqual([]);
    // Per-device auth is off by default (empty header = feature disabled).
    expect(cfg.deviceHeader).toBe("");
    expect(cfg.deviceAllowlist).toEqual([]);
    // tailscale serve is used by default (reverse-proxy bypass is opt-in).
    expect(cfg.skipServe).toBe(false);
  });

  test("parses SIGHTR_SKIP_SERVE as a boolean toggle (default off)", () => {
    // Truthy spellings turn it on (reverse-proxy mode; bypass tailscale serve).
    for (const on of ["on", "1", "true", "yes", "ON", " True "]) {
      process.env.SIGHTR_SKIP_SERVE = on;
      expect(loadConfig().skipServe).toBe(true);
    }
    // Falsey spellings keep it off (the default tailscale serve path).
    for (const off of ["off", "0", "false", "no", "OFF", " False "]) {
      process.env.SIGHTR_SKIP_SERVE = off;
      expect(loadConfig().skipServe).toBe(false);
    }
    // Garbage and empty fall back to the default (off).
    process.env.SIGHTR_SKIP_SERVE = "banana";
    expect(loadConfig().skipServe).toBe(false);
    process.env.SIGHTR_SKIP_SERVE = "";
    expect(loadConfig().skipServe).toBe(false);
  });

  test("parses SIGHTR_TRUSTED_USER_OPTIONAL as a boolean toggle (default off)", () => {
    // Truthy spellings turn it on (restore tolerant identity checking).
    for (const on of ["on", "1", "true", "yes", "ON", " True "]) {
      process.env.SIGHTR_TRUSTED_USER_OPTIONAL = on;
      expect(loadConfig().trustedUserOptional).toBe(true);
    }
    // Falsey spellings keep it off (the default fail-closed path).
    for (const off of ["off", "0", "false", "no", "OFF", " False "]) {
      process.env.SIGHTR_TRUSTED_USER_OPTIONAL = off;
      expect(loadConfig().trustedUserOptional).toBe(false);
    }
    // Garbage and empty fall back to the default (off).
    process.env.SIGHTR_TRUSTED_USER_OPTIONAL = "banana";
    expect(loadConfig().trustedUserOptional).toBe(false);
    process.env.SIGHTR_TRUSTED_USER_OPTIONAL = "";
    expect(loadConfig().trustedUserOptional).toBe(false);
  });

  test("parses SIGHTR_TRANSCRIPT as a boolean toggle (default ON)", () => {
    for (const off of ["off", "0", "false", "no", "OFF"]) {
      process.env.SIGHTR_TRANSCRIPT = off;
      expect(loadConfig().transcript).toBe(false);
    }
    for (const on of ["on", "1", "true", "yes"]) {
      process.env.SIGHTR_TRANSCRIPT = on;
      expect(loadConfig().transcript).toBe(true);
    }
    // Garbage falls back to the default — a typo must not silently remove the only scrollback a
    // Claude pane has.
    process.env.SIGHTR_TRANSCRIPT = "banana";
    expect(loadConfig().transcript).toBe(true);
  });

  // SIGHTR_CLAUDE_ROOT predates the per-harness split and meant Claude's root — it keeps meaning
  // exactly that, so an existing deployment's env survives the change untouched.
  test("SIGHTR_CLAUDE_ROOT relocates the CLAUDE journal root", () => {
    process.env.SIGHTR_CLAUDE_ROOT = "/srv/claude/projects";
    expect(loadConfig().journalRoots.claude).toEqual(["/srv/claude/projects"]);
  });

  // The multi-profile case from collie#92: CLAUDE_CONFIG_DIR gives each Claude profile its own
  // projects tree, so one root can only ever serve half the herd's history.
  test("SIGHTR_CLAUDE_ROOT takes several roots, comma-separated and in order", () => {
    process.env.SIGHTR_CLAUDE_ROOT = "/srv/work/projects,/srv/personal/projects";
    expect(loadConfig().journalRoots.claude).toEqual([
      "/srv/work/projects",
      "/srv/personal/projects",
    ]);
  });

  test("whitespace and empty entries around the separators are dropped", () => {
    process.env.SIGHTR_CLAUDE_ROOT = " /a/projects , , /b/projects ,";
    expect(loadConfig().journalRoots.claude).toEqual(["/a/projects", "/b/projects"]);
  });

  // An empty value used to become a root of `""` — which resolves against the bridge's cwd, not a
  // journal. Falling back to the default is both safer and what the operator meant.
  test("an empty value falls back to the default root", () => {
    process.env.SIGHTR_CLAUDE_ROOT = "   ";
    expect(loadConfig().journalRoots.claude).toEqual([join(homedir(), ".claude", "projects")]);
  });

  test("every harness root takes a list, not just Claude's", () => {
    process.env.SIGHTR_PI_ROOT = "/c/sessions,/d/sessions";
    process.env.SIGHTR_GROK_ROOT = "/g/sessions,/h/sessions";
    process.env.SIGHTR_CURSOR_ROOT = "/cur/a,/cur/b";
    const cfg = loadConfig();
    expect(cfg.journalRoots.pi).toEqual(["/c/sessions", "/d/sessions"]);
    expect(cfg.journalRoots.grok).toEqual(["/g/sessions", "/h/sessions"]);
    expect(cfg.journalRoots.cursor).toEqual(["/cur/a", "/cur/b"]);
  });

  test("each harness's own home var relocates its journal root", () => {
    process.env.PI_CODING_AGENT_DIR = "/srv/pi";
    process.env.GROK_HOME = "/srv/grok";
    const cfg = loadConfig();
    expect(cfg.journalRoots.pi).toEqual([join("/srv/pi", "sessions")]);
    expect(cfg.journalRoots.grok).toEqual([join("/srv/grok", "sessions")]);
  });

  test("an explicit SIGHTR_* root beats the harness's home var", () => {
    process.env.GROK_HOME = "/srv/grok";
    process.env.SIGHTR_GROK_ROOT = "/elsewhere/rollouts";
    expect(loadConfig().journalRoots.grok).toEqual(["/elsewhere/rollouts"]);
  });

  // The operator's rows sit beside their .env, and the launcher hands us that dir precisely so the
  // bridge and scripts/sightr-ctl.ps1 never disagree about which one it is.
  test("commands.toml is resolved in the plugin config dir the launcher passed", () => {
    process.env.HERDR_PLUGIN_CONFIG_DIR = "/srv/herdr/plugins/sightr";
    expect(loadConfig().commandsFile).toBe(join("/srv/herdr/plugins/sightr", "commands.toml"));
    expect(loadConfig().keysFile).toBe(join("/srv/herdr/plugins/sightr", "keys.toml"));
    delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    expect(loadConfig().commandsFile).toBe(join(homedir(), ".config", "sightr", "commands.toml"));
    expect(loadConfig().keysFile).toBe(join(homedir(), ".config", "sightr", "keys.toml"));
  });

  test("reads the per-device auth header and allowlist", () => {
    process.env.SIGHTR_DEVICE_HEADER = "  X-Device-Id  ";
    process.env.SIGHTR_DEVICE_ALLOWLIST = " phone , laptop ,";
    const cfg = loadConfig();
    expect(cfg.deviceHeader).toBe("X-Device-Id");
    expect(cfg.deviceAllowlist).toEqual(["phone", "laptop"]);
  });

  test("parses integer env vars and falls back to the default on garbage", () => {
    process.env.SIGHTR_PORT = "9999";
    expect(loadConfig().port).toBe(9999);
    process.env.SIGHTR_PORT = "not-a-number";
    expect(loadConfig().port).toBe(8787);
  });

  test("rejects trailing-garbage integers (parseInt would have accepted '8080abc')", () => {
    process.env.SIGHTR_PORT = "8080abc";
    expect(loadConfig().port).toBe(8787);
    // Surrounding whitespace is still fine.
    process.env.SIGHTR_READ_LINES = "  120  ";
    expect(loadConfig().readLines).toBe(120);
  });

  test("clamps out-of-range integers back to the default", () => {
    process.env.SIGHTR_PORT = "0";
    expect(loadConfig().port).toBe(8787);
    process.env.SIGHTR_PORT = "70000";
    expect(loadConfig().port).toBe(8787);
    process.env.SIGHTR_POLL_MS = "100"; // below the 250 floor
    expect(loadConfig().pollMs).toBe(1500);
    process.env.SIGHTR_POLL_IDLE_MS = "500"; // below the 1000 floor
    expect(loadConfig().pollIdleMs).toBe(12_000);
    process.env.SIGHTR_NOTIFY_DELAY_MS = "-5"; // below the 0 floor
    expect(loadConfig().notifyDelayMs).toBe(30_000);
  });

  test("accepts an in-range integer and a zero notify delay", () => {
    process.env.SIGHTR_POLL_MS = "250";
    expect(loadConfig().pollMs).toBe(250);
    process.env.SIGHTR_POLL_IDLE_MS = "30000";
    expect(loadConfig().pollIdleMs).toBe(30_000);
    process.env.SIGHTR_NOTIFY_DELAY_MS = "0";
    expect(loadConfig().notifyDelayMs).toBe(0);
  });

  test("reads the public-hosts allowlist, trimming and dropping blanks", () => {
    process.env.SIGHTR_PUBLIC_HOSTS = " sightr.example.ts.net , sightr.example.com:8443 ,";
    expect(loadConfig().publicHosts).toEqual([
      "sightr.example.ts.net",
      "sightr.example.com:8443",
    ]);
  });

  test("reads the tailscale-hosts allowlist and allowAnyHost flag", () => {
    expect(loadConfig().allowAnyHost).toBe(false);
    process.env.SIGHTR_ALLOW_ANY_HOST = "1";
    expect(loadConfig().allowAnyHost).toBe(true);

    process.env.SIGHTR_TAILSCALE_HOSTS = " host.example.ts.net , 100.64.0.1 , [fd7a::1] ,";
    expect(loadConfig().tailscaleHosts).toEqual([
      "host.example.ts.net",
      "100.64.0.1",
      "[fd7a::1]",
    ]);
  });

  test("splits comma lists, trimming whitespace and dropping blanks", () => {
    process.env.SIGHTR_SUBMIT_KEYS = " ctrl+a , Enter ,";
    expect(loadConfig().submitKeys).toEqual(["ctrl+a", "Enter"]);
    process.env.SIGHTR_ALLOWED_ORIGINS = "https://a.example.com, https://b.example.com";
    expect(loadConfig().allowedOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  test("falls back to [Enter] when SIGHTR_SUBMIT_KEYS is empty", () => {
    process.env.SIGHTR_SUBMIT_KEYS = "";
    expect(loadConfig().submitKeys).toEqual(["Enter"]);
  });

  test("refuses a non-loopback SIGHTR_HOST", () => {
    process.env.SIGHTR_HOST = "0.0.0.0";
    expect(() => loadConfig()).toThrow(/not a loopback address/);
  });

  test("a non-loopback bind needs the explicit override", () => {
    process.env.SIGHTR_HOST = "0.0.0.0";
    process.env.SIGHTR_ALLOW_NON_LOOPBACK_BIND = "1";
    process.env.SIGHTR_TRUSTED_USER = "me@example.com";
    const cfg = loadConfig();
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.allowNonLoopbackBind).toBe(true);
    expect(cfg.trustedUser).toBe("me@example.com");
  });
});

describe("isLoopbackBindHost", () => {
  test("accepts loopback host spellings", () => {
    for (const host of [
      "127.0.0.1",
      "127.0.0.2",
      "127.1.2.3",
      "localhost",
      "LOCALHOST",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
    ]) {
      expect(isLoopbackBindHost(host)).toBe(true);
    }
  });

  test("rejects non-loopback bind hosts", () => {
    for (const host of [
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "10.0.0.1",
      "sightr.example.ts.net",
      "",
    ]) {
      expect(isLoopbackBindHost(host)).toBe(false);
    }
  });
});

// Pure — both platform branches are testable from any host (expectations use join() so the
// host's separator never leaks into the assertion).
describe("defaultSocketPath", () => {
  test("unix default lives under ~/.config/herdr", () => {
    expect(defaultSocketPath("linux", {}, "/home/u")).toBe(join("/home/u", ".config", "herdr", "herdr.sock"));
    expect(defaultSocketPath("darwin", {}, "/Users/u")).toBe(join("/Users/u", ".config", "herdr", "herdr.sock"));
  });

  test("win32 default honours APPDATA", () => {
    expect(defaultSocketPath("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u")).toBe(
      join("C:\\Users\\u\\AppData\\Roaming", "herdr", "herdr.sock"),
    );
  });

  test("win32 falls back to <home>/AppData/Roaming when APPDATA is unset", () => {
    expect(defaultSocketPath("win32", {}, "C:\\Users\\u")).toBe(
      join("C:\\Users\\u", "AppData", "Roaming", "herdr", "herdr.sock"),
    );
  });
});

// A new config.ts environment read without an .env.example entry is a setting nobody can discover.
describe("configuration documentation", () => {
  test("documents every environment variable read by config.ts", () => {
    const source = readFileSync(join(import.meta.dir, "config.ts"), "utf8");
    const descriptor = readFileSync(join(import.meta.dir, "..", "shared", "agents.ts"), "utf8");
    const example = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
    const read = new Set<string>();
    const patterns = [
      /process\.env\.([A-Z][A-Z0-9_]*)/g,
      /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
      /\benv(?:Int|Bool|List|Enum|Roots)\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
      /\benv\.([A-Z][A-Z0-9_]*)/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const name = match[1];
        if (name && /^(SIGHTR|HERDR)_/.test(name)) read.add(name);
      }
    }
    for (const match of descriptor.matchAll(/rootEnv:\s*"([A-Z][A-Z0-9_]*)"/g)) {
      const name = match[1];
      if (name) read.add(name);
    }
    const documented = new Set<string>();
    for (const match of example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)\s*=/gm)) {
      const name = match[1];
      if (name) documented.add(name);
    }
    const missing = [...read].filter((name) => !documented.has(name)).sort();
    expect(read.size).toBeGreaterThan(25);
    expect(read.has("SIGHTR_PORT")).toBe(true);
    expect(read.has("HERDR_SOCKET_PATH")).toBe(true);
    expect(read.has("SIGHTR_CLAUDE_ROOT")).toBe(true);
    expect(read.has("SIGHTR_PI_ROOT")).toBe(true);
    expect(read.has("SIGHTR_GROK_ROOT")).toBe(true);
    expect(read.has("SIGHTR_CURSOR_ROOT")).toBe(true);
    expect(missing).toEqual([]);
  });
});
