import { describe, expect, test } from "bun:test";

import type { Config } from "./config.ts";
import { createLocalServersRoute, parseDnsName, parseListeners, type ShellRun } from "./local-servers.ts";

const cfg = { allowAnyHost: true, allowedOrigins: [], publicHosts: [], tailscaleHosts: [] } as unknown as Config;

const row = (LocalAddress: string, LocalPort: number) => ({ LocalAddress, LocalPort });

const CANNED = JSON.stringify([
  row("127.0.0.1", 8787),
  row("0.0.0.0", 3000),
  row("::", 4000),
  row("::1", 3080),
  row("192.168.1.5", 8080),
  row("127.0.0.1", 443),
  row("::1", 443),
  row("127.0.0.1", 9222),
  row("::1", 9222),
  row("127.0.0.1", 5555),
  row("127.0.0.1", 4877),
]);

describe("parseListeners", () => {
  test("keeps loopback listeners, drops wildcard binds and 443, dedupes, sorts, and names known ports", () => {
    expect(parseListeners(CANNED)).toEqual([
      { port: 3080, name: "local models" },
      { port: 4877, name: "node" },
      { port: 5555, name: "" },
      { port: 8787, name: "sightr" },
      { port: 9222, name: "chrome devtools" },
    ]);
  });

  test("accepts a single object, the shape ConvertTo-Json emits for one row", () => {
    expect(parseListeners(JSON.stringify(row("::1", 9333)))).toEqual([{ port: 9333, name: "chrome" }]);
  });

  test("an empty answer is an empty list; garbage is a failure", () => {
    expect(parseListeners("")).toEqual([]);
    expect(parseListeners("   ")).toEqual([]);
    expect(parseListeners("not json")).toBeNull();
  });

  test("names the rest of the fixed map", () => {
    const stdout = JSON.stringify([row("127.0.0.1", 18787), row("::1", 32400)]);
    expect(parseListeners(stdout)).toEqual([
      { port: 18787, name: "thickapi" },
      { port: 32400, name: "plex" },
    ]);
  });
});

describe("parseDnsName", () => {
  test("strips the trailing dot", () => {
    expect(parseDnsName(JSON.stringify({ Self: { DNSName: "bart.tailab17af.ts.net." } }))).toBe("bart.tailab17af.ts.net");
  });

  test("is empty when Tailscale has no name or the body isn't JSON", () => {
    expect(parseDnsName(JSON.stringify({ Self: {} }))).toBe("");
    expect(parseDnsName("{")).toBe("");
  });
});

function harness(script: ShellRun, now: () => number = () => 1_000_000) {
  const calls: string[][] = [];
  const run: ShellRun = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    return script(cmd, args, opts);
  };
  return { run, calls, route: createLocalServersRoute({ run, now }) };
}

const get = () => new Request("http://localhost/api/local-servers", { headers: { host: "localhost" } });

describe("GET /api/local-servers", () => {
  test("returns the name and the parsed list", async () => {
    const { route, calls } = harness(async (cmd) => {
      if (cmd === "tailscale") return { code: 0, stdout: JSON.stringify({ Self: { DNSName: "bart.tailab17af.ts.net." } }), stderr: "" };
      return { code: 0, stdout: CANNED, stderr: "" };
    });
    const res = await route(get(), cfg);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      host: "bart.tailab17af.ts.net",
      servers: [
        { port: 3080, name: "local models" },
        { port: 4877, name: "node" },
        { port: 5555, name: "" },
        { port: 8787, name: "sightr" },
        { port: 9222, name: "chrome devtools" },
      ],
    });
    expect(calls[1]).toEqual(["powershell.exe", "-NoProfile", "-Command", expect.stringContaining("Get-NetTCPConnection -State Listen")]);
  });

  test("a failed shell-out returns the previous list", async () => {
    let fail = false;
    const { route } = harness(async (cmd) => {
      if (cmd === "tailscale") return { code: 0, stdout: JSON.stringify({ Self: { DNSName: "host.example." } }), stderr: "" };
      if (fail) return { code: 1, stdout: "", stderr: "Get-NetTCPConnection : failed" };
      return { code: 0, stdout: JSON.stringify([row("127.0.0.1", 3080)]), stderr: "" };
    });
    expect(await (await route(get(), cfg)).json()).toEqual({ host: "host.example", servers: [{ port: 3080, name: "local models" }] });
    fail = true;
    expect(await (await route(get(), cfg)).json()).toEqual({ host: "host.example", servers: [{ port: 3080, name: "local models" }] });
  });

  test("garbage from the shell-out also keeps the previous list", async () => {
    let garbage = false;
    const { route } = harness(async (cmd) => {
      if (cmd === "tailscale") return { code: 0, stdout: JSON.stringify({ Self: { DNSName: "host.example." } }), stderr: "" };
      return { code: 0, stdout: garbage ? "not json" : JSON.stringify([row("::1", 9333)]), stderr: "" };
    });
    await route(get(), cfg);
    garbage = true;
    expect(await (await route(get(), cfg)).json()).toEqual({ host: "host.example", servers: [{ port: 9333, name: "chrome" }] });
  });

  test("an unreachable Tailscale returns an empty 200, not an error", async () => {
    const { route } = harness(async (cmd) => {
      if (cmd === "tailscale") return { code: 1, stdout: "", stderr: "not running" };
      return { code: 0, stdout: JSON.stringify([row("127.0.0.1", 3080)]), stderr: "" };
    });
    const res = await route(get(), cfg);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ host: "", servers: [] });
  });

  test("refreshes the Tailscale name at most once a minute", async () => {
    let at = 1_000_000;
    let reads = 0;
    const { route, calls } = harness(async (cmd) => {
      if (cmd === "tailscale") { reads += 1; return { code: 0, stdout: JSON.stringify({ Self: { DNSName: "host.example." } }), stderr: "" }; }
      return { code: 0, stdout: "[]", stderr: "" };
    }, () => at);
    await route(get(), cfg);
    await route(get(), cfg);
    expect(reads).toBe(1);
    at += 60_000;
    await route(get(), cfg);
    expect(reads).toBe(2);
    expect(calls.filter((c) => c[0] === "tailscale")).toHaveLength(2);
  });

  test("refuses a non-GET", async () => {
    const { route } = harness(async () => ({ code: 0, stdout: "", stderr: "" }));
    const res = await route(new Request("http://localhost/api/local-servers", { method: "POST", headers: { host: "localhost" } }), cfg);
    expect(res.status).toBe(405);
  });
});
